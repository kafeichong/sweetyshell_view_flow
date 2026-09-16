import httpx
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from client import (
    ArtifactDownloadError,
    ReceiptUpdateError,
    TaskCredentialsRejected,
    TaskDeliveryFailed,
    TaskNotFound,
    TaskProviderFailed,
    TaskRequiresReview,
    TaskWaitTimeout,
    VideoFlowClient,
)
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
    original = {"workflowKey": "seedance.reference-image-to-video.v1", "prompt": {"positive": "p"}, "generation": {"duration": 5, "ratio": "16:9", "resolution": "720p"}, "media": [{"assetId": "asset-1", "role": "reference_image"}]}

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
            payload={"workflowKey": "seedance.reference-image-to-video.v1", "prompt": {"positive": "p"}, "generation": {"duration": 5, "ratio": "16:9", "resolution": "720p"}, "media": [{"assetId": "asset-1", "role": "reference_image"}]},
            mode="production",
            receipt_store=store,
        )

    # 重跑时调用方（或新版本模板）换了参数，但意图已经固化，不允许自动改版本。
    client.create_task_with_receipt(
        intent_key="intent-version",
        idempotency_key=client.stable_idempotency_key("p", b"image", generation_version=4),
        payload={"workflowKey": "seedance.reference-image-to-video.v1", "prompt": {"positive": "p"}, "generation": {"duration": 5, "ratio": "16:9", "resolution": "720p"}, "media": [{"assetId": "asset-1", "role": "reference_image"}]},
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
            payload={"workflowKey": "seedance.reference-image-to-video.v1", "prompt": {"positive": "p"}, "generation": {"duration": 5, "ratio": "16:9", "resolution": "720p"}, "media": [{"assetId": "asset-1", "role": "reference_image"}]},
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
            payload={"workflowKey": "seedance.reference-image-to-video.v1", "prompt": {"positive": "p"}, "generation": {"duration": 5, "ratio": "16:9", "resolution": "720p"}, "media": [{"assetId": "asset-1", "role": "reference_image"}]},
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
    payload = {"workflowKey": "seedance.text-to-video.v1", "prompt": {"positive": "p"}, "generation": {"duration": 5, "ratio": "16:9", "resolution": "720p"}, "media": []}

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
        payload={"workflowKey": "seedance.text-to-video.v1", "prompt": {"positive": "p"}, "generation": {"duration": 5, "ratio": "16:9", "resolution": "720p"}, "media": []},
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
        payload={"workflowKey": "seedance.reference-image-to-video.v1", "prompt": {"positive": "p"}, "generation": {"duration": 5, "ratio": "16:9", "resolution": "720p"}, "media": [{"assetId": "asset-1", "role": "reference_image"}]},
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
    payload = {"workflowKey": "seedance.text-to-video.v1", "prompt": {"positive": "p"}, "generation": {"duration": 5, "ratio": "16:9", "resolution": "720p"}, "media": []}
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
    payload = {"workflowKey": "seedance.text-to-video.v1", "prompt": {"positive": "p"}, "generation": {"duration": 5, "ratio": "16:9", "resolution": "720p"}, "media": []}

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


def test_slot_recovery_and_client_delivery_use_authenticated_task_routes():
    requests = []

    def handler(request):
        requests.append(request)
        if request.method == "GET":
            return httpx.Response(
                200,
                json={"executionSlotId": "slot / 1", "currentTask": {"id": "task-1"}},
            )
        return httpx.Response(
            200,
            json={"taskId": "task-1", "clientDeliveryStatus": "delivered", "applied": True},
        )

    client = VideoFlowClient(
        VideoFlowConfig("https://backend.test", "secret-token"),
        httpx.Client(transport=httpx.MockTransport(handler)),
    )

    current = client.get_current_task_for_slot("slot / 1")
    delivered = client.confirm_client_delivery("task-1")

    assert current["currentTask"]["id"] == "task-1"
    assert delivered["clientDeliveryStatus"] == "delivered"
    assert requests[0].url.raw_path == b"/api/v1/tasks/slots/slot%20%2F%201/current"
    assert requests[0].headers["authorization"] == "Bearer secret-token"
    assert requests[1].method == "POST"
    assert requests[1].url.path == "/api/v1/tasks/task-1/client-delivery"


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


def test_upload_media_does_not_overwrite_an_already_verified_asset():
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(
            200,
            json={
                "assetId": "asset-existing",
                "objectKey": "inputs/actor-a/original.png",
                "alreadyUploaded": True,
                "inspectionStatus": "verified",
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


def test_upload_media_completes_inspection_before_reusing_a_legacy_uploaded_asset():
    requests = []

    def handler(request):
        requests.append(request)
        if request.url.path.endswith("/upload-ticket"):
            return httpx.Response(200, json={
                "assetId": "asset-existing", "alreadyUploaded": True,
                "requiresInspection": True, "inspectionStatus": "uploaded",
            })
        if request.url.path.endswith("/assets/asset-existing/complete"):
            return httpx.Response(200, json={"assetId": "asset-existing", "inspectionStatus": "verified"})
        raise AssertionError(str(request.url))

    client = VideoFlowClient(
        VideoFlowConfig("https://backend.test", "secret-token"),
        httpx.Client(transport=httpx.MockTransport(handler)),
    )

    result = client.upload_media(b"same-image", filename="same.png", mime_type="image/png")

    assert result["inspectionStatus"] == "verified"
    assert [(request.method, request.url.path) for request in requests] == [
        ("POST", "/api/v1/assets/upload-ticket"),
        ("POST", "/api/v1/assets/asset-existing/complete"),
    ]


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
        if request.url.path.endswith("/api/v1/tasks/task-1"):
            return httpx.Response(
                200,
                json={
                    "id": "task-1",
                    "delivery": {"status": "ready", "assetId": "asset-1"},
                    "costSummary": {"status": "usage_calculated", "usageCalculatedCny": "0.700000"},
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


def _wait_client(handler):
    return VideoFlowClient(
        VideoFlowConfig("https://backend.test", "secret-token"),
        httpx.Client(transport=httpx.MockTransport(handler)),
    )


def test_wait_for_task_returns_only_when_delivery_is_ready():
    summaries = [
        {"delivery": {"status": "not_started"}, "taskStatus": "pending"},
        {"delivery": {"status": "archiving"}, "taskStatus": "in_progress"},
        {
            "delivery": {"status": "ready", "assetId": "asset-1"},
            "taskStatus": "completed",
            "costSummary": {"status": "usage_calculated", "usageCalculatedCny": "0.700000"},
        },
    ]

    def handler(_request):
        return httpx.Response(200, json=summaries.pop(0))

    result = _wait_client(handler).wait_for_task("task-1", poll_seconds=0)

    # Provider succeeded 不等于能交付：只有 delivery=ready 才算等到。
    assert result["delivery"]["status"] == "ready"


def test_wait_for_task_keeps_polling_transient_failures_without_rebuilding():
    calls = []

    def handler(_request):
        calls.append(1)
        if len(calls) == 1:
            return httpx.Response(429, json={"message": "slow down"})
        if len(calls) == 2:
            return httpx.Response(503, json={"message": "unavailable"})
        if len(calls) == 3:
            raise httpx.ConnectError("connection reset")
        return httpx.Response(200, json={"delivery": {"status": "ready"}})

    result = _wait_client(handler).wait_for_task("task-1", poll_seconds=0)

    assert result["delivery"]["status"] == "ready"
    # 只重复查询同一个 task，绝不重新创建。
    assert len(calls) == 4


def test_wait_for_task_stops_on_rejected_credentials():
    def handler(_request):
        return httpx.Response(401, json={"message": "invalid token"})

    with pytest.raises(TaskCredentialsRejected) as error:
        _wait_client(handler).wait_for_task("task-1", poll_seconds=0)

    assert error.value.task_id == "task-1"
    assert error.value.status_code == 401
    assert "VIDEO_FLOW_TOKEN" in str(error.value)


def test_wait_for_task_reports_missing_task_without_retrying():
    calls = []

    def handler(_request):
        calls.append(1)
        return httpx.Response(404, json={"message": "Task not found"})

    with pytest.raises(TaskNotFound):
        _wait_client(handler).wait_for_task("task-1", poll_seconds=0)

    assert len(calls) == 1


@pytest.mark.parametrize(
    "summary,expected",
    [
        (
            {"delivery": {"status": "failed", "errorCode": "upload:ARTIFACT_UPLOAD_FAILED"},
             "taskStatus": "failed"},
            TaskDeliveryFailed,
        ),
        (
            {"delivery": {"status": "not_started"}, "taskStatus": "requires_review"},
            TaskRequiresReview,
        ),
        (
            {"delivery": {"status": "not_started"}, "taskStatus": "failed",
             "errorMsg": "content policy"},
            TaskProviderFailed,
        ),
    ],
)
def test_wait_for_task_distinguishes_terminal_failures(summary, expected):
    def handler(_request):
        return httpx.Response(200, json=summary)

    with pytest.raises(expected) as error:
        _wait_client(handler).wait_for_task("task-1", poll_seconds=0)

    # 每种失败都要能拿到 taskId，用户才知道拿哪个任务去核对或人工恢复。
    assert error.value.task_id == "task-1"
    assert error.value.code != ""


def test_wait_for_task_times_out_without_dropping_the_task():
    calls = []

    def handler(_request):
        calls.append(1)
        return httpx.Response(200, json={"delivery": {"status": "archiving"}})

    with pytest.raises(TaskWaitTimeout) as error:
        _wait_client(handler).wait_for_task("task-1", timeout_seconds=0, poll_seconds=0)

    assert error.value.task_id == "task-1"
    assert "query it again instead of resubmitting" in str(error.value)
    assert len(calls) == 1


def test_cost_note_flags_unverified_usage_without_blocking_download():
    client = _wait_client(lambda _r: httpx.Response(200, json={}))

    unverified = {"delivery": {"status": "ready"}, "costSummary": {"status": "unavailable"}}
    verified = {
        "delivery": {"status": "ready"},
        "costSummary": {"status": "usage_calculated", "usageCalculatedCny": "0.700000"},
    }

    assert client.cost_is_unverified(unverified) is True
    assert "费用待核实" in client.cost_note(unverified)
    assert client.cost_is_unverified(verified) is False
    assert "0.700000" in client.cost_note(verified)


def _download_client(result_body, content=b"video-bytes", fail=False):
    def handler(request):
        if request.url.path.endswith("/result"):
            return httpx.Response(200, json=result_body)
        if request.url.path.endswith("/api/v1/tasks/task-1"):
            return httpx.Response(200, json={"delivery": {"status": "ready"}})
        if request.url.host == "oss.test":
            if fail:
                raise httpx.ConnectError("oss unreachable")
            return httpx.Response(200, content=content)
        return httpx.Response(404)

    return VideoFlowClient(
        VideoFlowConfig("https://backend.test", "secret-token"),
        httpx.Client(transport=httpx.MockTransport(handler)),
    )


def test_download_receipt_keeps_identity_and_drops_the_signed_url(tmp_path):
    client = _download_client(
        {
            "taskId": "task-1",
            "assetId": "asset-1",
            "objectKey": "videos/task-1/attempt-1/result.mp4",
            "sizeBytes": 11,
            "downloadUrl": "https://oss.test/signed?Signature=abc",
        }
    )

    result = client.download_task_result("task-1", tmp_path)

    # 回执补大小与 hash，但不含会过期的下载签名 URL。
    assert result["sizeBytes"] == 11
    assert len(result["sha256"]) == 64
    assert result["objectKey"] == "videos/task-1/attempt-1/result.mp4"
    assert "downloadUrl" not in result
    assert "Signature" not in json.dumps(result)


def test_download_rejects_an_empty_artifact(tmp_path):
    client = _download_client(
        {
            "taskId": "task-1",
            "objectKey": "videos/task-1/attempt-1/result.mp4",
            "downloadUrl": "https://oss.test/signed",
        },
        content=b"",
    )

    with pytest.raises(ArtifactDownloadError) as error:
        client.download_task_result("task-1", tmp_path)

    assert error.value.code == "EMPTY_ARTIFACT"
    assert error.value.task_id == "task-1"
    # 失败不留下半成品，也不产生目标文件。
    assert list(tmp_path.iterdir()) == []


def test_download_rejects_a_size_mismatch(tmp_path):
    client = _download_client(
        {
            "taskId": "task-1",
            "objectKey": "videos/task-1/attempt-1/result.mp4",
            "sizeBytes": 999,
            "downloadUrl": "https://oss.test/signed",
        },
        content=b"video-bytes",
    )

    with pytest.raises(ArtifactDownloadError) as error:
        client.download_task_result("task-1", tmp_path)

    assert error.value.code == "ARTIFACT_SIZE_MISMATCH"
    assert list(tmp_path.iterdir()) == []


def test_failed_redownload_keeps_the_previous_successful_file(tmp_path):
    body = {
        "taskId": "task-1",
        "objectKey": "videos/task-1/attempt-1/result.mp4",
        "sizeBytes": 11,
        "downloadUrl": "https://oss.test/signed",
    }
    good = _download_client(body)
    first = good.download_task_result("task-1", tmp_path)
    published = Path(first["localPath"])

    # 第二次下载失败（OSS 不可达）：已发布的文件必须原样保留。
    broken = _download_client(body, fail=True)
    with pytest.raises(httpx.ConnectError):
        broken.download_task_result("task-1", tmp_path)

    assert published.read_bytes() == b"video-bytes"
    assert sorted(p.name for p in tmp_path.iterdir()) == [published.name]


def test_download_without_a_url_fails_with_a_clear_code(tmp_path):
    client = _download_client({"taskId": "task-1", "objectKey": "videos/task-1/attempt-1/result.mp4"})

    with pytest.raises(ArtifactDownloadError) as error:
        client.download_task_result("task-1", tmp_path)

    assert error.value.code == "MISSING_DOWNLOAD_URL"


def test_wait_walks_pending_running_archiving_ready_on_one_task():
    seen_paths = []
    summaries = [
        {"delivery": {"status": "not_started"}, "taskStatus": "pending"},
        {"delivery": {"status": "not_started"}, "taskStatus": "in_progress"},
        {"delivery": {"status": "archiving"}, "taskStatus": "in_progress"},
        {"delivery": {"status": "ready"}, "taskStatus": "completed"},
    ]

    def handler(request):
        seen_paths.append(request.url.path)
        return httpx.Response(200, json=summaries.pop(0))

    result = _wait_client(handler).wait_for_task("task-1", poll_seconds=0)

    assert result["delivery"]["status"] == "ready"
    # 全程只查询同一个 taskId，没有任何创建动作。
    assert seen_paths == ["/api/v1/tasks/task-1"] * 4


def test_wait_timeout_never_creates_a_task():
    methods = []

    def handler(request):
        methods.append(request.method)
        return httpx.Response(200, json={"delivery": {"status": "archiving"}})

    with pytest.raises(TaskWaitTimeout):
        _wait_client(handler).wait_for_task("task-1", timeout_seconds=0, poll_seconds=0)

    assert set(methods) == {"GET"}


def test_wait_reports_delivery_failed_after_archiving():
    summaries = [
        {"delivery": {"status": "archiving"}, "taskStatus": "in_progress"},
        {
            "delivery": {"status": "failed", "errorCode": "upload:ARTIFACT_UPLOAD_FAILED"},
            "taskStatus": "failed",
        },
    ]

    def handler(_request):
        return httpx.Response(200, json=summaries.pop(0))

    with pytest.raises(TaskDeliveryFailed) as error:
        _wait_client(handler).wait_for_task("task-1", poll_seconds=0)

    # 生成成功但归档失败：不能当成功，也不能让用户以为是 Provider 失败。
    assert error.value.error_code == "upload:ARTIFACT_UPLOAD_FAILED"
    assert error.value.task_id == "task-1"


def test_provider_failure_surfaces_the_reason_and_says_whether_retrying_helps():
    """Provider 的失败原因藏在 attempt 上，客户端不能只报一句"provider reported a failure"。

    真事：一段被判为"可能含真人"的视频，task.errorMsg 是空的、细节在 attempt.failureMessage 里，
    客户端于是只报"provider reported a failure"——用户既不知道原因，也不知道重试有没有用。
    """
    summary = {
        "delivery": {"status": "not_started"},
        "taskStatus": "failed",
        "errorMsg": None,
        "executionAttempts": [{
            "failureCode": "UNRETRYABLE_FAILURE",
            "failureMessage": 'Invalid request: {"error":{"code":"InputVideoSensitiveContentDetected.PrivacyInformation",'
                              '"message":"the input video may contain real person"}}',
        }],
    }

    with pytest.raises(TaskProviderFailed) as error:
        _wait_client(lambda _request: httpx.Response(200, json=summary)).wait_for_task("task-1", poll_seconds=0)

    message = str(error.value)
    assert error.value.task_id == "task-1"
    assert "真人" in message and "重试同一段不会成功" in message       # 可操作的那句
    assert "InputVideoSensitiveContentDetected" in message            # 平台原始原因
    assert "UNRETRYABLE_FAILURE" in message                            # 失败码


def test_backend_rejection_reports_the_reason_instead_of_the_status_code():
    """后端把拒绝原因写在 body 里（code / path / message），不能被 httpx 的 400 盖掉。

    真事：延长任务提交时 POST /api/v1/tasks 返回 400，客户端只显示
    "Client error '400 Bad Request'"，用户完全不知道服务器在拒什么。
    """
    def handler(_request):
        return httpx.Response(400, json={
            "code": "SUBMISSION_MEDIA_BINDINGS_MISMATCH",
            "path": "media",
            "message": "bindings do not match the preflight",
        })

    client = VideoFlowClient(
        VideoFlowConfig("https://backend.test", "secret-token"),
        httpx.Client(transport=httpx.MockTransport(handler)),
    )

    # 异常类型仍是 httpx.HTTPStatusError：调用方靠它区分 404/401/400。
    with pytest.raises(httpx.HTTPStatusError) as error:
        client._post_task("key-1", {"mode": "production"})

    message = str(error.value)
    assert "SUBMISSION_MEDIA_BINDINGS_MISMATCH" in message   # 服务器给的原因码
    assert "media" in message                                 # 出问题的字段
    assert "400" in message                                   # 仍然保留状态码
