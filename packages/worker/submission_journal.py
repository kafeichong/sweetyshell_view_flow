"""Provider 提交的持久化应急证据。

Worker 一旦把任务提交给 Provider 就产生费用，而 HTTP 响应可能在返回途中
丢失。这个文件记录"我们确实告诉过 Provider 什么"，用于：

- 拿到 Provider ID 后先落盘、再回写 DB，保证 DB 回写失败时仍有线索；
- 进程崩溃后重启，凭磁盘记录发现"已提交但未确认落库"的任务，继续保持
  暂停并等待人工核对，而不是凭 prompt/时间相近去猜 Provider 上的任务。

安全约束：只保存定位 Provider 任务所需的标识与生命周期阶段。prompt、
完整响应、token、签名 URL 一律不写入，避免这个文件变成第二个密钥存储。
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

JOURNAL_FILE_NAME = "submissions.jsonl"
BLOCK_MARKER_NAME = "SUBMISSIONS_BLOCKED"
BLOCKED_REASON = "manual_review_required"

# 提交生命周期阶段：provider_accepted 表示"已告诉 Provider"，db_confirmed
# 表示"这段事实已成功回写 DB"。两者之间的窗口就是需要重启后核对的部分。
STAGE_PROVIDER_ACCEPTED = "provider_accepted"
STAGE_DB_CONFIRMED = "db_confirmed"

# 白名单而非黑名单：只有这些键会落盘。调用方多传的字段（哪怕是 prompt、
# 完整响应或 URL）会被丢弃，安全属性由结构保证，而不靠调用方自觉。
PERSISTED_KEYS = ("at", "stage", "taskId", "attemptId", "providerTaskId", "reason")


class SubmissionJournal:
    """按目录封装的提交日志与阻断标记。

    ``directory`` 应指向服务器上受限且持久的目录（``VIDEO_FLOW_AUDIT_DIR``）；
    ``append`` 同步写入并 flush/fsync，保证进程被强杀后记录仍在。
    """

    def __init__(self, directory: Path | str):
        self.directory = Path(directory)

    @property
    def journal_path(self) -> Path:
        return self.directory / JOURNAL_FILE_NAME

    @property
    def block_marker(self) -> Path:
        return self.directory / BLOCK_MARKER_NAME

    def ensure_directory(self) -> None:
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)

    def append(self, event: Dict[str, Any]) -> None:
        """同步追加一条记录；写入失败向上抛出，由调用方决定是否暂停。

        不能吞掉这里的异常：journal 写不进去意味着"提交已发生但没有证据"，
        调用方必须据此停止新的提交。
        """
        self.ensure_directory()
        record: Dict[str, Any] = {
            "at": event.get("at") or datetime.now(timezone.utc).isoformat(),
        }
        for key in PERSISTED_KEYS:
            if key != "at" and key in event:
                record[key] = event[key]

        with self.journal_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, separators=(",", ":")) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        self.journal_path.chmod(0o600)

    def entries(self) -> List[Dict[str, Any]]:
        """读取全部记录（人工核对用）。坏行跳过，避免一行损坏挡住应急核对。"""
        if not self.journal_path.exists():
            return []

        records: List[Dict[str, Any]] = []
        for line in self.journal_path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if not stripped:
                continue
            try:
                record = json.loads(stripped)
            except ValueError:
                continue
            if isinstance(record, dict):
                records.append(record)
        return records

    def unresolved_submissions(self) -> List[Dict[str, Any]]:
        """已提交 Provider 但从未确认落库的提交意图。

        Worker 在写 journal 之后、回写 DB 之前崩溃时，磁盘上只留下
        provider_accepted 记录；重启后必须据此保持暂停并等待人工核对，
        禁止凭 prompt 或时间相近推断 Provider 上的哪个任务属于它。
        """
        records = self.entries()
        confirmed = {
            (record.get("attemptId"), record.get("providerTaskId"))
            for record in records
            if record.get("stage") == STAGE_DB_CONFIRMED
        }

        unresolved: List[Dict[str, Any]] = []
        seen = set()
        for record in records:
            if record.get("stage") != STAGE_PROVIDER_ACCEPTED:
                continue
            identity = (
                record.get("taskId"),
                record.get("attemptId"),
                record.get("providerTaskId"),
            )
            if (record.get("attemptId"), record.get("providerTaskId")) in confirmed:
                continue
            if identity in seen:
                continue
            seen.add(identity)
            unresolved.append(record)
        return unresolved

    def mark_blocked(self, reason: str = BLOCKED_REASON) -> None:
        """落盘阻断标记：新的 Provider 提交必须停止，直到人工核对。"""
        self.ensure_directory()
        self.block_marker.write_text(f"{reason}\n", encoding="utf-8")
        self.block_marker.chmod(0o600)

    def is_blocked(self) -> bool:
        return self.block_marker.exists()

    def clear_block(self) -> None:
        """解除阻断。只允许人工核对完成后显式调用，Worker 不自动解封。"""
        try:
            self.block_marker.unlink()
        except FileNotFoundError:
            pass


def resolve_journal_directory(
    audit_dir: Optional[str],
    fallback: Path,
) -> Path:
    """决定 journal/阻断标记落盘的目录。

    配置了 ``VIDEO_FLOW_AUDIT_DIR`` 就用它（生产要求持久受限目录）；
    否则退回 output_dir 下的默认位置，兼容本地运行与既有测试。
    """
    configured = (audit_dir or "").strip()
    return Path(configured) if configured else fallback
