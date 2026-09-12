import httpx
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from client import ReceiptUpdateError, VideoFlowClient
from config import VideoFlowConfig
from receipts import ReceiptStore


class _FlakyReceiptStore(ReceiptStore):
    """第 fail_on 次写入失败，用来验证回执写不进去时的行为。"""

    def __init__(self, root, fail_on: int):
        super().__init__(root)
        self.fail_on = fail_on
        self.calls = 0

    def save(self, intent_key, payload):
        self.calls += 1
        if self.calls == self.fail_on:
            raise OSError("disk full")
        return super().save(intent_key, payload)


def test_retry_reuses_the_original_intent_instead_of_rebuilt_metadata(tmp_path):
    requests = []

    def handler(request):
        requests.append(request)
        if len(requests) == 1:
            raise httpx.ReadTimeout("connection dropped")
        return httpx.Response(201, json={"id": "task-1"})

    client = VideoFlowClient(
        VideoFlowConfig("https://backend.test", "secret-token"),
        httpx.Client(transport=httpx.MockTransport(handler)),
    )
    store = ReceiptStore(tmp_path)
    original = {"capability": "IMAGE_TO_VIDEO", "profile": "seedance", "params": {"prompt": "p"}}

    with pytest.raises(httpx.ReadTimeout):
        client.create_task_with_receipt(
            intent_key="intent-upgrade",
            idempotency_key="stable-key",
            payload=original,
            mode="production",
            receipt_store=store,
        )

    # 模拟软件升级后重建的请求体：多了一个当时不存在的 metadata 字段。
    upgraded = {
        "capability": "IMAGE_TO_VIDEO",
        "profile": "seedance",
        "params": {"prompt": "p"},
        "client_metadata": {"node_version": "2.0"},
    }
    result = client.create_task_with_receipt(
        intent_key="intent-upgrade",
        idempotency_key="stable-key",
        payload=upgraded,
        mode="production",
        receipt_store=store,
    )

    assert result["id"] == "task-1"
    # 重试必须原样复用第一次的 key 与请求体，否则会变成"同 key 不同请求"。
    assert requests[0].headers["idempotency-key"] == requests[1].headers["idempotency-key"]
    assert json.loads(requests[1].content) == json.loads(requests[0].content)
    assert "client_metadata" not in json.loads(requests[1].content)


def test_retry_does_not_bump_generation_version(tmp_path):
    requests = []

    def handler(request):
        requests.append(request)
        if len(requests) == 1:
            raise httpx.ReadTimeout("connection dropped")
        return httpx.Response(201, json={"id": "task-1"})

    client = VideoFlowClient(
        VideoFlowConfig("https://backend.test", "secret-token"),
        httpx.Client(transport=httpx.MockTransport(handler)),
    )
    store = ReceiptStore(tmp_path)
    base_key = client.stable_idempotency_key("p", b"image", generation_version=3)

    with pytest.raises(httpx.ReadTimeout):
        client.create_task_with_receipt(
            intent_key="intent-version",
            idempotency_key=base_key,
            payload={"capability": "IMAGE_TO_VIDEO", "profile": "seedance", "params": {"prompt": "p"}},
            mode="production",
            receipt_store=store,
        )

    # 重跑时调用方（或新版本模板）换了参数，但意图已经固化，不允许自动改版本。
    client.create_task_with_receipt(
        intent_key="intent-version",
        idempotency_key=client.stable_idempotency_key("p", b"image", generation_version=4),
        payload={"capability": "IMAGE_TO_VIDEO", "profile": "seedance", "params": {"prompt": "p"}},
        mode="production",
        receipt_store=store,
    )

    assert requests[1].headers["idempotency-key"] == client.mode_scoped_idempotency_key(
        base_key, "production"
    )
    assert store.load("intent-version")["taskId"] == "task-1"


