import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from receipts import ReceiptStore, credential_namespace  # noqa: E402


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


def test_namespace_isolates_receipts_between_credentials(tmp_path):
    store_a = ReceiptStore(tmp_path, namespace=credential_namespace("https://a.test", "token-a"))
    store_b = ReceiptStore(tmp_path, namespace=credential_namespace("https://a.test", "token-b"))

    store_a.save("intent-1", {"taskId": "task-of-a"})

    # 换凭证后绝不能看到（更不能用）上一个人的 taskId。
    assert store_b.load("intent-1") is None
    assert store_a.load("intent-1")["taskId"] == "task-of-a"

    namespace_dirs = sorted(p.name for p in tmp_path.iterdir() if p.is_dir())
    assert len(namespace_dirs) == 2


def test_namespace_is_derived_and_never_contains_the_token(tmp_path):
    token = "vf_supersecret_actor_token"
    namespace = credential_namespace("https://backend.test", token)

    assert token not in namespace
    assert namespace == credential_namespace("https://backend.test/", token)
    assert namespace != credential_namespace("https://other.test", token)
    assert namespace != credential_namespace("https://backend.test", "another-token")

    store = ReceiptStore(tmp_path, namespace=namespace)
    store.save("intent-1", {"taskId": "task-1"})

    written = "".join(
        path.read_text(encoding="utf-8") for path in tmp_path.rglob("*") if path.is_file()
    )
    assert token not in written
    assert namespace in str(store.root)
    assert store.root.stat().st_mode & 0o777 == 0o700
