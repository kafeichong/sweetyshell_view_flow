import asyncio
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from models import Job, ProviderTaskStatus


class ProviderSubmissionRecoveryTests(unittest.TestCase):
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
        )
        with tempfile.TemporaryDirectory() as directory:
            job_executor = executor_module.JobExecutor.__new__(executor_module.JobExecutor)
            job_executor.adapters = {"seedance": adapter}
            job_executor.update_job_status = AsyncMock(return_value=True)
            job_executor.create_asset = AsyncMock(return_value=True)
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
        job_executor.output_dir = Path("/tmp/video-worker-output")

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
        job_executor.output_dir = Path("/tmp/video-worker-output")

        job = Job(
            id="job-new-1",
            status="submitted",
            created_by="alice",
            prompt="a product video",
            created_at="2026-09-10T00:00:00+00:00",
            provider_profile="seedance-main",
            attempt_id="attempt-new-1",
            request_snapshot={"params": {"prompt": "a product video"}},
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

        job = Job(
            id="job-uncertain-1",
            status="pending",
            created_by="alice",
            prompt="a product video",
            created_at="2026-09-10T00:00:00+00:00",
            provider_profile="seedance-main",
            attempt_id="attempt-uncertain-1",
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


if __name__ == "__main__":
    unittest.main()