def test_receipt_write_failure_blocks_the_paid_submission(tmp_path):
    requests = []
    client = VideoFlowClient(
        VideoFlowConfig("https://backend.test", "secret-token"),
        httpx.Client(
            transport=httpx.MockTransport(
                lambda request: requests.append(request) or httpx.Response(201, json={"id": "t"})
            )
        ),
    )
    store = _FlakyReceiptStore(tmp_path, fail_on=1)

    # 意图都没落盘就发付费请求，一次超时之后就再无凭据可查。
    with pytest.raises(OSError):
        client.create_task_with_receipt(
            intent_key="intent-no-receipt",
            idempotency_key="stable-key",
            payload={"capability": "IMAGE_TO_VIDEO", "profile": "seedance", "params": {"prompt": "p"}},
            mode="production",
            receipt_store=store,
        )

    assert requests == []
    assert store.load("intent-no-receipt") is None


def test_receipt_update_failure_reports_the_created_task_id(tmp_path):
    client = VideoFlowClient(
        VideoFlowConfig("https://backend.test", "secret-token"),
        httpx.Client(
            transport=httpx.MockTransport(
                lambda _request: httpx.Response(201, json={"id": "task-created"})
            )
        ),
    )
    store = _FlakyReceiptStore(tmp_path, fail_on=2)

    with pytest.raises(ReceiptUpdateError) as error:
        client.create_task_with_receipt(
            intent_key="intent-update-failure",
            idempotency_key="stable-key",
            payload={"capability": "IMAGE_TO_VIDEO", "profile": "seedance", "params": {"prompt": "p"}},
            mode="production",
            receipt_store=store,
        )

    # 任务确实创建了：必须显示 taskId，不能报成"未提交"诱导再跑一次。
    assert error.value.task_id == "task-created"
    assert "task-created" in str(error.value)
    assert store.load("intent-update-failure")["taskId"] is None


def test_receipt_store_is_namespaced_by_backend_and_credential(tmp_path):
    client = VideoFlowClient(
        VideoFlowConfig("https://backend.test", "token-a"),
        httpx.Client(transport=httpx.MockTransport(lambda _r: httpx.Response(201, json={"id": "t"}))),
    )
    other = VideoFlowClient(
        VideoFlowConfig("https://backend.test", "token-b"),
        httpx.Client(transport=httpx.MockTransport(lambda _r: httpx.Response(201, json={"id": "t"}))),
    )

    first = client.receipt_store(tmp_path)
    second = other.receipt_store(tmp_path)

    assert first.root != second.root
    assert "token-a" not in str(first.root)


def test_create_task_with_receipt_reuses_key_after_timeout(tmp_path):
    requests = []

    def handler(request):
        requests.append(request)
        raise httpx.ReadTimeout("connection dropped")

    client = VideoFlowClient(
        VideoFlowConfig("https://backend.test", "secret-token"),
        httpx.Client(transport=httpx.MockTransport(handler)),
    )
    store = ReceiptStore(tmp_path)
    payload = {"capability": "TEXT_TO_VIDEO", "profile": "seedance", "params": {"prompt": "p"}}

    for _ in range(2):
        try:
            client.create_task_with_receipt(
                intent_key="intent-timeout",
                idempotency_key="stable-key",
                payload=payload,
                mode="production",
                receipt_store=store,
            )
        except httpx.ReadTimeout:
            pass

    assert len(requests) == 2
    assert requests[0].headers["idempotency-key"] == requests[1].headers["idempotency-key"]
    receipt = store.load("intent-timeout")
    assert receipt["taskId"] is None
    assert receipt["idempotencyKey"] == requests[0].headers["idempotency-key"]


def test_create_task_with_receipt_records_task_id(tmp_path):
    client = VideoFlowClient(
        VideoFlowConfig("https://backend.test", "secret-token"),
        httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(201, json={"id": "task-1"}))),
    )
    store = ReceiptStore(tmp_path)

    result = client.create_task_with_receipt(
        intent_key="intent-success",
        idempotency_key="stable-key",
        payload={"capability": "TEXT_TO_VIDEO", "profile": "seedance", "params": {"prompt": "p"}},
        mode="production",
        receipt_store=store,
    )

    assert result["id"] == "task-1"
    assert store.load("intent-success")["taskId"] == "task-1"


