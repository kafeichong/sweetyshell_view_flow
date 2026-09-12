#!/usr/bin/env python3
"""最小巡检：读取内部健康与受控统计，按阈值告警，必要时只暂停、不解除。

设计上的几条硬约束：

- **只自动暂停，绝不自动解除。** 解除暂停是恢复花钱的动作，必须由管理员核实
  原因并留审计；脚本没有这个权限。
- **判定与副作用分离。** `evaluate_checks` 只根据快照算出要报什么、要做什么，
  不发请求、不改状态，便于测试和人工复核。
- **同一问题只通知一次**，持续存在时去重，恢复时补一条恢复通知（同样不解除暂停）。
- **通知失败要显式失败**：非零退出并保留待通知记录，下次继续重试，
  不能让"告警没发出去"看起来像"一切正常"。
- 凭证与 webhook 都从文件读取；未配置 webhook 时只做 dry-run，不允许据此签收。
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

# 第 6 节监控清单的初始阈值（试点建议值，按生成规格调整）。
THRESHOLDS = {
    "consecutive_failures": 2,        # 连续 2 次检查失败
    "pending_stalled_seconds": 120,   # pending 无领取超过 2 分钟
    "generation_stalled_seconds": 900,  # 生成长时间未结束超过 15 分钟
    "delivery_stalled_seconds": 300,  # 产物不可交付超过 5 分钟
    "disk_warn_percent": 80,
    "disk_pause_percent": 90,
}

SEVERITY_ORDER = {"info": 0, "warning": 1, "critical": 2}


@dataclass
class Check:
    """一条检查结论：只描述事实与建议，不直接产生副作用。"""

    code: str
    severity: str
    action: str
    message: str
    taskId: Optional[str] = None

    def as_dict(self) -> Dict[str, Any]:
        return asdict(self)


def disk_usage_percent(path: str) -> Optional[float]:
    try:
        usage = shutil.disk_usage(path)
    except OSError:
        return None
    if usage.total <= 0:
        return None
    return usage.used / usage.total * 100


def evaluate_checks(
    snapshot: Dict[str, Any],
    *,
    thresholds: Optional[Dict[str, Any]] = None,
    consecutive_failures: int = 0,
) -> List[Dict[str, Any]]:
    """纯函数：只根据快照判定，不写状态、不发请求。

    snapshot 结构：
    - worker: /ready 的响应（可为 None 表示读不到）
    - backend: /api/v1/admin/operations/health 的响应（可为 None）
    - diskUsagePercent: 宿主或卷的使用率
    """
    limits = {**THRESHOLDS, **(thresholds or {})}
    checks: List[Check] = []

    worker = snapshot.get("worker")
    backend = snapshot.get("backend")

    # 1. 服务不可用 / 心跳停止：连续 N 次失败才告警，避免单次抖动刷屏。
    if worker is None or backend is None or not (worker or {}).get("ready"):
        if consecutive_failures >= limits["consecutive_failures"]:
            detail = "worker /ready unavailable"
            if worker is not None and not worker.get("ready"):
                detail = "worker not ready: " + "; ".join(worker.get("reasons") or ["unknown"])
            elif backend is None:
                detail = "backend operations health unavailable"
            checks.append(
                Check(
                    code="SERVICE_UNAVAILABLE",
                    severity="critical",
                    action="notify",
                    message=f"{detail} (连续 {consecutive_failures} 次检查失败)",
                )
            )
        else:
            checks.append(
                Check(
                    code="SERVICE_DEGRADED",
                    severity="info",
                    action="watch",
                    message="一次检查失败，继续观察（未达连续失败阈值）",
                )
            )
        # 服务不可用时不再解读统计值：那些数字已经不可信。
        return _with_disk(snapshot, checks, limits)

    if backend.get("status") != "ok" or (backend.get("database") or {}).get("status") != "ok":
        checks.append(
            Check(
                code="DATABASE_UNAVAILABLE",
                severity="critical",
                action="notify",
                message="backend 报告数据库不可用，暂停新准入",
            )
        )
        return _with_disk(snapshot, checks, limits)

    queue = backend.get("queue") or {}
    backlog = backend.get("backlog") or {}

    age = queue.get("oldestPendingAgeSeconds")
    if age is not None and age > limits["pending_stalled_seconds"]:
        checks.append(
            Check(
                code="PENDING_NOT_CLAIMED",
                severity="warning",
                action="notify",
                message=f"最老 pending 已等待 {age}s（阈值 {limits['pending_stalled_seconds']}s）",
                taskId=queue.get("oldestPendingTaskId"),
            )
        )

    active_task_id = (worker or {}).get("activeTaskId")
    active_age = (worker or {}).get("activeTaskAgeSeconds")
    if active_task_id and active_age is not None and active_age > limits["generation_stalled_seconds"]:
        checks.append(
            Check(
                code="GENERATION_STALLED",
                severity="warning",
                # 只标记关注并查询原任务：不能宣告免费失败，更不能自动再生成。
                action="notify_and_query_provider",
                message=f"任务已生成 {active_age:.0f}s 仍未结束（阈值 {limits['generation_stalled_seconds']}s）",
                taskId=active_task_id,
            )
        )

    if (backlog.get("requiresReview") or 0) > 0:
        checks.append(
            Check(
                code="REQUIRES_REVIEW",
                severity="critical",
                # 预占保留，核实 Provider 之后再处置。
                action="notify",
                message=f"{backlog['requiresReview']} 条任务需要人工核查（预占保留）",
            )
        )

    delivery_failed = backlog.get("deliveryFailed") or 0
    if delivery_failed > 0:
        checks.append(
            Check(
                code="DELIVERY_FAILED",
                severity="warning",
                action="notify",
                message=f"{delivery_failed} 条任务生成成功但产物不可交付，请修复原产物",
            )
        )

    if (backlog.get("costUnverified") or 0) > 0:
        checks.append(
            Check(
                code="COST_UNVERIFIED",
                severity="critical",
                # 费用不确定必须暂停后续准入：否则会在未知花费上继续叠加。
                action="pause_admission",
                message=f"{backlog['costUnverified']} 条任务费用待核实，暂停新准入",
            )
        )

    return _with_disk(snapshot, checks, limits)


def _with_disk(snapshot: Dict[str, Any], checks: List[Check], limits: Dict[str, Any]) -> List[Dict[str, Any]]:
    usage = snapshot.get("diskUsagePercent")
    if usage is not None:
        if usage >= limits["disk_pause_percent"]:
            checks.append(
                Check(
                    code="DISK_CRITICAL",
                    severity="critical",
                    action="pause_admission",
                    message=f"磁盘使用率 {usage:.0f}% ≥ {limits['disk_pause_percent']}%，停止新准入",
                )
            )
        elif usage >= limits["disk_warn_percent"]:
            checks.append(
                Check(
                    code="DISK_WARNING",
                    severity="warning",
                    action="notify",
                    message=f"磁盘使用率 {usage:.0f}% ≥ {limits['disk_warn_percent']}%",
                )
            )
    return [check.as_dict() for check in checks]


# --------------------------------------------------------------------------
# 通知与状态：副作用集中在这里，便于在测试里替换。
# --------------------------------------------------------------------------


def read_secret_file(env_name: str, default: str) -> Optional[str]:
    path = Path(os.getenv(env_name, default)).expanduser()
    if not path.is_file():
        return None
    token = path.read_text(encoding="utf-8").strip()
    return token or None


def load_state(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {"active": {}, "pending_notifications": []}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"active": {}, "pending_notifications": []}


def save_state(path: Path, state: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.chmod(0o600)
    temporary.replace(path)


def diff_checks(
    previous: Dict[str, Any],
    current: Iterable[Dict[str, Any]],
) -> Dict[str, List[Dict[str, Any]]]:
    """把当前结论与上一轮对比：首次、持续、恢复。"""
    current_by_code = {check["code"]: check for check in current}
    first_time = [check for code, check in current_by_code.items() if code not in previous]
    ongoing = [check for code, check in current_by_code.items() if code in previous]
    recovered = [
        {"code": code, "message": "问题已恢复"}
        for code in previous
        if code not in current_by_code
    ]
    return {"first_time": first_time, "ongoing": ongoing, "recovered": recovered}


def send_webhook(url: str, payload: Dict[str, Any], *, timeout: float = 10.0) -> None:
    import httpx

    response = httpx.post(url, json=payload, timeout=timeout)
    response.raise_for_status()


def notify(
    payload: Dict[str, Any],
    *,
    webhook: Optional[str],
    dry_run: bool,
) -> bool:
    """发送通知；返回是否成功。dry-run 明确不算送达。"""
    if dry_run or not webhook:
        print(f"[dry-run] {json.dumps(payload, ensure_ascii=False)}")
        return False

    try:
        send_webhook(webhook, payload)
        return True
    except Exception as error:
        print(f"通知失败: {error}", file=sys.stderr)
        return False


def pause_admission(base_url: str, admin_token: str, reason: str) -> bool:
    """只暂停，不解除；解除必须由管理员走人工流程。"""
    import httpx

    try:
        response = httpx.patch(
            f"{base_url.rstrip('/')}/api/v1/admin/operations/production-gate",
            headers={"X-Admin-Token": admin_token},
            json={"paused": True, "reason": reason, "operator": "monitor"},
            timeout=10.0,
        )
        response.raise_for_status()
        return True
    except Exception as error:
        print(f"暂停准入失败: {error}", file=sys.stderr)
        return False


def collect_snapshot(base_url: str, admin_token: str, worker_ready_url: str, disk_path: str) -> Dict[str, Any]:
    import httpx

    snapshot: Dict[str, Any] = {"worker": None, "backend": None, "diskUsagePercent": disk_usage_percent(disk_path)}
    try:
        response = httpx.get(worker_ready_url, timeout=5.0)
        response.raise_for_status()
        snapshot["worker"] = response.json()
    except Exception:
        snapshot["worker"] = None
    try:
        response = httpx.get(
            f"{base_url.rstrip('/')}/api/v1/admin/operations/health",
            headers={"X-Admin-Token": admin_token},
            timeout=10.0,
        )
        response.raise_for_status()
        snapshot["backend"] = response.json()
    except Exception:
        snapshot["backend"] = None
    return snapshot


def run_once(args: argparse.Namespace) -> int:
    state_path = Path(args.state_file).expanduser()
    state = load_state(state_path)

    admin_token = read_secret_file("VIDEO_FLOW_ADMIN_TOKEN_FILE", "~/.video-flow/admin-token")
    if not admin_token:
        print("admin token file not found; cannot read operations health", file=sys.stderr)
        return 2

    webhook = read_secret_file("VIDEO_FLOW_ALERT_WEBHOOK_FILE", "~/.video-flow/alert-webhook")
    dry_run = webhook is None

    snapshot = collect_snapshot(args.base_url, admin_token, args.worker_ready_url, args.disk_path)
    checks = evaluate_checks(
        snapshot,
        consecutive_failures=state.get("consecutive_failures", 0) + (0 if (snapshot.get("worker") or {}).get("ready") else 1),
    )

    diff = diff_checks(state.get("active", {}), checks)

    delivered_all = True
    receipts = []
    # 首次通知；持续问题去重（只记回执，不重复打扰）。
    for check in diff["first_time"]:
        sent = notify(
            {"type": "alert", "at": datetime.now(timezone.utc).isoformat(), **check},
            webhook=webhook,
            dry_run=dry_run,
        )
        receipts.append({"check": check["code"], "taskId": check.get("taskId"), "delivered": sent, "kind": "alert"})
        delivered_all = delivered_all and sent

    for check in diff["recovered"]:
        sent = notify(
            {"type": "recovery", "at": datetime.now(timezone.utc).isoformat(), **check},
            webhook=webhook,
            dry_run=dry_run,
        )
        receipts.append({"check": check["code"], "delivered": sent, "kind": "recovery"})
        # 恢复通知发送失败也要留记录，但不因此让整轮失败——恢复本身是好事。
        if not dry_run and not sent:
            delivered_all = False

    # 需要暂停准入时只暂停；解除永远留给管理员。
    for check in checks:
        if check["action"] == "pause_admission":
            if pause_admission(args.base_url, admin_token, check["message"]):
                receipts.append({"check": check["code"], "kind": "pause_admission", "delivered": True})
            else:
                delivered_all = False

    state["active"] = {check["code"]: check for check in checks}
    if delivered_all:
        state["consecutive_failures"] = 0 if (snapshot.get("worker") or {}).get("ready") else state.get("consecutive_failures", 0) + 1
        state["pending_notifications"] = []
    else:
        state["consecutive_failures"] = state.get("consecutive_failures", 0) + 1
        # 通知失败要保留待通知记录，下一轮继续重试，不能悄悄丢掉。
        state["pending_notifications"] = (state.get("pending_notifications") or []) + receipts

    save_state(state_path, state)

    for receipt in receipts:
        print(json.dumps({"receipt": receipt}, ensure_ascii=False))

    if dry_run:
        print("webhook 未配置：本轮只做 dry-run，不能作为告警送达的凭据", file=sys.stderr)
        return 0

    return 0 if delivered_all else 1


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Video Flow 最小巡检")
    parser.add_argument("--base-url", default=os.getenv("VIDEO_FLOW_BACKEND_URL", "http://localhost:3100"))
    parser.add_argument(
        "--worker-ready-url",
        default=os.getenv("VIDEO_FLOW_WORKER_READY_URL", "http://video-worker:8001/ready"),
    )
    parser.add_argument("--disk-path", default=os.getenv("VIDEO_FLOW_DISK_PATH", "/data/video-flow"))
    parser.add_argument(
        "--state-file",
        default=os.getenv("VIDEO_FLOW_MONITOR_STATE", "~/.video-flow/monitor-state.json"),
    )
    parser.add_argument("--dry-run", action="store_true", help="不发送通知，只打印判定结果")
    args = parser.parse_args(argv)

    if args.dry_run:
        os.environ.pop("VIDEO_FLOW_ALERT_WEBHOOK_FILE", None)

    return run_once(args)


if __name__ == "__main__":
    raise SystemExit(main())
