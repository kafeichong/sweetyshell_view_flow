import subprocess
from pathlib import Path

import httpx
import pytest
from starlette.testclient import TestClient

from fake_provider import FakeProviderState, app, create_app


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
    }


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
        assert task.json()["usage"] == {"total_tokens": 1000}

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
        assert isinstance(task.json().get("usage", {}).get("total_tokens"), str)

        await client.get("/__test__/usage-mode", params={"mode": "negative"})
        created2 = await client.post(
            "/api/v3/contents/generations/tasks",
            json={"content": [{"type": "text", "text": "usage-negative"}]},
        )
        task2_id = created2.json()["id"]
        task2 = await client.get(f"/api/v3/contents/generations/tasks/{task2_id}")
        assert task2.status_code == 200
        assert task2.json().get("usage", {}).get("total_tokens") == -10

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
        assert task4.json().get("usage", {}).get("total_tokens") == 1000


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