def test_create_task_sends_preview_contract_without_exposing_token():
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(200, json={"id": "task-1"})

    client = VideoFlowClient(
        VideoFlowConfig("https://backend.test", "secret-token"),
        httpx.Client(transport=httpx.MockTransport(handler)),
    )
    result = client.create_task(
        idempotency_key="key-1",
        payload={"capability": "IMAGE_TO_VIDEO", "profile": "seedance", "params": {}},
    )

    assert result == {"id": "task-1"}
    assert requests[0].headers["authorization"] == "Bearer secret-token"
    assert requests[0].headers["idempotency-key"] == client.mode_scoped_idempotency_key(
        "key-1",
        "preview",
    )
    assert json.loads(requests[0].content)["mode"] == "preview"
    assert "secret-token" not in str(result)


def test_stable_idempotency_key_is_repeatable():
    key_a = VideoFlowClient.stable_idempotency_key("prompt", b"image")
    key_b = VideoFlowClient.stable_idempotency_key("prompt", b"image")
    assert key_a == key_b


def test_stable_idempotency_key_changes_with_generation_parameters():
    base = VideoFlowClient.stable_idempotency_key(
        "prompt",
        b"image",
        profile="seedance",
        duration=5,
        ratio="16:9",
    )
    changed_duration = VideoFlowClient.stable_idempotency_key(
        "prompt",
        b"image",
        profile="seedance",
        duration=10,
        ratio="16:9",
    )
    changed_ratio = VideoFlowClient.stable_idempotency_key(
        "prompt",
        b"image",
        profile="seedance",
        duration=5,
        ratio="9:16",
    )

    assert len({base, changed_duration, changed_ratio}) == 3


def test_explicit_version_distinguishes_new_generation():
    kwargs = {"profile": "seedance", "duration": 5, "ratio": "16:9", "spec_version": "test-v1"}

    version_1 = VideoFlowClient.stable_idempotency_key(
        "product", b"png", generation_version=1, **kwargs
    )
    version_2 = VideoFlowClient.stable_idempotency_key(
        "product", b"png", generation_version=2, **kwargs
    )
    other_spec = VideoFlowClient.stable_idempotency_key(
        "product", b"png", generation_version=1, **{**kwargs, "spec_version": "test-v2"}
    )

    # 版本由用户显式提升才表示再生成一版；规格升级同样属于新的生成意图。
    assert version_1 != version_2
    assert version_1 != other_spec
    assert version_1 == VideoFlowClient.stable_idempotency_key(
        "product", b"png", generation_version=1, **kwargs
    )


def test_create_task_scopes_same_base_idempotency_key_by_mode():
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(200, json={"id": "task-1"})

    client = VideoFlowClient(
        VideoFlowConfig("https://backend.test", "secret-token"),
        httpx.Client(transport=httpx.MockTransport(handler)),
    )
    payload = {"capability": "TEXT_TO_VIDEO", "profile": "seedance", "params": {}}
    base_key = VideoFlowClient.stable_idempotency_key("prompt", b"image")

    client.create_task(idempotency_key=base_key, payload=payload, mode="preview")
    client.create_task(idempotency_key=base_key, payload=payload, mode="production")

    preview_key = requests[0].headers["idempotency-key"]
    production_key = requests[1].headers["idempotency-key"]
    assert preview_key != production_key


def test_create_task_omits_production_unless_explicitly_requested():
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(200, json={"id": "task-1"})

    client = VideoFlowClient(
        VideoFlowConfig("https://backend.test", "secret-token"),
        httpx.Client(transport=httpx.MockTransport(handler)),
    )
    payload = {"capability": "TEXT_TO_VIDEO", "profile": "seedance", "params": {}}

    client.create_task(idempotency_key="k1", payload=payload)
    client.create_task(idempotency_key="k2", payload=payload, mode="production")

    assert json.loads(requests[0].content)["mode"] == "preview"
    assert json.loads(requests[1].content)["mode"] == "production"


def test_create_task_rejects_unknown_mode():
    client = VideoFlowClient(
        VideoFlowConfig("https://backend.test", "secret-token"),
        httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200, json={}))),
    )

    try:
        client.create_task(idempotency_key="k1", payload={}, mode="whatever")
    except ValueError:
        return

    raise AssertionError("unknown mode must be rejected before any HTTP call")


