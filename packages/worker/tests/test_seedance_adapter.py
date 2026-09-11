import json

import httpx
import pytest

from providers.seedance_adapter import SeedanceAdapter


@pytest.mark.asyncio
async def test_create_task_forwards_frozen_resolution():
    requests = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"id": "fake-provider-task"})

    adapter = SeedanceAdapter(api_key="test-only")
    await adapter.client.aclose()
    adapter.client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        await adapter.create_task(
            {
                "prompt": "product",
                "model": "test-model",
                "duration": 5,
                "ratio": "16:9",
                "resolution": "test-resolution",
            }
        )
    finally:
        await adapter.client.aclose()

    assert json.loads(requests[0].content)["resolution"] == "test-resolution"
