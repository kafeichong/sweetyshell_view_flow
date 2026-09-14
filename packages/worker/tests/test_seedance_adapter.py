import json

import httpx
import pytest

from providers.seedance_adapter import (
    ProviderSubmissionUncertainError,
    SeedanceAdapter,
    is_submission_uncertain,
)


def _adapter_with_response(response: httpx.Response) -> SeedanceAdapter:
    async def handler(_request: httpx.Request) -> httpx.Response:
        return response

    adapter = SeedanceAdapter(api_key="test-only")
    adapter.client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return adapter


def _adapter_with_transport(transport: httpx.AsyncBaseTransport) -> SeedanceAdapter:
    adapter = SeedanceAdapter(api_key="test-only")
    adapter.client = httpx.AsyncClient(transport=transport)
    return adapter


@pytest.mark.parametrize(
    "status_code,has_task_id",
    [
        (None, False),  # 连接中断：请求可能已到达 Provider
        (500, False),  # 服务端可能已建好任务，只是响应没回来
        (200, False),  # 2xx 但没有任务 ID，无法证明提交成功
        (302, False),  # 非 2xx/非明确拒绝，同样不可判定
    ],
)
def test_uncertain_submission_is_not_retryable(status_code, has_task_id):
    assert is_submission_uncertain(status_code, has_task_id) is True


@pytest.mark.parametrize(
    "status_code,has_task_id",
    [
        (200, True),  # 拿到 ID 就是确定成功
        (400, False),  # Provider 明确拒绝：确定没有创建任务
        (401, False),
        (403, False),
        (429, False),
    ],
)
def test_definite_outcomes_are_not_uncertain(status_code, has_task_id):
    assert is_submission_uncertain(status_code, has_task_id) is False


@pytest.mark.asyncio
async def test_create_task_raises_uncertain_on_server_error():
    adapter = _adapter_with_response(httpx.Response(500, text="upstream unavailable"))
    try:
        with pytest.raises(ProviderSubmissionUncertainError):
            await adapter.create_task({"prompt": "product"})
    finally:
        await adapter.client.aclose()


@pytest.mark.asyncio
async def test_create_task_raises_uncertain_when_success_response_has_no_id():
    adapter = _adapter_with_response(httpx.Response(200, json={"status": "submitted"}))
    try:
        with pytest.raises(ProviderSubmissionUncertainError):
            await adapter.create_task({"prompt": "product"})
    finally:
        await adapter.client.aclose()


@pytest.mark.asyncio
async def test_create_task_raises_uncertain_when_response_cannot_be_parsed():
    adapter = _adapter_with_response(
        httpx.Response(200, text="<html>gateway</html>")
    )
    try:
        with pytest.raises(ProviderSubmissionUncertainError):
            await adapter.create_task({"prompt": "product"})
    finally:
        await adapter.client.aclose()


@pytest.mark.asyncio
async def test_create_task_raises_uncertain_on_connection_error():
    async def handler(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection reset")

    adapter = _adapter_with_transport(httpx.MockTransport(handler))
    try:
        with pytest.raises(ProviderSubmissionUncertainError):
            await adapter.create_task({"prompt": "product"})
    finally:
        await adapter.client.aclose()


@pytest.mark.asyncio
async def test_create_task_keeps_explicit_rejection_reason():
    adapter = _adapter_with_response(
        httpx.Response(429, text="rate limit exceeded")
    )
    try:
        with pytest.raises(Exception) as error:
            await adapter.create_task({"prompt": "product"})
    finally:
        await adapter.client.aclose()

    # 明确拒绝必须保留原因且不是"不确定"：确定没有创建任务。
    assert not isinstance(error.value, ProviderSubmissionUncertainError)
    assert "rate limit" in str(error.value).lower()


@pytest.mark.asyncio
async def test_uncertain_error_message_does_not_echo_response_body():
    adapter = _adapter_with_response(
        httpx.Response(200, json={"echo": "signed-url", "secret": "ark-key"})
    )
    try:
        with pytest.raises(ProviderSubmissionUncertainError) as error:
            await adapter.create_task({"prompt": "product"})
    finally:
        await adapter.client.aclose()

    # 异常消息会写入 DB 的 failure_message，不能顺带泄漏响应内容。
    assert "signed-url" not in str(error.value)
    assert "ark-key" not in str(error.value)


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


@pytest.mark.asyncio
async def test_create_task_payload_transports_compiler_output_without_rewriting_it():
    requests = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"id": "fake-provider-task"})

    payload = {
        "model": "test-model",
        "content": [
            {"type": "text", "text": "edit @video1"},
            {"type": "video_url", "video_url": {"url": "https://example.invalid/input.mp4"}, "role": "reference_video"},
        ],
        "generate_audio": True,
        "ratio": "adaptive",
        "duration": -1,
        "watermark": False,
        "resolution": "720p",
        "omni_reference_task_type": "edit",
        "output_format": "mov",
    }
    adapter = SeedanceAdapter(api_key="test-only")
    await adapter.client.aclose()
    adapter.client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        result = await adapter.create_task_payload(payload)
    finally:
        await adapter.client.aclose()

    assert result["task_id"] == "fake-provider-task"
    assert json.loads(requests[0].content) == payload


@pytest.mark.asyncio
async def test_missing_api_key_omits_the_authorization_header():
    adapter = SeedanceAdapter(api_key="")

    # 空密钥不能拼成 `Bearer `：那是非法头，httpx 会拒绝，
    # 提交会被误报成"结果不确定"而不是"没配密钥"。
    assert "Authorization" not in adapter._build_headers()
    assert adapter._build_headers()["Content-Type"] == "application/json"
    await adapter.client.aclose()


@pytest.mark.asyncio
async def test_api_key_produces_a_bearer_header():
    adapter = SeedanceAdapter(api_key="  ark-secret  ")

    assert adapter._build_headers()["Authorization"] == "Bearer ark-secret"
    await adapter.client.aclose()


@pytest.mark.asyncio
async def test_create_task_works_without_an_api_key():
    requests = []

    async def handler(request):
        requests.append(request)
        return httpx.Response(200, json={"id": "fake-task"})

    adapter = SeedanceAdapter(api_key="")
    await adapter.client.aclose()
    adapter.client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        result = await adapter.create_task({"prompt": "contract"})
    finally:
        await adapter.client.aclose()

    assert result["task_id"] == "fake-task"
    assert "authorization" not in requests[0].headers
