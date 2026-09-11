import httpx
import pytest

from fake_provider import FakeProviderState, create_app


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
            json={"model": "test-model", "content": []},
        )
        task_id = created.json()["id"]
        fetched = await client.get(
            f"/api/v3/contents/generations/tasks/{task_id}",
        )
        stats = await client.get("/__test__/stats")

    assert fetched.json()["id"] == task_id
    assert fetched.json()["status"] == "succeeded"
    assert stats.json() == {"createCount": 1, "taskIds": [task_id]}


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
