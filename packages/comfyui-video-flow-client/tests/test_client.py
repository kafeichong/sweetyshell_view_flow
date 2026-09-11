import httpx
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from client import VideoFlowClient
from config import VideoFlowConfig


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
