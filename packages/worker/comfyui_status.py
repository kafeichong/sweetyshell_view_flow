from typing import Any


_PENDING = {"pending", "queued", "queue", "awaiting", "submitted"}
_RUNNING = {"running", "executing", "execution", "processing", "in_progress"}
_COMPLETED = {"completed", "complete", "success", "succeeded", "finished"}
_FAILED = {"failed", "failure", "error", "errored", "cancelled", "canceled"}


def _history_entry(history: dict[str, Any]) -> dict[str, Any] | None:
    # 历史记录有两种形态：新历史通常直接含 status/outputs，老历史是 {id: {...}} 的 map。
    if "status" in history or "outputs" in history:
        return history
    entries = [value for value in history.values() if isinstance(value, dict)]
    if len(entries) == 1:
        return entries[0]
    return None


def map_comfyui_status(history: dict[str, Any]) -> str:
    """Map a ComfyUI history payload to the worker's four-state contract."""
    # 将 ComfyUI 的自由文本状态映射到 worker 的四态模型，便于统一更新逻辑。
    if not isinstance(history, dict):
        return "failed"

    entry = _history_entry(history)
    if entry is None:
        return "failed" if history else "pending"

    status = entry.get("status")
    if status is None:
        return "pending" if history == {} else "failed"
    if not isinstance(status, dict):
        return "failed"

    status_name = status.get("status_str")
    if not isinstance(status_name, str):
        return "failed"
    normalized = status_name.strip().lower()

    if normalized in _FAILED:
        return "failed"
    if normalized in _RUNNING:
        return "running"
    if normalized in _PENDING:
        return "pending"
    if normalized in _COMPLETED:
        return "completed"
    return "failed"


def build_dry_run_cost_fields() -> dict[str, Any]:
    """Return the explicit no-cost-data contract for local dry-run work."""
    # dry-run 不入账，统一返回占位字段，避免上游误判为免费 0 元。
    return {
        "actual_cost": None,
        "cost_status": "unavailable",
        "provider_usage": None,
        "pricing_version": None,
    }
