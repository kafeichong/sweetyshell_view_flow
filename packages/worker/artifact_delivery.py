"""产物归档的稳定标识与本地校验。

归档和生成是两条独立的分支：生成决定"Provider 上有没有产物"，归档只负责把
已知的产物搬到 OSS 并登记。这里定义的稳定 object key 是归档幂等的基础——
同一 task + attempt 永远指向同一个对象，重跑归档只会覆盖自己，不会产生第二份
产物记录，也不靠秒级时间戳碰运气去避免文件名冲突。
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional, Tuple


def artifact_format_spec(output_format: str) -> tuple[str, str]:
    """Return the file extension and MIME for a frozen Provider format."""
    formats = {
        "mp4": ("mp4", "video/mp4"),
        "mov": ("mov", "video/quicktime"),
    }
    try:
        return formats[output_format]
    except KeyError as error:
        raise ValueError(f"unsupported artifact output format: {output_format}") from error


def artifact_object_key(
    task_id: str,
    attempt_id: str,
    created_at: str,
    output_format: str = "mp4",
) -> str:
    """按任务创建日生成稳定对象键。

    归档补偿可能跨越午夜，因此目录日期取 Task 的 ``created_at``，并统一转换为
    UTC；不能取执行/上传时的当前时间。产物位置为
    ``videos/YYYY/MM/DD/{taskId}/{attemptId}/result.{format}``。
    """
    if not task_id or not attempt_id:
        raise ValueError("task_id and attempt_id are required for an artifact key")
    if not created_at:
        raise ValueError("created_at is required for an artifact key")

    try:
        parsed = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
    except (TypeError, ValueError) as error:
        raise ValueError("created_at must be an ISO 8601 timestamp") from error
    if parsed.tzinfo is None:
        raise ValueError("created_at must include a timezone")

    created_utc = parsed.astimezone(timezone.utc)
    extension, _ = artifact_format_spec(output_format)
    return (
        f"videos/{created_utc:%Y/%m/%d}/"
        f"{task_id}/{attempt_id}/result.{extension}"
    )


def validate_artifact_file(local_path: str | Path) -> Tuple[bool, Optional[str]]:
    """归档前的本地校验：文件必须存在且非空。

    返回 (是否可用, 失败原因)。空文件或缺失文件上传上去等于交付一个坏产物，
    必须在调用 Provider/OSS 之前就判定为归档失败。
    """
    path = Path(local_path)
    if not path.exists():
        return False, "ARTIFACT_FILE_MISSING"
    if not path.is_file():
        return False, "ARTIFACT_NOT_A_FILE"
    try:
        if path.stat().st_size <= 0:
            return False, "ARTIFACT_FILE_EMPTY"
    except OSError:
        return False, "ARTIFACT_FILE_UNREADABLE"
    return True, None


def object_size_from_head(head: Any) -> Optional[int]:
    """从 OSS HEAD 结果里取对象大小，取不到就返回 None。"""
    if head is None:
        return None

    # oss2 用 content_length（下划线）；部分 SDK 的字典形态用连字符，
    # 两种都认，避免因为取不到大小而把已存在的对象判成缺失。
    for attribute in ("content_length", "content-length"):
        value = getattr(head, attribute, None)
        if value is None and isinstance(head, dict):
            value = head.get(attribute)
        if isinstance(value, bool):
            continue
        if isinstance(value, int):
            return value
        if isinstance(value, str) and value.isdigit():
            return int(value)
    return None


def verify_uploaded_object(
    head: Any,
    *,
    expected_size: Optional[int] = None,
) -> Tuple[bool, Optional[str]]:
    """上传后确认对象真的存在且非空，避免登记一条指向空气的产物记录。"""
    if head is None:
        return False, "ARTIFACT_OBJECT_MISSING"

    size = object_size_from_head(head)
    if size is None:
        # HEAD 没给出大小：至少对象是存在的，不再断言大小。
        return True, None
    if size <= 0:
        return False, "ARTIFACT_OBJECT_EMPTY"
    if expected_size is not None and size != expected_size:
        return False, "ARTIFACT_OBJECT_SIZE_MISMATCH"
    return True, None
