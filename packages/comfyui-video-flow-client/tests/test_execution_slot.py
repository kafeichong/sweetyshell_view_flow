import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from execution_slot import new_execution_slot_id, normalize_execution_slot_id  # noqa: E402


def test_execution_slot_id_is_stable_and_rejects_missing_values():
    assert normalize_execution_slot_id(" slot-creative-1 ") == "slot-creative-1"

    for value in (None, "", "   "):
        try:
            normalize_execution_slot_id(value)
        except ValueError as error:
            assert "executionSlotId" in str(error)
        else:
            raise AssertionError("missing executionSlotId must fail before submission")


def test_new_execution_slot_ids_are_unique_and_valid():
    first = new_execution_slot_id()
    second = new_execution_slot_id()

    assert first != second
    assert normalize_execution_slot_id(first) == first
    assert first.startswith("slot-")
