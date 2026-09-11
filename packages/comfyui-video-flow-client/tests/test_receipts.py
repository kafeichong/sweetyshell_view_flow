import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from receipts import ReceiptStore  # noqa: E402


def test_receipt_store_saves_and_loads_atomically(tmp_path):
    store = ReceiptStore(tmp_path)
    payload = {
        "idempotencyKey": "key-1",
        "body": {"mode": "production", "generation_version": 1},
        "taskId": None,
    }

    store.save("intent-1", payload)

    assert store.load("intent-1") == payload
    receipts = list(tmp_path.glob("*.json"))
    assert len(receipts) == 1
    assert json.loads(receipts[0].read_text(encoding="utf-8")) == payload
    assert not list(tmp_path.glob("*.tmp"))


def test_receipt_store_rejects_path_traversal_and_keeps_permissions(tmp_path):
    store = ReceiptStore(tmp_path)

    try:
        store.save("../escape", {"taskId": "task-1"})
    except ValueError:
        pass
    else:
        raise AssertionError("receipt intent key must not escape receipt root")

    store.save("safe-intent", {"taskId": "task-1"})
    receipt = next(tmp_path.glob("*.json"))
    assert receipt.stat().st_mode & 0o777 == 0o600
    assert tmp_path.stat().st_mode & 0o777 == 0o700
