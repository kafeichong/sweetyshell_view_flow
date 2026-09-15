import asyncio
import json
import os
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from models import Job, ProviderTaskStatus
from artifact_delivery import artifact_object_key
from providers.seedance_execution_policy import workflow_execution_digest


_WORKFLOW_CONTRACT = json.loads((Path(__file__).resolve().parents[1] / "resources" / "seedance-workflows.v2.json").read_text())
_WORKFLOW_CONTRACT_DIGEST = workflow_execution_digest(_WORKFLOW_CONTRACT)


def approved_execution_plan():
    return {
        "specVersion": "test-v1",
        "pricingVersion": "test-price-v1",
        "reserveCny": "2.000000",
        "model": "doubao-seedance-2-5-260628",
        "prompt": "a product video",
        "imageAssetId": "asset-test-1",
        "duration": 5,
        "ratio": "16:9",
        "resolution": "1080p",
        "generateAudio": False,
        "watermark": True,
    }


class _FakeOssUploader:
    """最小 OSS 替身：记录上传，并让 HEAD 返回真实对象大小。

    归档流程要求"上传后 HEAD 校验通过才登记"，所以替身必须能回答 HEAD，
    否则测不到真实路径。
    """

    def __init__(self, bucket_name="test-bucket"):
        self.uploaded: list[tuple[str, int]] = []
        self.bucket_name = bucket_name

    def upload(self, local_path, object_key):
        self.uploaded.append((object_key, os.path.getsize(local_path)))
        return f"https://oss.test/{object_key}?signature=test"

    def head_object(self, object_key):
        for key, size in self.uploaded:
            if key == object_key:
                return SimpleNamespace(content_length=size)
        return None


class _RecordingClient:
    """记录 Worker 发往 Backend 的请求体，用来断言回写内容。"""

    def __init__(self):
        self.calls: list[dict] = []

    async def patch(self, url, json=None, headers=None):
        self.calls.append({"url": url, "json": json, "method": "PATCH"})
        return SimpleNamespace(raise_for_status=lambda: None)

    async def post(self, url, json=None, headers=None):
        # 产物登记也走这个客户端，归档链路才完整。
        self.calls.append({"url": url, "json": json, "method": "POST"})
        return SimpleNamespace(
            raise_for_status=lambda: None,
            json=lambda: {"assetId": "asset-1", "objectKey": (json or {}).get("objectKey")},
        )