def test_upload_media_sends_content_hash_for_deduplication():
    import hashlib

    requests = []

    def handler(request):
        requests.append(request)
        if request.url.path.endswith("/upload-ticket"):
            return httpx.Response(
                200,
                json={"assetId": "asset-1", "uploadUrl": "https://oss.test/put", "uploadHeaders": {}},
            )
        if request.url.path.endswith("/assets/asset-1/complete"):
            return httpx.Response(200, json={"assetId": "asset-1", "inspectionStatus": "uploaded"})
        return httpx.Response(200)

    client = VideoFlowClient(
        VideoFlowConfig("https://backend.test", "secret-token"),
        httpx.Client(transport=httpx.MockTransport(handler)),
    )
    payload = b"same-image-bytes"

    client.upload_media(payload, filename="reference.png", mime_type="image/png")

    ticket_body = json.loads(requests[0].content)
    assert ticket_body["sha256"] == hashlib.sha256(payload).hexdigest()
    assert ticket_body["sizeBytes"] == len(payload)
    assert requests[1].method == "PUT"
    assert requests[2].method == "POST"
    assert requests[2].url.path.endswith("/api/v1/assets/asset-1/complete")


def test_upload_media_does_not_overwrite_an_already_uploaded_asset():
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(
            200,
            json={
                "assetId": "asset-existing",
                "objectKey": "inputs/actor-a/original.png",
                "alreadyUploaded": True,
                "inspectionStatus": "uploaded",
            },
        )

    client = VideoFlowClient(
        VideoFlowConfig("https://backend.test", "secret-token"),
        httpx.Client(transport=httpx.MockTransport(handler)),
    )

    result = client.upload_media(b"same-image", filename="same.png", mime_type="image/png")

    assert result["assetId"] == "asset-existing"
    assert len(requests) == 1
    assert requests[0].url.path.endswith("/upload-ticket")


def test_token_falls_back_to_file_when_env_is_absent(monkeypatch, tmp_path):
    token_file = tmp_path / "token"
    token_file.write_text("file-token\n", encoding="utf-8")
    monkeypatch.delenv("VIDEO_FLOW_TOKEN", raising=False)
    monkeypatch.setenv("VIDEO_FLOW_TOKEN_FILE", str(token_file))

    assert VideoFlowConfig.from_env().token == "file-token"


def test_env_token_takes_precedence_over_token_file(monkeypatch, tmp_path):
    token_file = tmp_path / "token"
    token_file.write_text("file-token", encoding="utf-8")
    monkeypatch.setenv("VIDEO_FLOW_TOKEN", "env-token")
    monkeypatch.setenv("VIDEO_FLOW_TOKEN_FILE", str(token_file))

    assert VideoFlowConfig.from_env().token == "env-token"


def test_missing_token_file_yields_empty_token(monkeypatch, tmp_path):
    monkeypatch.delenv("VIDEO_FLOW_TOKEN", raising=False)
    monkeypatch.setenv("VIDEO_FLOW_TOKEN_FILE", str(tmp_path / "does-not-exist"))

    assert VideoFlowConfig.from_env().token == ""


def test_client_initializes_when_comfyui_uses_a_socks_proxy(monkeypatch):
    for name in ("HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("ALL_PROXY", "socks5://127.0.0.1:9")
    monkeypatch.delenv("all_proxy", raising=False)

    client = VideoFlowClient(VideoFlowConfig("https://backend.test", "secret-token"))
    client.client.close()


def test_download_task_result_uses_fresh_result_url_and_writes_output(tmp_path):
    requests = []

    def handler(request):
        requests.append(request)
        if request.url.path.endswith("/api/v1/assets/tasks/task-1/result"):
            return httpx.Response(
                200,
                json={
                    "taskId": "task-1",
                    "assetId": "asset-1",
                    "objectKey": "videos/2026/09/11/final.mp4",
                    "downloadUrl": "https://oss.test/fresh-signed-url",
                },
            )
        if request.url.host == "oss.test":
            return httpx.Response(200, content=b"video-bytes")
        return httpx.Response(404)

    client = VideoFlowClient(
        VideoFlowConfig("https://backend.test", "secret-token"),
        httpx.Client(transport=httpx.MockTransport(handler)),
    )

    result = client.download_task_result("task-1", tmp_path)

    output = Path(result["localPath"])
    assert output.parent == tmp_path
    assert output.name == "task-1-final.mp4"
    assert output.read_bytes() == b"video-bytes"
    assert requests[0].headers["authorization"] == "Bearer secret-token"
    assert "authorization" not in requests[1].headers
