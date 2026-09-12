"""持久、脱敏的结构化事件日志。

排障需要的是"哪个任务在哪一步失败、Provider 怎么回应的"，而不是把整条 URL、
整段 Prompt 或 Authorization 抄进日志。所以脱敏在这里、在写盘之前完成：不能
指望下游的日志采集器替我们兜底——容器日志、采集管道、告警邮件都可能是泄漏面。

事件字段统一为 at / level / event / taskId / attemptId / providerTaskId /
stage / code / requestId，便于按 taskId 串起一次执行的全过程。
"""

from __future__ import annotations

import json
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional
from urllib.parse import urlsplit, urlunsplit

REDACTED = "[redacted]"
EVIDENCE_MISSING = "evidence_missing"

# 键名按词切分后匹配这些词：能命中 Authorization / X-Worker-Token /
# access_token 这类写法，又不会把 idempotencyKey 这类无害字段误伤。
SENSITIVE_WORDS = frozenset(
    {
        "token",
        "authorization",
        "auth",
        "prompt",
        "password",
        "passwd",
        "secret",
        "credential",
        "credentials",
        "signature",
        "apikey",
    }
)

# 统一事件字段。其余字段允许出现，但必须经得起脱敏。
EVENT_FIELDS = (
    "at",
    "level",
    "event",
    "taskId",
    "attemptId",
    "providerTaskId",
    "stage",
    "code",
    "requestId",
)

EVENTS_FILE_PREFIX = "events-"
JOURNAL_FILE_NAME = "submissions.jsonl"
BLOCK_MARKER_NAME = "SUBMISSIONS_BLOCKED"

_WORD_SPLIT = re.compile(r"[^a-zA-Z0-9]+|(?<=[a-z0-9])(?=[A-Z])")


def _key_words(key: str) -> List[str]:
    return [word.lower() for word in _WORD_SPLIT.split(key) if word]


def is_sensitive_key(key: str) -> bool:
    words = _key_words(key)
    if any(word in SENSITIVE_WORDS for word in words):
        return True
    # 驼峰切开后仍可能连写（apiKey -> ["api", "key"]），再看一次合并写法。
    return key.replace("_", "").replace("-", "").lower() in {"apikey", "accesstoken"}


_URL_PATTERN = re.compile(r"https?://[^\s\"']+")


def _strip_one_url(match: "re.Match[str]") -> str:
    raw = match.group(0)
    try:
        parts = urlsplit(raw)
    except ValueError:
        return REDACTED

    if not parts.netloc:
        return raw

    netloc = parts.netloc
    if "@" in netloc:
        # userinfo 里也可能是凭证，只留主机名。
        netloc = netloc.rsplit("@", 1)[1]

    return urlunsplit((parts.scheme, netloc, parts.path, "", ""))


def strip_url_secrets(value: str) -> str:
    """URL 只保留 scheme/host/path：query 与 fragment 常带签名与 token。

    错误消息里常常是「一句话 + 一条 URL」，所以按子串逐个处理，
    而不是只处理整串就是 URL 的情况。
    """
    if "://" not in value:
        return value

    return _URL_PATTERN.sub(_strip_one_url, value)


def sanitize_event(event: Any) -> Any:
    """递归脱敏：敏感键整字段替换，URL 去 query，其余原样保留。"""
    if isinstance(event, dict):
        sanitized: Dict[str, Any] = {}
        for key, value in event.items():
            if is_sensitive_key(str(key)):
                sanitized[key] = REDACTED
            else:
                sanitized[key] = sanitize_event(value)
        return sanitized

    if isinstance(event, (list, tuple)):
        return [sanitize_event(item) for item in event]

    if isinstance(event, str):
        return strip_url_secrets(event)

    return event


