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
    # 按关联 key 计数：跨包用例要断言"同一个意图只创建一次"。
    assert stats.json() == {
        "createCount": 1,
        "createCountsByKey": {"cross-package scenario": 1},
        "taskIds": [task_id],
    }


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
