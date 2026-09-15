import subprocess
import json
import sys
from pathlib import Path

import httpx
import pytest
from starlette.testclient import TestClient

from fake_provider import FakeProviderState, app, create_app


WORKER_ROOT = Path(__file__).resolve().parents[2] / "packages" / "worker"
if str(WORKER_ROOT) not in sys.path:
    sys.path.insert(0, str(WORKER_ROOT))

from providers.seedance_execution_policy import compile_seedance_payload, workflow_execution_digest  # noqa: E402


CONTRACT = json.loads((WORKER_ROOT / "resources" / "seedance-workflows.v2.json").read_text())
CONTRACT_DIGEST = workflow_execution_digest(CONTRACT)


@pytest.mark.asyncio
async def test_fake_provider_counts_create_and_returns_same_task():
    state = FakeProviderState()
    transport = httpx.ASGITransport(app=create_app(state))

    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://fake-provider.test",
    ) as client:
        created = await client.post(
            "/api/v3/contents/generations/tasks",
            json={
                "model": "test-model",
                "content": [{"type": "text", "text": "cross-package scenario"}],
            },
        )
        task_id = created.json()["id"]
        fetched = await client.get(
            f"/api/v3/contents/generations/tasks/{task_id}",
        )
        stats = await client.get("/__test__/stats")

    assert fetched.json()["id"] == task_id
    assert fetched.json()["status"] == "succeeded"
    assert stats.json() == {
        "createCount": 1,
        "createCountsByKey": {"cross-package scenario": 1},
        "taskIds": [task_id],
        "lastCreatePayload": {
            "model": "test-model",
            "content": [{"type": "text", "text": "cross-package scenario"}],
        },
    }


@pytest.mark.asyncio
async def test_frozen_execution_plan_compiles_and_reaches_fake_provider_unchanged(monkeypatch):
    monkeypatch.chdir(WORKER_ROOT)
    from providers.seedance_adapter import SeedanceAdapter

    state = FakeProviderState()
    transport = httpx.ASGITransport(app=create_app(state))
    adapter = SeedanceAdapter.__new__(SeedanceAdapter)
    adapter.api_key = ""
    adapter.base_url = "http://fake-provider.test/api/v3"
    adapter.client = httpx.AsyncClient(transport=transport)

    frozen_params = {
        "workflow_key": "seedance.text-to-video.v1",
        "workflow_version": CONTRACT["contractRevision"],
        "contract_digest": CONTRACT_DIGEST,
        "model": CONTRACT["model"]["id"],
        "prompt": "雨后的街道，镜头缓慢推进",
        "media_urls": [],
        "duration": 4,
        "ratio": "16:9",
        "resolution": "720p",
        "generate_audio": True,
        "watermark": False,
        "output_format": "mp4",
    }
    expected_payload = compile_seedance_payload(frozen_params)

    try:
        result = await adapter.create_task({"_compiled_payload": expected_payload})
        async with httpx.AsyncClient(transport=transport, base_url="http://fake-provider.test") as client:
            stats = (await client.get("/__test__/stats")).json()
    finally:
        await adapter.client.aclose()

    assert result["task_id"]
    assert stats["createCount"] == 1
    assert stats["lastCreatePayload"] == expected_payload


@pytest.mark.asyncio
async def test_rejected_frozen_plan_never_calls_fake_provider_create(monkeypatch):
    state = FakeProviderState()
    params = {
        "workflow_key": "seedance.text-to-video.v1",
        "workflow_version": CONTRACT["contractRevision"],
        "contract_digest": CONTRACT_DIGEST,
        "model": CONTRACT["model"]["id"],
        "prompt": "invalid duration",
        "media_urls": [],
        "duration": 31,
        "ratio": "16:9",
        "resolution": "720p",
        "generate_audio": False,
        "watermark": False,
        "output_format": "mp4",
    }

    with pytest.raises(ValueError, match="duration"):
        compile_seedance_payload(params)

    assert state.create_count == 0


@pytest.mark.asyncio
async def test_fake_provider_counts_for_multiple_create_modes_and_usage_modes():
    state = FakeProviderState(create_mode="normal", usage_mode="valid")
    transport = httpx.ASGITransport(app=create_app(state))

    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://fake-provider.test",
    ) as client:
        create_normal = await client.post(
            "/api/v3/contents/generations/tasks",
            json={"model": "test-model", "content": [{"type": "text", "text": "normal"}]},
        )
        assert create_normal.status_code == 200
        normal_id = create_normal.json()["id"]

        create_missing = await client.get("/__test__/create-mode", params={"mode": "missing_id"})
        assert create_missing.status_code == 200
        create_missing_task = await client.post(
            "/api/v3/contents/generations/tasks",
            json={"model": "test-model", "content": [{"type": "text", "text": "missing-id"}]},
        )
        assert create_missing_task.status_code == 200
        assert create_missing_task.json() == {}

        create_status = await client.get("/__test__/create-status")
        assert create_status.json()["createMode"] == "missing_id"

        missing_usage = await client.get("/__test__/usage-mode", params={"mode": "missing"})
        assert missing_usage.status_code == 200

        task = await client.get(
            f"/api/v3/contents/generations/tasks/{normal_id}",
        )
        assert task.status_code == 200
        assert task.json()["usage"] == {"completion_tokens": 1000}

        stats = await client.get("/__test__/stats")
        body = stats.json()

        # reset 后再检查，确保重置功能可用。
        reset = await client.post("/__test__/reset")
        assert reset.status_code == 200
        assert reset.json() == {"ok": True}

    assert body["createCount"] == 2
    assert body["createCountsByKey"]["normal"] == 1
    assert body["createCountsByKey"]["missing-id"] == 1

    async with httpx.AsyncClient(transport=transport, base_url="http://fake-provider.test") as client:
        stats_after_reset = await client.get("/__test__/stats")
    assert stats_after_reset.json()["createCount"] == 0
    assert stats_after_reset.json()["createCountsByKey"] == {}
    assert stats_after_reset.json()["lastCreatePayload"] is None