class AuditLog:
    """按天落盘的 JSONL 事件日志，带保留期轮换。

    轮换只删自己的 events-*.jsonl：submission journal 与阻断标记是未结案任务的
    应急证据，不能跟着普通日志一起过期。
    """

    def __init__(
        self,
        directory: Path | str,
        *,
        component: str = "worker",
        retention_days: int = 30,
        echo: bool = True,
    ):
        self.directory = Path(directory)
        self.component = component
        self.retention_days = max(1, int(retention_days))
        self.echo = echo

    def ensure_directory(self) -> None:
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)

    def path_for(self, moment: Optional[datetime] = None) -> Path:
        stamp = (moment or datetime.now(timezone.utc)).strftime("%Y-%m-%d")
        return self.directory / f"{EVENTS_FILE_PREFIX}{stamp}.jsonl"

    def emit(self, event: str, *, level: str = "info", **fields: Any) -> Dict[str, Any]:
        """写入一条事件并返回实际落盘的记录（已脱敏）。"""
        record: Dict[str, Any] = {
            "at": datetime.now(timezone.utc).isoformat(),
            "level": level,
            "event": event,
            "component": self.component,
        }
        for key, value in fields.items():
            if value is not None:
                record[key] = value

        sanitized = sanitize_event(record)
        self.ensure_directory()
        path = self.path_for()
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(sanitized, ensure_ascii=False, separators=(",", ":")) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        path.chmod(0o600)

        if self.echo:
            # 标准输出同样要脱敏：它最终会进容器日志。
            print(f"[video-flow] {json.dumps(sanitized, ensure_ascii=False)}")

        return sanitized

    def read(self, *, task_id: Optional[str] = None, limit: Optional[int] = None) -> List[Dict[str, Any]]:
        records: List[Dict[str, Any]] = []
        for path in self.event_files():
            for line in path.read_text(encoding="utf-8").splitlines():
                stripped = line.strip()
                if not stripped:
                    continue
                try:
                    record = json.loads(stripped)
                except ValueError:
                    continue
                if not isinstance(record, dict):
                    continue
                if task_id and record.get("taskId") != task_id:
                    continue
                records.append(record)

        if limit is not None and limit >= 0:
            return records[-limit:]
        return records

    def event_files(self) -> List[Path]:
        if not self.directory.exists():
            return []
        return sorted(self.directory.glob(f"{EVENTS_FILE_PREFIX}*.jsonl"))

    def evidence_status(self, task_id: Optional[str] = None) -> Dict[str, Any]:
        """按 taskId 查日志时的可用性说明。

        没有事件表不等于没有记录：目录不可读、未配置或被轮换都要如实说明，
        不能让报表把"查不到"写成"没发生过"。
        """
        if not self.directory.exists():
            return {"available": False, "reason": EVIDENCE_MISSING, "directory": str(self.directory)}

        if not os.access(self.directory, os.R_OK):
            return {
                "available": False,
                "reason": "audit_dir_not_readable",
                "directory": str(self.directory),
            }

        files = self.event_files()
        if not files:
            return {
                "available": False,
                "reason": EVIDENCE_MISSING,
                "directory": str(self.directory),
                "detail": "no event files present (rotated or never written)",
            }

        if task_id:
            return {
                "available": True,
                "directory": str(self.directory),
                "files": [path.name for path in files],
                "matchingRecords": len(self.read(task_id=task_id)),
            }

        return {
            "available": True,
            "directory": str(self.directory),
            "files": [path.name for path in files],
        }

    def rotate(self, *, now: Optional[datetime] = None) -> List[Path]:
        """删除超过保留期的事件文件，返回被删除的路径。

        只碰 events-*.jsonl：submission journal 与阻断标记属于未结案任务的
        应急证据，保留期规则不能把它们一起删掉。
        """
        if not self.directory.exists():
            return []

        cutoff = (now or datetime.now(timezone.utc)) - timedelta(days=self.retention_days)
        removed: List[Path] = []
        for path in self.event_files():
            stamp = path.name[len(EVENTS_FILE_PREFIX):-len(".jsonl")]
            try:
                written = datetime.strptime(stamp, "%Y-%m-%d").replace(tzinfo=timezone.utc)
            except ValueError:
                continue
            if written < cutoff:
                path.unlink()
                removed.append(path)
        return removed

    def protected_paths(self) -> Iterable[Path]:
        """永远不参与轮换的文件：未结案的提交证据。"""
        return (
            self.directory / JOURNAL_FILE_NAME,
            self.directory / BLOCK_MARKER_NAME,
        )
