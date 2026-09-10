import httpx
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
    assert requests[0].headers["idempotency-key"] == "key-1"
    assert requests[0].json()["mode"] == "preview"
    assert "secret-token" not in str(result)


def test_stable_idempotency_key_is_repeatable():
    key_a = VideoFlowClient.stable_idempotency_key("prompt", b"image")
    key_b = VideoFlowClient.stable_idempotency_key("prompt", b"image")
    assert key_a == key_b