class ProviderSubmissionRecoveryTests(unittest.TestCase):
    def test_recovery_write_failure_blocks_new_claims_persistently(self):
        import executor as executor_module

        payload = {
            "id": "job-recovery-write-failure",
            "status": "submitted",
            "created_by": "alice",
            "prompt": "product",
            "created_at": "2026-09-10T00:00:00+00:00",
            "provider_profile": "seedance-main",
            "attempt_id": "attempt-recovery-write-failure",
            "attempt_status": "submitted",
        }
        response = SimpleNamespace(
            content=b"{}",
            raise_for_status=lambda: None,
            json=lambda: [payload],
        )
        with tempfile.TemporaryDirectory() as directory:
            job_executor = executor_module.JobExecutor.__new__(executor_module.JobExecutor)
            job_executor.output_dir = Path(directory)
            job_executor.backend_url = "http://backend.test"
            job_executor.client = SimpleNamespace(
                get=AsyncMock(return_value=response),
                post=AsyncMock(),
            )
            job_executor.update_job_status = AsyncMock(return_value=False)
            job_executor._submission_blocked = False

            awaitable = job_executor.fetch_inflight_jobs()
            asyncio.run(awaitable)

            self.assertTrue(job_executor._submission_blocked)
            marker = Path(directory) / ".video-flow-journal" / "SUBMISSIONS_BLOCKED"
            self.assertTrue(marker.exists())
            jobs = asyncio.run(job_executor.fetch_pending_jobs())

        self.assertEqual(jobs, [])
        job_executor.client.post.assert_not_awaited()

    def test_backend_write_failure_persists_quarantine_and_never_recreates(self):
        import executor as executor_module

        adapter = SimpleNamespace(
            default_model="test-model",
            create_task=AsyncMock(return_value={"task_id": "provider-write-failed"}),
        )
        job = Job(
            id="job-write-failure",
            status="submitted",
            created_by="alice",
            prompt="product",
            created_at="2026-09-10T00:00:00+00:00",
            provider_profile="seedance-main",
            attempt_id="attempt-write-failure",
            execution_plan=approved_execution_plan(),
        )
        settings = SimpleNamespace(
            comfyui_enabled=False,
            running_job_timeout_minutes=10,
            task_status_check_interval=0,
        )

        with tempfile.TemporaryDirectory() as directory:
            job_executor = executor_module.JobExecutor.__new__(executor_module.JobExecutor)
            job_executor.output_dir = Path(directory)
            job_executor.adapters = {"seedance": adapter}
            job_executor.resolve_asset_url = AsyncMock(return_value="https://oss.test/input")
            # claim marker succeeds, providerTaskId回写失败，requires_review回写 succeeds
            job_executor.update_job_status = AsyncMock(side_effect=[True, False, True])

            with patch.object(executor_module, "settings", settings):
                asyncio.run(job_executor.execute_job(job))

            marker = Path(directory) / ".video-flow-journal" / "SUBMISSIONS_BLOCKED"
            self.assertTrue(marker.exists())
            self.assertEqual(
                job_executor.update_job_status.await_args_list[-1].kwargs["failure_code"],
                "PAYLOAD_TIMEOUT",
            )

            # 模拟重启：新执行器只依赖磁盘阻断标记，不依赖内存状态。
            restarted = executor_module.JobExecutor.__new__(executor_module.JobExecutor)
            restarted.output_dir = Path(directory)
            restarted._submission_blocked = restarted._submission_block_marker().exists()
            restarted.adapters = {"seedance": adapter}
            restarted.resolve_asset_url = AsyncMock(return_value="https://oss.test/input")
            restarted.update_job_status = AsyncMock(return_value=True)
            asyncio.run(restarted.execute_job(job))

            adapter.create_task.assert_awaited_once()
            self.assertEqual(
                restarted.update_job_status.await_args.kwargs["failure_code"],
                "SUBMISSION_JOURNAL_BLOCKED",
            )

    def test_journal_failure_quarantines_submission_and_blocks_followup(self):
        import executor as executor_module

        adapter = SimpleNamespace(
            default_model="test-model",
            create_task=AsyncMock(return_value={"task_id": "provider-unsafe"}),
        )
        job_executor = executor_module.JobExecutor.__new__(executor_module.JobExecutor)
        job_executor.adapters = {"seedance": adapter}
        job_executor.update_job_status = AsyncMock(return_value=True)
        job_executor.resolve_asset_url = AsyncMock(return_value="https://oss.test/input")
        job_executor.output_dir = Path(tempfile.gettempdir())
        job_executor._append_submission_journal = AsyncMock(
            side_effect=OSError("journal unavailable")
        )

        job = Job(
            id="job-journal-failure",
            status="submitted",
            created_by="alice",
            prompt="product",
            created_at="2026-09-10T00:00:00+00:00",
            provider_profile="seedance-main",
            attempt_id="attempt-journal-failure",
            execution_plan=approved_execution_plan(),
        )
        settings = SimpleNamespace(
            comfyui_enabled=False,
            running_job_timeout_minutes=10,
            task_status_check_interval=0,
        )
        with patch.object(executor_module, "settings", settings):
            asyncio.run(job_executor.execute_job(job))

        adapter.create_task.assert_awaited_once()
        first_failure = job_executor.update_job_status.await_args_list[-1]
        self.assertEqual(first_failure.kwargs["failure_code"], "JOURNAL_WRITE_FAILED")
        self.assertEqual(first_failure.kwargs["task_status"], "requires_review")
        self.assertTrue(job_executor._submission_blocked)

        job_executor.update_job_status.reset_mock()
        asyncio.run(job_executor.execute_job(job))
        adapter.create_task.assert_awaited_once()
        blocked = job_executor.update_job_status.await_args
        self.assertEqual(blocked.kwargs["failure_code"], "SUBMISSION_JOURNAL_BLOCKED")

    def test_submission_journal_persists_safe_identifiers_without_secrets(self):
        import json
        import executor as executor_module

        job_executor = executor_module.JobExecutor.__new__(executor_module.JobExecutor)
        with tempfile.TemporaryDirectory() as directory:
            job_executor.output_dir = Path(directory)
            asyncio.run(
                job_executor._append_submission_journal(
                    task_id="task-1",
                    attempt_id="attempt-1",
                    provider_task_id="provider-1",
                    stage="provider_accepted",
                )
            )

            journal = Path(directory) / ".video-flow-journal" / "submissions.jsonl"
            record = json.loads(journal.read_text().strip())

        self.assertEqual(record["taskId"], "task-1")
        self.assertEqual(record["attemptId"], "attempt-1")
        self.assertEqual(record["providerTaskId"], "provider-1")
        self.assertEqual(record["stage"], "provider_accepted")
        self.assertNotIn("token", record)
        self.assertNotIn("prompt", record)
        self.assertNotIn("url", record)

    def test_new_submission_without_execution_plan_is_quarantined_before_provider(self):
        import executor as executor_module

        adapter = SimpleNamespace(
            default_model="should-not-be-used",
            create_task=AsyncMock(return_value={"task_id": "must-not-exist"}),
        )
        job_executor = executor_module.JobExecutor.__new__(executor_module.JobExecutor)
        job_executor.adapters = {"seedance": adapter}
        job_executor.update_job_status = AsyncMock(return_value=True)

        job = Job(
            id="job-no-plan-1",
            status="submitted",
            created_by="alice",
            prompt="legacy unapproved request",
            created_at="2026-09-10T00:00:00+00:00",
            provider_profile="seedance-main",
            attempt_id="attempt-no-plan-1",
        )

        settings = SimpleNamespace(
            comfyui_enabled=False,
            running_job_timeout_minutes=10,
            task_status_check_interval=0,
        )
        with patch.object(executor_module, "settings", settings):
            asyncio.run(job_executor.execute_job(job))

        adapter.create_task.assert_not_awaited()
        update = job_executor.update_job_status.await_args
        self.assertEqual(update.kwargs["attempt_status"], "requires_review")
        self.assertEqual(update.kwargs["failure_code"], "MISSING_EXECUTION_PLAN")
        self.assertEqual(update.kwargs["task_status"], "requires_review")

    def test_completed_task_persists_object_key_instead_of_expiring_signed_url(self):
        import executor as executor_module

        async def download_video(_url, output_path):
            Path(output_path).write_bytes(b"video")

        adapter = SimpleNamespace(
            default_model="doubao-seedance-2-5-260628",
            create_task=AsyncMock(return_value={"task_id": "provider-task-output"}),
            poll_until_complete=AsyncMock(
                return_value=ProviderTaskStatus(
                    id="provider-task-output",
                    status="completed",
                    result_url="https://provider.test/video.mp4",
                )
            ),
            download_video=AsyncMock(side_effect=download_video),
            calculate_actual_cost=lambda _usage: None,
            pricing_version="seedance-token-v1",
            classify_failure=lambda _message: executor_module.FailureType.UNKNOWN,
        )
        job = Job(
            id="job-output-1",
            status="pending",
            created_by="actor-a",
            prompt="a product video",
            created_at="2026-09-10T00:00:00+00:00",
            provider_profile="seedance-main",
            attempt_id="attempt-output-1",
            execution_plan=approved_execution_plan(),
        )
        with tempfile.TemporaryDirectory() as directory:
            job_executor = executor_module.JobExecutor.__new__(executor_module.JobExecutor)
            job_executor.adapters = {"seedance": adapter}
            job_executor.update_job_status = AsyncMock(return_value=True)
            job_executor.report_provider_outcome = AsyncMock(return_value=True)
            job_executor.create_asset = AsyncMock(return_value=True)
            job_executor.resolve_asset_url = AsyncMock(
                return_value="https://oss.test/input-signed-url"
            )
            job_executor.output_dir = Path(directory)
            job_executor.oss_uploader = _FakeOssUploader()
            job_executor.backend_url = "http://backend.test"
            job_executor.client = _RecordingClient()
            settings = SimpleNamespace(
                comfyui_enabled=False,
                running_job_timeout_minutes=10,
                task_status_check_interval=0,
                video_flow_audit_dir="",
            )

            with patch.object(executor_module, "settings", settings):
                asyncio.run(job_executor.execute_job(job))

        expected_key = artifact_object_key(
            "job-output-1", "attempt-output-1", job.createdAt
        )
        # 上传与登记都落在同一个稳定 key 上：重跑归档只会覆盖自己。
        self.assertEqual(job_executor.oss_uploader.uploaded[0][0], expected_key)
        self.assertEqual(job_executor.create_asset.await_args.args[1], expected_key)

        # 回写的是 objectKey，不是会过期的签名 URL。
        delivery = job_executor.client.calls[-1]
        self.assertEqual(delivery["json"]["status"], "ready")
        self.assertEqual(delivery["json"]["objectKey"], expected_key)
        self.assertNotIn("signature", json.dumps(delivery["json"]))

    def test_existing_provider_task_id_only_polls_without_creating_again(self):
        import executor as executor_module

        adapter = SimpleNamespace(
            create_task=AsyncMock(),
            poll_until_complete=AsyncMock(
                return_value=ProviderTaskStatus(
                    id="provider-task-1",
                    status="succeeded",
                )
            ),
            pricing_version="seedance-token-v1",
        )
        job_executor = executor_module.JobExecutor.__new__(executor_module.JobExecutor)
        job_executor.adapters = {"seedance": adapter}
        job_executor.update_job_status = AsyncMock(return_value=True)
        job_executor.resolve_asset_url = AsyncMock(
            return_value="https://oss.test/input-signed-url"
        )
        job_executor.output_dir = Path(tempfile.mkdtemp(prefix="worker-recovery-"))

        job = Job(
            id="job-recovery-1",
            status="running",
            created_by="alice",
            prompt="a product video",
            created_at="2026-09-10T00:00:00+00:00",
            provider_profile="seedance-main",
            provider_task_id="provider-task-1",
            attempt_id="attempt-1",
            attempt_submitted_at=datetime.now(timezone.utc).isoformat(),
        )

        settings = SimpleNamespace(
            comfyui_enabled=False,
            running_job_timeout_minutes=10,
            task_status_check_interval=0,
        )
        with patch.object(executor_module, "settings", settings):
            asyncio.run(job_executor.execute_job(job))

        adapter.create_task.assert_not_awaited()
        adapter.poll_until_complete.assert_awaited_once_with(
            "provider-task-1",
            interval=unittest.mock.ANY,
        )
        job_executor.update_job_status.assert_awaited_once()
        self.assertEqual(
            job_executor.update_job_status.await_args.kwargs["attempt_id"],
            "attempt-1",
        )

    def test_new_submission_records_effective_default_model_and_lifecycle_times(self):
        import executor as executor_module

        adapter = SimpleNamespace(
            default_model="doubao-seedance-2-5-260628",
            create_task=AsyncMock(return_value={"task_id": "provider-task-2"}),
            poll_until_complete=AsyncMock(
                return_value=ProviderTaskStatus(
                    id="provider-task-2",
                    status="completed",
                    result_url="https://provider.test/v.mp4",
                )
            ),
            download_video=AsyncMock(
                side_effect=lambda _url, output_path: Path(output_path).write_bytes(b"video")
            ),
            calculate_actual_cost=lambda _usage: None,
            pricing_version="seedance-token-v1",
            classify_failure=lambda _message: executor_module.FailureType.UNKNOWN,
        )
        job_executor = executor_module.JobExecutor.__new__(executor_module.JobExecutor)
        job_executor.adapters = {"seedance": adapter}
        job_executor.update_job_status = AsyncMock(return_value=True)
        job_executor.report_provider_outcome = AsyncMock(return_value=True)
        job_executor.resolve_asset_url = AsyncMock(
            return_value="https://oss.test/input-signed-url"
        )
        job_executor.output_dir = Path(tempfile.mkdtemp(prefix="worker-recovery-"))
        job_executor.oss_uploader = _FakeOssUploader()
        job_executor.client = _RecordingClient()
        job_executor.backend_url = "http://backend.test"

        job = Job(
            id="job-new-1",
            status="pending",
            created_by="alice",
            prompt="a product video",
            created_at="2026-09-10T00:00:00+00:00",
            provider_profile="seedance-main",
            attempt_id="attempt-new-1",
            request_snapshot={"params": {"prompt": "a product video"}},
            execution_plan=approved_execution_plan(),
        )

        settings = SimpleNamespace(
            comfyui_enabled=False,
            running_job_timeout_minutes=10,
            task_status_check_interval=0,
        )
        with patch.object(executor_module, "settings", settings):
            asyncio.run(job_executor.execute_job(job))

        first_update = job_executor.update_job_status.await_args_list[0]
        self.assertEqual(
            first_update.kwargs["attempt_model"],
            "doubao-seedance-2-5-260628",
        )
        self.assertIsInstance(first_update.kwargs["started_at"], datetime)

        provider_id_update = next(
            call for call in job_executor.update_job_status.await_args_list
            if call.kwargs.get("provider_task_id") == "provider-task-2"
        )
        self.assertIsInstance(provider_id_update.kwargs["submitted_at"], datetime)

        # 生命周期收尾现在由 Backend 在确认交付时落库（Worker 只报交付结果），
        # 所以这里断言的是"Provider 成功 + 交付就绪"这条链路已经走完。
        self.assertEqual(job_executor.client.calls[-1]["json"]["status"], "ready")

    def test_uncertain_provider_submission_is_quarantined_without_retry(self):
        import executor as executor_module
        from providers.seedance_adapter import ProviderSubmissionUncertainError

        adapter = SimpleNamespace(
            create_task=AsyncMock(
                side_effect=ProviderSubmissionUncertainError("connection reset")
            ),
            classify_failure=lambda _message: executor_module.FailureType.NETWORK_ERROR,
        )
        job_executor = executor_module.JobExecutor.__new__(executor_module.JobExecutor)
        job_executor.adapters = {"seedance": adapter}
        job_executor.update_job_status = AsyncMock(return_value=True)
        job_executor.resolve_asset_url = AsyncMock(
            return_value="https://oss.test/input-signed-url"
        )

        job = Job(
            id="job-uncertain-1",
            status="pending",
            created_by="alice",
            prompt="a product video",
            created_at="2026-09-10T00:00:00+00:00",
            provider_profile="seedance-main",
            attempt_id="attempt-uncertain-1",
            execution_plan=approved_execution_plan(),
        )

        settings = SimpleNamespace(
            comfyui_enabled=False,
            running_job_timeout_minutes=10,
        )
        with patch.object(executor_module, "settings", settings):
            asyncio.run(job_executor.execute_job(job))

        adapter.create_task.assert_awaited_once()
        self.assertEqual(job_executor.update_job_status.await_count, 2)
        kwargs = job_executor.update_job_status.await_args_list[-1].kwargs
        self.assertEqual(kwargs["attempt_status"], "requires_review")
        self.assertEqual(kwargs["failure_code"], "SUBMISSION_UNCERTAIN")
        self.assertEqual(kwargs["task_status"], "requires_review")

    def test_submitted_without_provider_id_is_reviewed_without_new_create(self):
        import executor as executor_module

        adapter = SimpleNamespace(create_task=AsyncMock())
        job_executor = executor_module.JobExecutor.__new__(executor_module.JobExecutor)
        job_executor.adapters = {"seedance": adapter}
        job_executor.update_job_status = AsyncMock(return_value=True)

        job = Job(
            id="job-submitted-missing-id",
            status="submitted",
            created_by="alice",
            prompt="a product video",
            created_at="2026-09-10T00:00:00+00:00",
            provider_profile="seedance-main",
            attempt_id="attempt-missing-id",
        )

        settings = SimpleNamespace(comfyui_enabled=False)
        with patch.object(executor_module, "settings", settings):
            asyncio.run(job_executor.execute_job(job))

        adapter.create_task.assert_not_awaited()
        kwargs = job_executor.update_job_status.await_args.kwargs
        self.assertEqual(kwargs["attempt_status"], "requires_review")
        self.assertEqual(kwargs["task_status"], "requires_review")

    def test_provider_error_statuses_are_quarantined_without_new_create(self):
        import executor as executor_module

        # 5xx：Provider 可能已经建好任务，只是响应没回来。
        # 这里用真实 adapter 的错误路径，确认 executor 不重提、只转人工核对。
        async def handler(_request):
            import httpx

            return httpx.Response(503, text="upstream unavailable")

        import httpx

        from providers.seedance_adapter import SeedanceAdapter

        adapter = SeedanceAdapter(api_key="test-only")
        adapter.client = httpx.AsyncClient(transport=httpx.MockTransport(handler))

        job_executor = executor_module.JobExecutor.__new__(executor_module.JobExecutor)
        job_executor.adapters = {"seedance": adapter}
        job_executor.update_job_status = AsyncMock(return_value=True)
        job_executor.resolve_asset_url = AsyncMock(return_value="https://oss.test/input")
        job_executor.output_dir = Path(tempfile.mkdtemp(prefix="worker-uncertain-"))

        job = Job(
            id="job-uncertain-status",
            status="pending",
            created_by="alice",
            prompt="a product video",
            created_at="2026-09-10T00:00:00+00:00",
            provider_profile="seedance-main",
            attempt_id="attempt-uncertain-status",
            execution_plan=approved_execution_plan(),
        )

        settings = SimpleNamespace(
            comfyui_enabled=False,
            running_job_timeout_minutes=10,
            task_status_check_interval=0,
        )
        try:
            with patch.object(executor_module, "settings", settings):
                asyncio.run(job_executor.execute_job(job))
        finally:
            asyncio.run(adapter.client.aclose())

        kwargs = job_executor.update_job_status.await_args_list[-1].kwargs
        self.assertEqual(kwargs["failure_code"], "SUBMISSION_UNCERTAIN")
        self.assertEqual(kwargs["attempt_status"], "requires_review")
        self.assertEqual(kwargs["task_status"], "requires_review")

        # 不确定提交不写"已确认落库"，重启后仍会被对账拦住。
        from submission_journal import SubmissionJournal

        journal = SubmissionJournal(job_executor.output_dir / ".video-flow-journal")
        self.assertEqual(journal.entries(), [])
        self.assertFalse(job_executor._submission_block_marker().exists())

    def test_successful_submission_records_confirmation_for_restart(self):
        import executor as executor_module
        from submission_journal import SubmissionJournal

        adapter = SimpleNamespace(
            default_model="doubao-seedance-2-5-260628",
            create_task=AsyncMock(return_value={"task_id": "provider-confirmed"}),
            poll_until_complete=AsyncMock(
                return_value=ProviderTaskStatus(id="provider-confirmed", status="completed")
            ),
            calculate_actual_cost=lambda _usage: None,
            pricing_version="seedance-token-v1",
            classify_failure=lambda _message: executor_module.FailureType.UNKNOWN,
        )

        with tempfile.TemporaryDirectory() as directory:
            job_executor = executor_module.JobExecutor.__new__(executor_module.JobExecutor)
            job_executor.adapters = {"seedance": adapter}
            job_executor.update_job_status = AsyncMock(return_value=True)
            job_executor.report_provider_outcome = AsyncMock(return_value=True)
            job_executor.resolve_asset_url = AsyncMock(return_value="https://oss.test/input")
            job_executor.output_dir = Path(directory)

            job = Job(
                id="job-confirmed-1",
                status="pending",
                created_by="alice",
                prompt="a product video",
                created_at="2026-09-10T00:00:00+00:00",
                provider_profile="seedance-main",
                attempt_id="attempt-confirmed-1",
                execution_plan=approved_execution_plan(),
            )

            settings = SimpleNamespace(
                comfyui_enabled=False,
                running_job_timeout_minutes=10,
                task_status_check_interval=0,
                video_flow_audit_dir="",
            )
            with patch.object(executor_module, "settings", settings):
                asyncio.run(job_executor.execute_job(job))

            journal = SubmissionJournal(Path(directory) / ".video-flow-journal")
            stages = [entry["stage"] for entry in journal.entries()]

            self.assertEqual(stages.count("provider_accepted"), 1)
            self.assertEqual(stages.count("db_confirmed"), 1)
            # 落库已确认：这条提交不会在重启时被算作待核实的应急项。
            self.assertEqual(journal.unresolved_submissions(), [])

            restarted = executor_module.JobExecutor.__new__(executor_module.JobExecutor)
            restarted.output_dir = Path(directory)
            restarted.adapters = {"seedance": adapter}
            restarted.update_job_status = AsyncMock(return_value=True)
            restarted.resolve_asset_url = AsyncMock(return_value="https://oss.test/input")
            restarted._submission_blocked = restarted._submission_block_marker().exists()
            with patch.object(executor_module, "settings", settings):
                restarted._reconcile_submission_journal()

            self.assertFalse(restarted._submission_blocked)
            self.assertFalse(restarted._submission_block_marker().exists())

    def _plan_job_executor(self, adapter, directory, **overrides):
        import executor as executor_module

        job_executor = executor_module.JobExecutor.__new__(executor_module.JobExecutor)
        job_executor.adapters = {"seedance": adapter}
        job_executor.update_job_status = AsyncMock(return_value=True)
        job_executor.report_provider_outcome = AsyncMock(return_value=True)
        job_executor.create_asset = AsyncMock(return_value=True)
        job_executor.resolve_asset_url = AsyncMock(return_value="https://oss.test/input")
        job_executor.output_dir = Path(directory)
        job_executor.backend_url = "http://backend.test"
        for key, value in overrides.items():
            setattr(job_executor, key, value)
        return job_executor

    @staticmethod
    def _completing_adapter(import_module, usage=None, result_url="https://provider.test/v.mp4"):
        async def download_video(_url, output_path):
            Path(output_path).write_bytes(b"video")

        return SimpleNamespace(
            default_model="doubao-seedance-2-5-260628",
            create_task=AsyncMock(return_value={"task_id": "provider-plan-1"}),
            poll_until_complete=AsyncMock(
                return_value=ProviderTaskStatus(
                    id="provider-plan-1",
                    status="completed",
                    result_url=result_url,
                    usage=usage,
                )
            ),
            download_video=AsyncMock(side_effect=download_video),
            calculate_actual_cost=lambda _usage: None,
            pricing_version="seedance-token-v1",
            classify_failure=lambda _message: import_module.FailureType.UNKNOWN,
        )

    @staticmethod
    def _plan_job(job_id="job-plan-1", status="pending"):
        return Job(
            id=job_id,
            status=status,
            created_by="alice",
            prompt="a product video",
            created_at="2026-09-10T00:00:00+00:00",
            provider_profile="seedance-main",
            attempt_id="attempt-plan-1",
            execution_plan=approved_execution_plan(),
        )

    def test_compilation_failure_requires_review_before_provider_submission(self):
        import executor as executor_module

        plan = approved_execution_plan() | {
            "contractDigest": _WORKFLOW_CONTRACT_DIGEST,
            "workflowKey": "seedance.video-edit.v1",
            "workflowVersion": _WORKFLOW_CONTRACT["contractRevision"],
            "media": [{"assetId": "asset-video-1", "role": "reference_video"}],
            "ratio": "16:9",  # 官方编辑模式必须是 adaptive。
            "duration": -1,
            "omniReferenceTaskType": "edit",
            "outputFormat": "mov",
        }
        job = Job(
            id="job-compile-failure", status="pending", created_by="alice",
            prompt="edit @video1", created_at="2026-09-10T00:00:00+00:00",
            provider_profile="seedance-main", attempt_id="attempt-compile-failure",
            execution_plan=plan,
        )
        adapter = SimpleNamespace(default_model="test-model", create_task=AsyncMock())
        settings = SimpleNamespace(
            comfyui_enabled=False, running_job_timeout_minutes=10,
            task_status_check_interval=0,
        )
        with tempfile.TemporaryDirectory() as directory:
            job_executor = self._plan_job_executor(adapter, directory)
            with patch.object(executor_module, "settings", settings):
                asyncio.run(job_executor.execute_job(job))

        adapter.create_task.assert_not_awaited()
        failure = job_executor.update_job_status.await_args_list[-1].kwargs
        self.assertEqual(failure["attempt_status"], "requires_review")
        self.assertEqual(failure["failure_code"], "EXECUTION_PLAN_COMPILE_FAILED")
        self.assertFalse(any(call.kwargs.get("attempt_status") == "submitted" for call in job_executor.update_job_status.await_args_list))

    def test_workflow_plan_is_compiled_before_the_adapter_is_called(self):
        import executor as executor_module

        plan = approved_execution_plan() | {
            "contractDigest": _WORKFLOW_CONTRACT_DIGEST,
            "workflowKey": "seedance.reference-image-to-video.v1",
            "workflowVersion": _WORKFLOW_CONTRACT["contractRevision"],
            "media": [{"assetId": "asset-image-1", "role": "reference_image"}],
            "outputFormat": "mp4",
        }
        job = Job(
            id="job-compiled", status="pending", created_by="alice",
            prompt="a product video", created_at="2026-09-10T00:00:00+00:00",
            provider_profile="seedance-main", attempt_id="attempt-compiled", execution_plan=plan,
        )
        adapter = SimpleNamespace(
            default_model="test-model",
            create_task=AsyncMock(return_value={"task_id": "provider-compiled"}),
            poll_until_complete=AsyncMock(return_value=ProviderTaskStatus(id="provider-compiled", status="failed")),
            classify_failure=lambda _message: executor_module.FailureType.UNKNOWN,
        )
        settings = SimpleNamespace(
            comfyui_enabled=False, running_job_timeout_minutes=10,
            task_status_check_interval=0,
        )
        with tempfile.TemporaryDirectory() as directory:
            job_executor = self._plan_job_executor(adapter, directory)
            with patch.object(executor_module, "settings", settings):
                asyncio.run(job_executor.execute_job(job))

        submitted = adapter.create_task.await_args.args[0]["_compiled_payload"]
        self.assertEqual(submitted["content"][1]["role"], "reference_image")
        self.assertEqual(submitted["content"][1]["image_url"]["url"], "https://oss.test/input")

    def test_outcome_is_recorded_before_any_artifact_delivery(self):
        import executor as executor_module

        with tempfile.TemporaryDirectory() as directory:
            adapter = self._completing_adapter(
                executor_module, usage={"total_tokens": 1000}
            )
            job_executor = self._plan_job_executor(adapter, directory)
            # OSS 故障：生成的钱已经花了，费用终态必须已经落库。
            job_executor.oss_uploader = SimpleNamespace(
                upload=lambda _path, _key: (_ for _ in ()).throw(RuntimeError("oss down"))
            )

            settings = SimpleNamespace(
                comfyui_enabled=False,
                running_job_timeout_minutes=10,
                task_status_check_interval=0,
                video_flow_audit_dir="",
            )
            with patch.object(executor_module, "settings", settings):
                asyncio.run(job_executor.execute_job(self._plan_job()))

            job_executor.report_provider_outcome.assert_awaited_once()
            args = job_executor.report_provider_outcome.await_args
            self.assertEqual(args.args[1], "succeeded")
            self.assertEqual(args.args[2], {"total_tokens": 1000})

    def test_artifact_is_delivered_even_when_usage_is_missing(self):
        import executor as executor_module

        with tempfile.TemporaryDirectory() as directory:
            adapter = self._completing_adapter(executor_module, usage=None)
            job_executor = self._plan_job_executor(
                adapter, directory, client=_RecordingClient()
            )
            job_executor.oss_uploader = _FakeOssUploader()

            settings = SimpleNamespace(
                comfyui_enabled=False,
                running_job_timeout_minutes=10,
                task_status_check_interval=0,
                video_flow_audit_dir="",
            )
            with patch.object(executor_module, "settings", settings):
                asyncio.run(job_executor.execute_job(self._plan_job(job_id="job-no-usage")))

            # 费用未知由 Backend 保留预占 + 人工核查，不能拦住已经生成的视频。
            job_executor.report_provider_outcome.assert_awaited_once()
            self.assertIsNone(job_executor.report_provider_outcome.await_args.args[2])
            job_executor.create_asset.assert_awaited_once()

            # 产物照常交付就绪，费用状态与交付状态互不牵连。
            delivery = job_executor.client.calls[-1]
            self.assertEqual(delivery["json"]["status"], "ready")

    def test_artifact_delivery_is_held_when_outcome_cannot_be_recorded(self):
        import executor as executor_module
        from submission_journal import SubmissionJournal

        class _UnreachableBackend:
            """Backend 不可达：终态回写会失败，看 Worker 是否还丢证据。"""

            async def patch(self, *_args, **_kwargs):
                raise RuntimeError("backend unreachable")

        with tempfile.TemporaryDirectory() as directory:
            adapter = self._completing_adapter(
                executor_module, usage={"total_tokens": 1000}
            )
            job_executor = self._plan_job_executor(
                adapter,
                directory,
                client=_UnreachableBackend(),
            )
            # 走真实的 report_provider_outcome：这里要验的正是它在失败时的行为。
            del job_executor.report_provider_outcome
            job_executor.oss_uploader = _FakeOssUploader()

            settings = SimpleNamespace(
                comfyui_enabled=False,
                running_job_timeout_minutes=10,
                task_status_check_interval=0,
                video_flow_audit_dir="",
            )
            with patch.object(executor_module, "settings", settings):
                asyncio.run(job_executor.execute_job(self._plan_job(job_id="job-held")))

            # 没有确认终态落库就不归档：不能出现"视频交付了但费用没人知道"。
            job_executor.create_asset.assert_not_awaited()
            self.assertNotIn(
                "completed",
                [
                    call.kwargs.get("task_status")
                    for call in job_executor.update_job_status.await_args_list
                ],
            )

            # usage 证据仍留在磁盘上，等下一轮按原 ID 补记。
            journal = SubmissionJournal(Path(directory) / ".video-flow-journal")
            outcomes = [
                entry for entry in journal.entries() if entry.get("stage") == "outcome_observed"
            ]
            self.assertEqual(len(outcomes), 1)
            self.assertEqual(outcomes[0]["usage"], {"total_tokens": 1000})
            self.assertEqual(outcomes[0]["status"], "succeeded")
            self.assertEqual(outcomes[0]["providerTaskId"], "provider-plan-1")

            # 终态没落库时暂停新的 Provider 提交，避免继续产生未知费用。
            self.assertTrue(job_executor._submission_block_marker().exists())

    def test_provider_reported_failure_is_forwarded_with_usage_evidence(self):
        import executor as executor_module
        from providers.seedance_adapter import ProviderTaskFailedError

        with tempfile.TemporaryDirectory() as directory:
            failed_status = ProviderTaskStatus(
                id="provider-failed-1",
                status="failed",
                error_message="content policy",
            )
            adapter = SimpleNamespace(
                default_model="doubao-seedance-2-5-260628",
                create_task=AsyncMock(return_value={"task_id": "provider-failed-1"}),
                poll_until_complete=AsyncMock(side_effect=ProviderTaskFailedError(failed_status)),
                calculate_actual_cost=lambda _usage: None,
                pricing_version="seedance-token-v1",
                classify_failure=lambda _message: executor_module.FailureType.CONTENT_POLICY,
            )
            job_executor = self._plan_job_executor(adapter, directory)

            settings = SimpleNamespace(
                comfyui_enabled=False,
                running_job_timeout_minutes=10,
                task_status_check_interval=0,
                video_flow_audit_dir="",
            )
            with patch.object(executor_module, "settings", settings):
                asyncio.run(job_executor.execute_job(self._plan_job(job_id="job-failed")))

            job_executor.report_provider_outcome.assert_awaited_once()
            args = job_executor.report_provider_outcome.await_args
            self.assertEqual(args.args[1], "failed")
            self.assertEqual(args.kwargs["error_code"], "content policy")
            # 失败不经过兼容回写路径，避免出现"HTTP failed 就当成免费"。
            for call in job_executor.update_job_status.await_args_list:
                self.assertNotEqual(call.kwargs.get("task_status"), "failed")

    def test_archiving_resume_never_creates_another_provider_task(self):
        import executor as executor_module

        with tempfile.TemporaryDirectory() as directory:
            adapter = self._completing_adapter(executor_module, usage={"total_tokens": 10})
            job_executor = self._plan_job_executor(
                adapter, directory, client=_RecordingClient()
            )
            job_executor.oss_uploader = _FakeOssUploader()

            archiving = Job(
                id="job-archiving",
                status="archiving",
                delivery_status="archiving",
                created_by="alice",
                prompt="a product video",
                created_at="2026-09-10T00:00:00+00:00",
                provider_profile="seedance-main",
                attempt_id="attempt-archiving",
                provider_task_id="provider-archiving",
                execution_plan=approved_execution_plan(),
            )

            settings = SimpleNamespace(
                comfyui_enabled=False,
                running_job_timeout_minutes=10,
                task_status_check_interval=0,
                video_flow_audit_dir="",
            )
            with patch.object(executor_module, "settings", settings):
                asyncio.run(job_executor.execute_job(archiving))

            # 归档分支绝不能提交新的付费任务，也不能再报一次终态结算。
            adapter.create_task.assert_not_awaited()
            job_executor.report_provider_outcome.assert_not_awaited()
            adapter.poll_until_complete.assert_awaited_once_with(
                "provider-archiving", interval=0
            )
            self.assertEqual(job_executor.client.calls[-1]["json"]["status"], "ready")

    def test_archiving_without_provider_id_fails_explicitly(self):
        import executor as executor_module

        with tempfile.TemporaryDirectory() as directory:
            adapter = self._completing_adapter(executor_module, usage={"total_tokens": 10})
            job_executor = self._plan_job_executor(
                adapter, directory, client=_RecordingClient()
            )
            job_executor.oss_uploader = _FakeOssUploader()

            orphan = Job(
                id="job-archiving-orphan",
                status="archiving",
                delivery_status="archiving",
                created_by="alice",
                prompt="a product video",
                created_at="2026-09-10T00:00:00+00:00",
                provider_profile="seedance-main",
                attempt_id="attempt-archiving-orphan",
                execution_plan=approved_execution_plan(),
            )

            settings = SimpleNamespace(
                comfyui_enabled=False,
                running_job_timeout_minutes=10,
                task_status_check_interval=0,
                video_flow_audit_dir="",
            )
            with patch.object(executor_module, "settings", settings):
                asyncio.run(job_executor.execute_job(orphan))

            # 没有原任务可查就明确失败，不做替代品、也不新建 Provider 任务。
            adapter.create_task.assert_not_awaited()
            delivery = job_executor.client.calls[-1]["json"]
            self.assertEqual(delivery["status"], "failed")
            self.assertEqual(delivery["errorCode"], "NO_PROVIDER_TASK_ID_FOR_ARCHIVING")

    def test_audit_events_never_carry_signed_urls(self):
        import executor as executor_module
        from audit_log import AuditLog

        with tempfile.TemporaryDirectory() as directory:
            adapter = self._completing_adapter(
                executor_module,
                usage={"total_tokens": 10},
                result_url="https://provider.test/v.mp4?X-Signature=provider-secret",
            )
            job_executor = self._plan_job_executor(
                adapter, directory, client=_RecordingClient()
            )
            job_executor.oss_uploader = _FakeOssUploader()

            settings = SimpleNamespace(
                comfyui_enabled=False,
                running_job_timeout_minutes=10,
                task_status_check_interval=0,
                video_flow_audit_dir="",
            )
            with patch.object(executor_module, "settings", settings):
                asyncio.run(job_executor.execute_job(self._plan_job(job_id="job-audit")))

            events = AuditLog(Path(directory) / ".video-flow-journal", echo=False).read()

        blob = json.dumps(events)
        # 签名 query 与上传票据里的临时地址都不能进普通日志。
        self.assertNotIn("provider-secret", blob)
        self.assertNotIn("signature=", blob.lower())
        self.assertNotIn("https://oss.test", blob)

        delivered = [entry for entry in events if entry.get("event") == "artifact_delivered"]
        self.assertEqual(len(delivered), 1)
        # 留下的是产物身份（objectKey），不是会过期的下载地址。
        self.assertEqual(
            delivered[0]["objectKey"],
            "videos/2026/09/10/job-audit/attempt-plan-1/result.mp4",
        )
        self.assertEqual(delivered[0]["taskId"], "job-audit")

    def test_legacy_job_without_execution_plan_keeps_compat_path(self):
        import executor as executor_module

        with tempfile.TemporaryDirectory() as directory:
            adapter = self._completing_adapter(
                executor_module, usage={"total_tokens": 1000}
            )
            job_executor = self._plan_job_executor(adapter, directory)
            job_executor.oss_uploader = _FakeOssUploader()

            legacy_job = Job(
                id="job-legacy",
                status="pending",
                created_by="legacy-actor",
                prompt="legacy prompt",
                created_at="2026-09-10T00:00:00+00:00",
                provider_profile="seedance-main",
                attempt_id="attempt-legacy",
            )

            self.assertFalse(job_executor.requires_backend_outcome(legacy_job))

            settings = SimpleNamespace(
                comfyui_enabled=False,
                running_job_timeout_minutes=10,
                task_status_check_interval=0,
                video_flow_audit_dir="",
            )
            with patch.object(executor_module, "settings", settings):
                asyncio.run(job_executor.execute_job(legacy_job))

            job_executor.report_provider_outcome.assert_not_awaited()

    def test_restart_after_crash_stays_blocked_until_manual_review(self):
        import executor as executor_module
        from submission_journal import SubmissionJournal

        with tempfile.TemporaryDirectory() as directory:
            # 模拟上一个进程：写完 journal 就被强杀，DB 回写从未发生。
            journal = SubmissionJournal(Path(directory) / ".video-flow-journal")
            journal.append(
                {
                    "stage": "provider_accepted",
                    "taskId": "task-crashed",
                    "attemptId": "attempt-crashed",
                    "providerTaskId": "provider-crashed",
                }
            )

            settings = SimpleNamespace(
                comfyui_enabled=False,
                running_job_timeout_minutes=10,
                task_status_check_interval=0,
                video_flow_audit_dir="",
            )

            restarted = executor_module.JobExecutor.__new__(executor_module.JobExecutor)
            restarted.output_dir = Path(directory)
            restarted._submission_blocked = restarted._submission_block_marker().exists()
            self.assertFalse(restarted._submission_blocked)

            with patch.object(executor_module, "settings", settings):
                with patch("builtins.print") as print_mock:
                    restarted._reconcile_submission_journal()

                # 内存状态不足以判定安全：标记必须落盘，供下一次启动继续生效。
                self.assertTrue(restarted._submission_blocked)
                self.assertTrue(restarted._submission_block_marker().exists())
                printed = " ".join(str(call) for call in print_mock.call_args_list)
                self.assertIn("verify against the provider", printed)

                # 新提交被拦住，且不再调用 Provider。
                self.assertEqual(asyncio.run(restarted.fetch_pending_jobs()), [])

                # 但已有任务的查询与恢复能力保留：带 providerTaskId 的任务继续轮询。
                adapter = SimpleNamespace(
                    default_model="doubao-seedance-2-5-260628",
                    create_task=AsyncMock(),
                    poll_until_complete=AsyncMock(
                        return_value=ProviderTaskStatus(
                            id="provider-crashed",
                            status="completed",
                            result_url="https://provider.test/crashed.mp4",
                        )
                    ),
                    download_video=AsyncMock(
                        side_effect=lambda _url, output_path: Path(output_path).write_bytes(b"video")
                    ),
                    calculate_actual_cost=lambda _usage: None,
                    pricing_version="seedance-token-v1",
                    classify_failure=lambda _message: executor_module.FailureType.UNKNOWN,
                )
                restarted.adapters = {"seedance": adapter}
                restarted.update_job_status = AsyncMock(return_value=True)
                restarted.report_provider_outcome = AsyncMock(return_value=True)
                restarted.resolve_asset_url = AsyncMock(return_value="https://oss.test/input")
                restarted.backend_url = "http://backend.test"
                restarted.client = _RecordingClient()
                restarted.oss_uploader = _FakeOssUploader()
                restarted.create_asset = AsyncMock(return_value=True)

                inflight = Job(
                    id="task-crashed",
                    status="running",
                    created_by="alice",
                    prompt="a product video",
                    created_at="2026-09-10T00:00:00+00:00",
                    provider_profile="seedance-main",
                    attempt_id="attempt-crashed",
                    provider_task_id="provider-crashed",
                    execution_plan=approved_execution_plan(),
                )
                asyncio.run(restarted.execute_job(inflight))

            # 暂停只拦新提交：已有任务的恢复与交付照常完成。
            adapter.create_task.assert_not_awaited()
            self.assertEqual(restarted.client.calls[-1]["json"]["status"], "ready")
            self.assertNotIn(
                "requires_review",
                [
                    call.kwargs.get("attempt_status")
                    for call in restarted.update_job_status.await_args_list
                ],
            )

            # 只有人工核对并显式解封后，新的提交才会恢复。
            journal.clear_block()
            self.assertFalse(restarted._submission_block_marker().exists())


if __name__ == "__main__":
    unittest.main()
