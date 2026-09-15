"""Recovery-first state transitions for a Production execution slot."""

import hashlib
from pathlib import Path
import secrets
from typing import Any

try:
    from .execution_slot import normalize_execution_slot_id
    from .receipts import ReceiptStore
except ImportError:  # ComfyUI loads custom node modules directly from the folder.
    from execution_slot import normalize_execution_slot_id
    from receipts import ReceiptStore


def slot_receipt_key(execution_slot_id: str) -> str:
    return f"slot:{normalize_execution_slot_id(execution_slot_id)}"


def recover_current(
    client: Any,
    execution_slot_id: str,
    receipt_store: ReceiptStore,
) -> dict[str, Any] | None:
    """Return the authoritative unfinished Task without evaluating new admission."""
    slot_id = normalize_execution_slot_id(execution_slot_id)
    response = client.get_current_task_for_slot(slot_id)
    if response.get("executionSlotId") != slot_id:
        raise ValueError("服务器返回的 executionSlotId 与请求不一致")

    task = response.get("currentTask")
    if not isinstance(task, dict) or not task.get("id"):
        return None

    task_id = str(task["id"])
    key = slot_receipt_key(slot_id)
    existing = receipt_store.load(key) or {}
    receipt_store.save(key, {
        **existing,
        "executionSlotId": slot_id,
        "taskId": task_id,
        "clientDeliveryStatus": task.get("clientDeliveryStatus"),
    })
    return {
        "mode": "production",
        "task_id": task_id,
        "execution_slot_id": slot_id,
        "recovered": True,
    }


def begin_submission_round(
    client: Any,
    receipt_store: ReceiptStore,
    execution_slot_id: str,
    original_request: dict[str, Any],
    submission: dict[str, Any],
) -> tuple[str, str]:
    """Persist one exact paid-submission intent before the POST is attempted."""
    slot_id = normalize_execution_slot_id(execution_slot_id)
    key = slot_receipt_key(slot_id)
    request_body = {**submission, "mode": "production"}
    existing = receipt_store.load(key) or {}

    if (
        existing.get("taskId") is None
        and existing.get("localDeliveryStatus") == "submitting"
        and existing.get("body") == request_body
        and isinstance(existing.get("idempotencyKey"), str)
    ):
        return key, str(existing["idempotencyKey"])

    base_key = f"round-{secrets.token_hex(16)}"
    scoped_key = client.mode_scoped_idempotency_key(base_key, "production")
    receipt_store.save(key, {
        "executionSlotId": slot_id,
        "originalRequest": original_request,
        "idempotencyKey": scoped_key,
        "mode": "production",
        "body": request_body,
        "taskId": None,
        "localDeliveryStatus": "submitting",
    })
    return key, scoped_key


def record_downloaded(
    receipt_store: ReceiptStore,
    execution_slot_id: str,
    task_id: str,
    artifact: dict[str, Any],
) -> dict[str, Any]:
    key = slot_receipt_key(execution_slot_id)
    existing = receipt_store.load(key) or {}
    payload = {
        **existing,
        "executionSlotId": normalize_execution_slot_id(execution_slot_id),
        "taskId": str(task_id),
        "localDeliveryStatus": "downloaded",
        "localPath": artifact.get("localPath"),
        "assetId": artifact.get("assetId"),
        "mimeType": artifact.get("mimeType"),
        "sizeBytes": artifact.get("sizeBytes"),
        "sha256": artifact.get("sha256"),
    }
    receipt_store.save(key, payload)
    return payload


def record_confirmed(
    receipt_store: ReceiptStore,
    execution_slot_id: str,
    task_id: str,
) -> dict[str, Any]:
    key = slot_receipt_key(execution_slot_id)
    existing = receipt_store.load(key) or {}
    if str(existing.get("taskId") or "") != str(task_id):
        raise ValueError("本地交付回执与 taskId 不一致")
    payload = {**existing, "localDeliveryStatus": "confirmed"}
    receipt_store.save(key, payload)
    return payload


def load_verified_local_delivery(
    receipt_store: ReceiptStore,
    execution_slot_id: str,
    task_id: str,
) -> dict[str, Any] | None:
    receipt = receipt_store.load(slot_receipt_key(execution_slot_id)) or {}
    if str(receipt.get("taskId") or "") != str(task_id):
        return None
    if receipt.get("localDeliveryStatus") not in {"downloaded", "confirmed"}:
        return None

    path_value = receipt.get("localPath")
    expected_hash = receipt.get("sha256")
    expected_size = receipt.get("sizeBytes")
    if not isinstance(path_value, str) or not isinstance(expected_hash, str):
        return None
    path = Path(path_value).expanduser()
    if not path.is_file():
        return None

    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
            size += len(chunk)
    if expected_size is not None and size != int(expected_size):
        return None
    if digest.hexdigest() != expected_hash:
        return None
    return receipt
