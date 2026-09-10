import asyncio
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from models import Job, ProviderTaskStatus


class ProviderSubmissionRecoveryTests(unittest.TestCase):
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
            submitted_at=datetime.now(timezone.utc).isoformat(),
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
