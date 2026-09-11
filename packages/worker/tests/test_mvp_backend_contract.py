import json
import sys
import unittest
import os
from pathlib import Path
from typing import Any
import importlib
from datetime import datetime, timezone
from unittest.mock import patch

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


class WorkerBackendContractTests(unittest.IsolatedAsyncioTestCase):
    """锁定新版 Worker 回写合同：任务状态与执行尝试字段。"""

    async def test_empty_claim_response_returns_no_jobs_without_error_log(self):
        async def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, content=b"")

        executor = _new_executor()
        await executor.client.aclose()
        executor.client = httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
            base_url="https://backend.local",
        )
        executor.backend_url = "https://backend.local"

        with patch("builtins.print") as print_mock:
            jobs = await executor.fetch_pending_jobs()
        await executor.client.aclose()

        self.assertEqual(jobs, [])
        print_mock.assert_not_called()

    async def test_update_job_status_writes_attempt_contract(self):
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

        started_at = datetime(2026, 9, 10, 10, 0, tzinfo=timezone.utc)
        finished_at = datetime(2026, 9, 10, 10, 3, tzinfo=timezone.utc)
        result = await executor.update_job_status(
            "job-completed-1",
            JobStatus.COMPLETED,
            attempt_id="attempt-1",
            attempt_model="doubao-seedance-2-5-260628",
            provider_task_id="provider-abc",
            actual_cost=0.58,
            cost_status_value="confirmed",
            started_at=started_at,
            finished_at=finished_at,
        )
        await executor.client.aclose()

        assert result is True

        request = calls[0]
        payload = json.loads(request.content)

        assert request.url.path == "/api/tasks/job-completed-1"
        assert request.method == "PATCH"
        assert payload["status"] == "completed"
        assert payload["cost"] == 0.58
        assert payload["attemptId"] == "attempt-1"
        assert payload["attemptStatus"] == "completed"
        assert payload["actualCostCny"] == 0.58
        assert payload["costStatus"] == "usage_calculated"
        assert "completedAt" in payload
        assert payload["providerTaskId"] == "provider-abc"
        assert payload["attemptModel"] == "doubao-seedance-2-5-260628"
        assert payload["startedAt"] == "2026-09-10T10:00:00+00:00"
        assert payload["finishedAt"] == "2026-09-10T10:03:00+00:00"
        assert "errorMsg" not in payload
        assert "provider_usage" not in payload

    async def test_failed_update_writes_attempt_reason_fields(self):
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
            attempt_id="attempt-1",
            failure_type=FailureType.CONTENT_POLICY,
            failure_message="policy reject",
        )
        await executor.client.aclose()

        assert result is True

        payload = json.loads(calls[0].content)
        assert payload["status"] == "failed"
        assert payload["attemptId"] == "attempt-1"
        assert payload["attemptStatus"] == "failed"
        assert payload["failureType"] == "content_policy"
        assert payload["failureMessage"] == "policy reject"
        assert "errorMsg" not in payload
        assert "completedAt" in payload

    async def test_update_without_attempt_id_does_not_write_attempt_fields(self):
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

        executor = _new_executor()
        await executor.client.aclose()
        executor.client = httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
            base_url="https://backend.local",
        )
        executor.backend_url = "https://backend.local"

        result = await executor.update_job_status(
            "job-without-attempt",
            JobStatus.RUNNING,
            provider_task_id="provider-should-not-leak",
            actual_cost=0.58,
            cost_status_value="confirmed",
        )
        await executor.client.aclose()

        assert result is True
        payload = json.loads(calls[0].content)
        assert payload["status"] == "running"
        assert payload["cost"] == 0.58
        assert "attemptStatus" not in payload
        assert "providerTaskId" not in payload
        assert "actualCostCny" not in payload
        assert "costStatus" not in payload
