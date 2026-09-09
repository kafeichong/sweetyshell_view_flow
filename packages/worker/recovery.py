"""Helpers for recovering interrupted provider tasks."""

from datetime import datetime, timedelta, timezone
from typing import Any, Mapping


def format_cost(cost: float | None) -> str:
    """Format a known cost without pretending an unavailable cost is zero."""
    # 避免把 unknown 误显示为 0；财务展示时只在已确认时显示金额。
    return f"¥{cost:.2f}" if cost is not None else "unknown"


def cost_status(usage: Mapping[str, Any] | None) -> str:
    """Classify whether a Provider response contains billable usage data."""
    # 约定：只要返回 total_tokens 即认为可确认计费来源。
    return "confirmed" if usage and "total_tokens" in usage else "unavailable"


def build_cost_audit(
    usage: Mapping[str, Any] | None,
    actual_cost: float | None,
    pricing_version: str | None,
) -> dict[str, Any]:
    """Build the persisted cost audit fields from one Provider result."""
    # 统一返回结构，便于后端持久化，不因为字段缺失导致 schema 分裂。
    if cost_status(usage) != "confirmed" or actual_cost is None:
        return {
            "actual_cost": None,
            "cost_status": "unavailable",
            "provider_usage": dict(usage) if usage else None,
            "pricing_version": None,
        }

    return {
        "actual_cost": actual_cost,
        "cost_status": "confirmed",
        "provider_usage": dict(usage),
        "pricing_version": pricing_version,
    }


def should_resume_job(job: Mapping[str, Any]) -> bool:
    """Return whether a job has enough state to resume provider polling."""
    # 允许恢复的最小条件：状态是已提交/运行且有 provider_task_id。
    return job.get("status") in {"submitted", "running"} and bool(
        job.get("provider_task_id")
    )


def is_stale_job(
    job: Mapping[str, Any],
    *,
    now: datetime | None = None,
    timeout_minutes: int = 10,
) -> bool:
    """Return whether an unfinished submitted/running job exceeded its timeout."""
    # 使用 ISO8601 时间判断任务在进行态下是否超过 running 超时阈值。
    if job.get("status") not in {"submitted", "running"}:
        return False

    submitted_at = job.get("submitted_at")
    if not submitted_at:
        return False

    try:
        started = datetime.fromisoformat(str(submitted_at).replace("Z", "+00:00"))
    except ValueError:
        return False

    if started.tzinfo is None:
        started = started.replace(tzinfo=timezone.utc)
    current = now or datetime.now(timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)
    return current - started >= timedelta(minutes=timeout_minutes)
