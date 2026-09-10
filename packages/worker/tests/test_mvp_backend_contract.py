import json
import sys
import unittest
import os
from pathlib import Path
from typing import Any
import importlib

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from models import JobStatus, FailureType  # noqa: E402


def _new_executor() -> Any:
    """Create a fresh JobExecutor instance with a writable output dir for tests."""
    os.environ["COMFYUI_OUTPUT_DIR"] = str(Path("/tmp/video-worker-output"))

    import config

    config.get_settings.cache_clear()
    importlib.reload(config)

    import executor

    importlib.reload(executor)
    return executor.JobExecutor()


class MVPBackendContractTests(unittest.IsolatedAsyncioTestCase):
    """锁定旧 MVP 回写合同：只写 Task 支持字段。"""

    async def test_update_job_status_keeps_to_legacy_fields(self):
        calls = []

        # 当前终端环境注入了 SOCKS 代理，避免影响 httpx 测试客户端初始化
        for key in [
            "http_proxy",
            "https_proxy",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "all_proxy",
            "ALL_PROXY",
        ]:
            os.environ.pop(key, None)

        async def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            return httpx.Response(200, json={"ok": True})

        transport = httpx.MockTransport(handler)
        executor = _new_executor()
        await executor.client.aclose()
        executor.client = httpx.AsyncClient(
            transport=transport,
            base_url="https://backend.local",
        )
        executor.backend_url = "https://backend.local"

        result = await executor.update_job_status(
            "job-completed-1",
            JobStatus.COMPLETED,
            provider_task_id="provider-abc",
            actual_cost=0.58,
            cost_status_value="confirmed",
            result={"video_url": "https://oss.local/videos/job-completed-1.mp4"},
        )
        await executor.client.aclose()

        assert result is True

        request = calls[0]
        payload = json.loads(request.content)

        assert request.url.path == "/api/tasks/job-completed-1"
        assert request.method == "PATCH"
        assert payload["status"] == "completed"
        assert payload["videoUrl"] == "https://oss.local/videos/job-completed-1.mp4"
        assert payload["cost"] == 0.58
        assert "completedAt" in payload
        assert "errorMsg" not in payload
        assert "provider_task_id" not in payload
        assert "cost_status" not in payload
        assert "provider_usage" not in payload

    async def test_failed_update_maps_to_legacy_error_msg_without_new_fields(self):
        calls = []

        for key in [
            "http_proxy",
            "https_proxy",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "all_proxy",
            "ALL_PROXY",
        ]:
            os.environ.pop(key, None)

        async def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            return httpx.Response(200, json={"ok": True})

        transport = httpx.MockTransport(handler)
        executor = _new_executor()
        await executor.client.aclose()
        executor.client = httpx.AsyncClient(
            transport=transport,
            base_url="https://backend.local",
        )
        executor.backend_url = "https://backend.local"

        result = await executor.update_job_status(
            "job-failed-1",
            JobStatus.FAILED,
            failure_type=FailureType.CONTENT_POLICY,
        )
        await executor.client.aclose()

        assert result is True

        payload = json.loads(calls[0].content)
        assert payload["status"] == "failed"
        assert payload["errorMsg"] == "content_policy: task failed"
        assert "videoUrl" not in payload
        assert "provider_usage" not in payload
        assert "completedAt" in payload
