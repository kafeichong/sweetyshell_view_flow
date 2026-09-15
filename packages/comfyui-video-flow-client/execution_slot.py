"""Execution-slot identifiers shared by the Production client flow."""

from uuid import uuid4


def new_execution_slot_id() -> str:
    return f"slot-{uuid4()}"


def normalize_execution_slot_id(value: object) -> str:
    execution_slot_id = value.strip() if isinstance(value, str) else ""
    if not execution_slot_id:
        raise ValueError("executionSlotId 不能为空")
    return execution_slot_id
