import asyncio
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from models import Job, ProviderTaskStatus


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
            job_executor.create_asset = AsyncMock(return_value=True)
            job_executor.resolve_asset_url = AsyncMock(
                return_value="https://oss.test/input-signed-url"
            )
            job_executor.output_dir = Path(directory)
            job_executor.oss_uploader = SimpleNamespace(
                upload=lambda _path, _key: "https://oss.test/signed-expiring-url",
            )
            settings = SimpleNamespace(
                comfyui_enabled=False,
                running_job_timeout_minutes=10,
                task_status_check_interval=0,
            )

            with patch.object(executor_module, "settings", settings):
                asyncio.run(job_executor.execute_job(job))

        terminal = job_executor.update_job_status.await_args_list[-1]
        self.assertTrue(terminal.kwargs["video_url"].startswith("videos/"))
        self.assertFalse(terminal.kwargs["video_url"].startswith("https://"))
        job_executor.create_asset.assert_awaited_once()

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
                )
            ),
            calculate_actual_cost=lambda _usage: None,
            pricing_version="seedance-token-v1",
            classify_failure=lambda _message: executor_module.FailureType.UNKNOWN,
        )
        job_executor = executor_module.JobExecutor.__new__(executor_module.JobExecutor)
        job_executor.adapters = {"seedance": adapter}
        job_executor.update_job_status = AsyncMock(return_value=True)
        job_executor.resolve_asset_url = AsyncMock(
            return_value="https://oss.test/input-signed-url"
        )
        job_executor.output_dir = Path(tempfile.mkdtemp(prefix="worker-recovery-"))

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

        terminal_update = job_executor.update_job_status.await_args_list[-1]
        self.assertIsInstance(terminal_update.kwargs["finished_at"], datetime)

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
                            id="provider-crashed", status="completed"
                        )
                    ),
                    calculate_actual_cost=lambda _usage: None,
                    pricing_version="seedance-token-v1",
                    classify_failure=lambda _message: executor_module.FailureType.UNKNOWN,
                )
                restarted.adapters = {"seedance": adapter}
                restarted.update_job_status = AsyncMock(return_value=True)
                restarted.resolve_asset_url = AsyncMock(return_value="https://oss.test/input")

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

            adapter.create_task.assert_not_awaited()
            self.assertIsNotNone(restarted.update_job_status.await_args)
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