@pytest.mark.asyncio
async def test_fake_provider_fault_does_not_increment_create_count():
    state = FakeProviderState(create_status=500)
    transport = httpx.ASGITransport(app=create_app(state))

    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://fake-provider.test",
    ) as client:
        response = await client.post(
            "/api/v3/contents/generations/tasks",
            json={"model": "test-model", "content": []},
        )
        stats = await client.get("/__test__/stats")

    assert response.status_code == 500
    assert stats.json()["createCount"] == 0


@pytest.mark.asyncio
async def test_fake_provider_usage_modes_return_expected_payload():
    state = FakeProviderState()
    transport = httpx.ASGITransport(app=create_app(state))

    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://fake-provider.test",
    ) as client:
        await client.get("/__test__/usage-mode", params={"mode": "invalid"})
        created = await client.post(
            "/api/v3/contents/generations/tasks",
            json={"content": [{"type": "text", "text": "usage-invalid"}]},
        )
        task_id = created.json()["id"]
        task = await client.get(f"/api/v3/contents/generations/tasks/{task_id}")
        assert task.status_code == 200
        assert isinstance(task.json().get("usage", {}).get("completion_tokens"), str)

        await client.get("/__test__/usage-mode", params={"mode": "negative"})
        created2 = await client.post(
            "/api/v3/contents/generations/tasks",
            json={"content": [{"type": "text", "text": "usage-negative"}]},
        )
        task2_id = created2.json()["id"]
        task2 = await client.get(f"/api/v3/contents/generations/tasks/{task2_id}")
        assert task2.status_code == 200
        assert task2.json().get("usage", {}).get("completion_tokens") == -10

        await client.get("/__test__/usage-mode", params={"mode": "missing"})
        created3 = await client.post(
            "/api/v3/contents/generations/tasks",
            json={"content": [{"type": "text", "text": "usage-missing"}]},
        )
        task3_id = created3.json()["id"]
        task3 = await client.get(f"/api/v3/contents/generations/tasks/{task3_id}")
        assert task3.json().get("usage") == {}

        await client.get("/__test__/usage-mode", params={"mode": "valid"})
        created4 = await client.post(
            "/api/v3/contents/generations/tasks",
            json={"content": [{"type": "text", "text": "usage-valid"}]},
        )
        task4_id = created4.json()["id"]
        task4 = await client.get(f"/api/v3/contents/generations/tasks/{task4_id}")
        assert task4.json().get("usage", {}).get("completion_tokens") == 1000


def test_fake_provider_serves_a_decodable_contract_clip():
    """归档链路要真的下载到文件：没有可解码的 fixture 就只能测到一半。"""
    fixture = Path(__file__).resolve().parent / "fixtures" / "contract-clip.mp4"
    assert fixture.is_file(), "contract clip fixture missing"

    with TestClient(app) as client:
        response = client.get("/__test__/videos/anything.mp4")

    assert response.status_code == 200
    assert response.headers["content-type"] == "video/mp4"
    assert len(response.content) > 0

    # 用 ffprobe 校验真的能解码，而不是一段随便的字节。
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "stream=codec_name", "-of", "csv=p=0", "-"],
        input=response.content,
        capture_output=True,
    )
    assert probe.returncode == 0, probe.stderr.decode()
    assert b"h264" in probe.stdout


def test_fake_oss_round_trip_preserves_upload_metadata():
    state = FakeProviderState()
    local_app = create_app(state)
    body = b"contract-image-bytes"

    with TestClient(local_app) as client:
        uploaded = client.put(
            "/acceptance/input/reference.png",
            content=body,
            headers={
                "Content-Type": "image/png",
                "x-oss-meta-sha256": "a" * 64,
            },
        )
        inspected = client.head("/acceptance/input/reference.png")
        downloaded = client.get("/acceptance/input/reference.png")

    assert uploaded.status_code == 200
    assert inspected.status_code == 200
    assert inspected.headers["content-length"] == str(len(body))
    assert inspected.headers["content-type"] == "image/png"
    assert inspected.headers["x-oss-meta-sha256"] == "a" * 64
    assert downloaded.content == body
    assert downloaded.headers["content-type"] == "image/png"
