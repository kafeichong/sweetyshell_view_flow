import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from receipts import ReceiptStore  # noqa: E402
from submission_state import (  # noqa: E402
    load_verified_local_delivery,
    record_downloaded,
    recover_current,
)


def test_recover_current_uses_authoritative_slot_before_any_new_submission(tmp_path):
    calls = []

    class Client:
        def get_current_task_for_slot(self, execution_slot_id):
            calls.append(("get-current", execution_slot_id))
            return {
                "executionSlotId": execution_slot_id,
                "currentTask": {
                    "id": "task-paid-1",
                    "status": "running",
                    "clientDeliveryStatus": "pending",
                },
            }

    receipts = ReceiptStore(tmp_path)

    recovered = recover_current(Client(), "slot-1", receipts)

    assert recovered == {
        "mode": "production",
        "task_id": "task-paid-1",
        "execution_slot_id": "slot-1",
        "recovered": True,
    }
    assert calls == [("get-current", "slot-1")]
    assert receipts.load("slot:slot-1") == {
        "executionSlotId": "slot-1",
        "taskId": "task-paid-1",
        "clientDeliveryStatus": "pending",
    }


def test_recover_current_returns_none_for_an_idle_slot_without_creating_work(tmp_path):
    class Client:
        def get_current_task_for_slot(self, execution_slot_id):
            return {"executionSlotId": execution_slot_id, "currentTask": None}

    assert recover_current(Client(), "slot-idle", ReceiptStore(tmp_path)) is None


def test_recover_current_preserves_a_downloaded_local_receipt(tmp_path):
    receipts = ReceiptStore(tmp_path)
    receipts.save("slot:slot-1", {
        "executionSlotId": "slot-1",
        "taskId": "task-1",
        "localDeliveryStatus": "downloaded",
        "localPath": "/output/task-1.mp4",
        "sha256": "a" * 64,
    })

    class Client:
        def get_current_task_for_slot(self, execution_slot_id):
            return {
                "executionSlotId": execution_slot_id,
                "currentTask": {"id": "task-1", "clientDeliveryStatus": "pending"},
            }

    recover_current(Client(), "slot-1", receipts)

    assert receipts.load("slot:slot-1")["localDeliveryStatus"] == "downloaded"
    assert receipts.load("slot:slot-1")["localPath"] == "/output/task-1.mp4"


def test_downloaded_receipt_is_reused_only_while_file_bytes_still_match(tmp_path):
    video = tmp_path / "task-1.mp4"
    video.write_bytes(b"verified-video")
    receipts = ReceiptStore(tmp_path / "receipts")
    record_downloaded(receipts, "slot-1", "task-1", {
        "localPath": str(video),
        "sha256": "a36c654f80c9638143e35ed8133c0e877ee2991b598003e3d5fd992f99984cc7",
        "sizeBytes": len(b"verified-video"),
        "assetId": "asset-1",
        "mimeType": "video/mp4",
    })

    assert load_verified_local_delivery(receipts, "slot-1", "task-1")["localPath"] == str(video)

    video.write_bytes(b"changed")
    assert load_verified_local_delivery(receipts, "slot-1", "task-1") is None
