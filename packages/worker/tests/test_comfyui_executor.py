import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import ANY, AsyncMock, patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from comfyui_executor import ComfyUIExecutionError, ComfyUIDryRunExecutor  # noqa: E402
from comfyui_workflow import ComfyUIWorkflowError  # noqa: E402
from config import Settings  # noqa: E402
from models import Job, JobStatus  # noqa: E402


ROOT = Path(__file__).resolve().parents[3]
WORKFLOW_PATH = ROOT / "workflows" / "seedance-text-to-video-dry-run.comfy.json"
API_WORKFLOW_PATH = ROOT / "workflows" / "seedance-text-to-video-dry-run.api.json"


def make_job(**overrides):
    payload = {
        "id": "job-1",
        "workflow_hash": "hash-1",
        "workflow_name": "seedance-text-to-video-dry-run",
        "capability": "TEXT_TO_VIDEO",
        "provider_profile": "seedance-main",
        "params": {"prompt": "产品缓慢旋转"},
        "status": "pending",
        "created_at": "2026-09-01T10:00:00+00:00",
    }
    payload.update(overrides)
    return Job(**payload)


class FakeComfyUIClient:
    def __init__(self, histories):
        self.histories = list(histories)
        self.queue_calls = []
        self.queue_client_ids = []
        self.history_calls = []

    async def queue_prompt(self, workflow, client_id=None):
        self.queue_calls.append(workflow)
        self.queue_client_ids.append(client_id)
        return "prompt-local-1"

    async def history(self, prompt_id):
        self.history_calls.append(prompt_id)
        if len(self.histories) > 1:
            return self.histories.pop(0)
        return self.histories[0]


def completed_history():
    return {
        "prompt-local-1": {
            "status": {"status_str": "success"},
            "outputs": {
                "7": {
                    "videos": [{
                        "filename": "clip.mp4",
                        "subfolder": "",
                        "type": "output",
                    }]
                }
            },
        }
    }


class ComfyUIDryRunExecutorTests(unittest.TestCase):
    def run_async(self, awaitable):
        return asyncio.run(awaitable)

    def test_submits_validated_workflow_and_polls_to_completion(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "clip.mp4"
            output.write_bytes(b"local video")
            client = FakeComfyUIClient([
                {"prompt-local-1": {"status": {"status_str": "queued"}}},
                {"prompt-local-1": {"status": {"status_str": "executing"}}},
                completed_history(),
            ])
            executor = ComfyUIDryRunExecutor(
                client,
                API_WORKFLOW_PATH,
                directory,
                poll_interval=0,
                client_id="worker-test",
            )

            result = self.run_async(executor.execute(make_job()))

            self.assertEqual(result.prompt_id, "prompt-local-1")
            self.assertEqual(result.status, "completed")
            self.assertEqual(result.outputs[0]["local_path"], str(output.resolve()))
            self.assertEqual(len(client.queue_calls), 1)
            payload = client.queue_calls[0]
            self.assertIn("1", payload)
            self.assertEqual(payload["1"]["class_type"], "SeedanceArkPromptBuilder")
            self.assertIn("inputs", payload["1"])
            self.assertEqual(client.queue_client_ids, ["worker-test"])
            self.assertEqual(client.history_calls, [
                "prompt-local-1",
                "prompt-local-1",
                "prompt-local-1",
            ])
            self.assertEqual(result.actual_cost, None)
            self.assertEqual(result.cost_status, "unavailable")
            self.assertIsNone(result.provider_usage)
            self.assertIsNone(result.pricing_version)

    def test_new_prompt_is_reported_before_history_polling(self):
        submitted = []

        async def record_submission(job, prompt_id):
            submitted.append((job.id, prompt_id))

        client = FakeComfyUIClient([
            {"prompt-local-1": {"status": {"status_str": "error"}}},
        ])
        executor = ComfyUIDryRunExecutor(
            client,
            API_WORKFLOW_PATH,
            tempfile.gettempdir(),
            on_submitted=record_submission,
        )

        self.run_async(executor.execute(make_job()))

        self.assertEqual(submitted, [("job-1", "prompt-local-1")])

    def test_submission_persistence_failure_stops_before_history_polling(self):
        async def reject_submission(job, prompt_id):
            raise RuntimeError("backend unavailable")

        client = FakeComfyUIClient([
            {"prompt-local-1": {"status": {"status_str": "success"}}},
        ])
        executor = ComfyUIDryRunExecutor(
            client,
            API_WORKFLOW_PATH,
            tempfile.gettempdir(),
            on_submitted=reject_submission,
        )

        with self.assertRaises(RuntimeError):
            self.run_async(executor.execute(make_job()))
        self.assertEqual(len(client.queue_calls), 1)
        self.assertEqual(client.history_calls, [])

    def test_failed_history_returns_failed_result_without_retry(self):
        client = FakeComfyUIClient([
            {"prompt-local-1": {"status": {"status_str": "error"}}},
        ])
        executor = ComfyUIDryRunExecutor(client, API_WORKFLOW_PATH, tempfile.gettempdir())

        result = self.run_async(executor.execute(make_job()))

        self.assertEqual(result.status, "failed")
        self.assertEqual(result.prompt_id, "prompt-local-1")
        self.assertEqual(len(client.history_calls), 1)
        self.assertIsNone(result.actual_cost)

    def test_existing_comfyui_prompt_only_resumes_history_without_queue(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "clip.mp4"
            output.write_bytes(b"local video")
            client = FakeComfyUIClient([completed_history()])
            executor = ComfyUIDryRunExecutor(
                client,
                API_WORKFLOW_PATH,
                directory,
                poll_interval=0,
            )

            result = self.run_async(executor.execute(make_job(
                status="running",
                provider_task_id="prompt-local-1",
            )))

            self.assertEqual(result.status, "completed")
            self.assertEqual(result.prompt_id, "prompt-local-1")
            self.assertEqual(client.queue_calls, [])
            self.assertEqual(client.history_calls, ["prompt-local-1"])

    def test_pending_job_with_existing_provider_id_fails_without_queue(self):
        client = FakeComfyUIClient([])
        executor = ComfyUIDryRunExecutor(client, API_WORKFLOW_PATH, tempfile.gettempdir())

        result = self.run_async(executor.execute(make_job(
            status="pending",
            provider_task_id="old-task-1",
        )))

        self.assertEqual(result.status, "failed")
        self.assertIn("existing", result.error.lower())
        self.assertEqual(client.queue_calls, [])
        self.assertEqual(client.history_calls, [])

    def test_completed_history_with_missing_output_fails_result(self):
        client = FakeComfyUIClient([completed_history()])
        executor = ComfyUIDryRunExecutor(client, API_WORKFLOW_PATH, tempfile.gettempdir())

        result = self.run_async(executor.execute(make_job()))

        self.assertEqual(result.status, "failed")
        self.assertIn("missing", result.error.lower())

    def test_unsafe_workflow_is_rejected_before_queue_prompt(self):
        with tempfile.TemporaryDirectory() as directory:
            workflow = json.loads(API_WORKFLOW_PATH.read_text(encoding="utf-8"))
            workflow["8"]["inputs"]["confirm_live_submission"] = True
            workflow_path = Path(directory) / "unsafe.json"
            workflow_path.write_text(json.dumps(workflow), encoding="utf-8")
            client = FakeComfyUIClient([])
            executor = ComfyUIDryRunExecutor(client, workflow_path, directory)

            with self.assertRaises(ComfyUIWorkflowError):
                self.run_async(executor.execute(make_job()))
            self.assertEqual(client.queue_calls, [])

    def test_ui_export_is_rejected_before_queue_prompt(self):
        client = FakeComfyUIClient([])
        executor = ComfyUIDryRunExecutor(client, WORKFLOW_PATH, tempfile.gettempdir())

        with self.assertRaises(ComfyUIWorkflowError):
            self.run_async(executor.execute(make_job()))
        self.assertEqual(client.queue_calls, [])

    def test_submitted_or_running_job_without_prompt_id_fails_without_queue(self):
        for status in ("submitted", "running"):
            with self.subTest(status=status):
                client = FakeComfyUIClient([])
                executor = ComfyUIDryRunExecutor(
                    client,
                    API_WORKFLOW_PATH,
                    tempfile.gettempdir(),
                )

                result = self.run_async(executor.execute(make_job(status=status)))

                self.assertEqual(result.status, "failed")
                self.assertIn("prompt_id", result.error)
                self.assertEqual(client.queue_calls, [])

    def test_output_path_cannot_escape_output_directory(self):
        history = {
            "prompt-local-1": {
                "status": {"status_str": "success"},
                "outputs": {
                    "7": {
                        "videos": [{
                            "filename": "../../outside.mp4",
                            "subfolder": "",
                            "type": "output",
                        }]
                    }
                },
            }
        }
        client = FakeComfyUIClient([history])
        executor = ComfyUIDryRunExecutor(client, API_WORKFLOW_PATH, tempfile.gettempdir())

        result = self.run_async(executor.execute(make_job()))

        self.assertEqual(result.status, "failed")
        self.assertIn("escapes", result.error)


class JobExecutorSelectionTests(unittest.TestCase):
    def test_completed_comfyui_output_maps_to_asset_payload_without_cost(self):
        import executor as executor_module

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "clip.mp4"
            output.write_bytes(b"local video")
            client = AsyncMock()
            client.post.return_value.raise_for_status = lambda: None
            job_executor = executor_module.JobExecutor.__new__(executor_module.JobExecutor)
            job_executor.backend_url = "http://backend.test"
            job_executor.client = client

            result = self.run_async(
                ComfyUIDryRunExecutor(
                    FakeComfyUIClient([completed_history()]),
                    API_WORKFLOW_PATH,
                    directory,
                    poll_interval=0,
                ).execute(make_job())
            )
            asset = result.outputs[0]
            self.run_async(job_executor.create_asset(
                "job-1",
                asset["filename"],
                asset["local_path"],
                asset["type"],
            ))

            payload = client.post.await_args.kwargs["json"]
            self.assertEqual(payload["job_id"], "job-1")
            self.assertEqual(payload["file_path"], "clip.mp4")
            self.assertEqual(payload["local_path"], str(output.resolve()))
            self.assertEqual(payload["file_type"], "output")
            self.assertEqual(payload["file_size_bytes"], len(b"local video"))
            self.assertIsNone(result.actual_cost)
            self.assertEqual(result.cost_status, "unavailable")
            self.assertIsNone(result.provider_usage)
            self.assertIsNone(result.pricing_version)

    def test_inflight_job_without_provider_id_is_marked_failed_not_filtered(self):
        import executor as executor_module

        response_by_status = {
            status: type("Response", (), {
                "raise_for_status": lambda self: None,
                "json": lambda self, status=status: {
                    "jobs": [{
                        "id": f"job-{status}",
                        "workflow_hash": "hash-1",
                        "capability": "TEXT_TO_VIDEO",
                        "provider_profile": "seedance-main",
                        "params": {},
                        "status": status,
                        "created_at": "2026-09-01T10:00:00+00:00",
                    }]
                },
            })()
            for status in ("submitted", "running")
        }

        async def get_jobs(url, params):
            return response_by_status[params["status"]]

        job_executor = executor_module.JobExecutor.__new__(executor_module.JobExecutor)
        job_executor.backend_url = "http://backend.test"
        job_executor.client = AsyncMock()
        job_executor.client.get.side_effect = get_jobs
        job_executor.update_job_status = AsyncMock(return_value=True)

        jobs = self.run_async(job_executor.fetch_inflight_jobs())

        self.assertEqual(jobs, [])
        self.assertEqual(job_executor.update_job_status.await_count, 2)
        for call in job_executor.update_job_status.await_args_list:
            self.assertEqual(call.args[1], JobStatus.FAILED)
            self.assertEqual(call.kwargs["failure_type"], executor_module.FailureType.UNKNOWN)

    def test_inflight_patch_failure_records_manual_intervention_and_stays_excluded(self):
        import executor as executor_module

        response = type("Response", (), {
            "raise_for_status": lambda self: None,
            "json": lambda self: {
                "jobs": [{
                    "id": "job-missing-id",
                    "workflow_hash": "hash-1",
                    "capability": "TEXT_TO_VIDEO",
                    "provider_profile": "seedance-main",
                    "params": {},
                    "status": "running",
                    "created_at": "2026-09-01T10:00:00+00:00",
                }]
            },
        })()

        job_executor = executor_module.JobExecutor.__new__(executor_module.JobExecutor)
        job_executor.backend_url = "http://backend.test"
        job_executor.client = AsyncMock()
        job_executor.client.get.return_value = response
        job_executor.update_job_status = AsyncMock(return_value=False)
        job_executor._comfyui_manual_intervention_job_ids = set()

        jobs = self.run_async(job_executor.fetch_inflight_jobs())

        self.assertEqual(jobs, [])
        self.assertEqual(job_executor.update_job_status.await_count, 2)
        self.assertIn(
            "job-missing-id",
            job_executor._comfyui_manual_intervention_job_ids,
        )

    def test_persistence_failure_quarantines_job_before_next_comfyui_entry(self):
        import executor as executor_module

        job_executor = executor_module.JobExecutor.__new__(executor_module.JobExecutor)
        job_executor._comfyui_quarantined_job_ids = set()
        job_executor.update_job_status = AsyncMock(return_value=False)
        job = make_job()

        with self.assertRaises(ComfyUIExecutionError):
            self.run_async(job_executor._record_comfyui_submission(job, "prompt-local-1"))

        self.assertIn(job.id, job_executor._comfyui_quarantined_job_ids)

        settings = Settings(_env_file=None, comfyui_enabled=True)
        job_executor.comfyui_executor = AsyncMock()
        with patch.object(executor_module, "settings", settings):
            self.run_async(job_executor.execute_job(job))

        job_executor.comfyui_executor.execute.assert_not_awaited()

    def test_default_settings_keep_direct_ark_path_selected(self):
        import executor as executor_module

        with tempfile.TemporaryDirectory() as directory:
            settings = Settings(_env_file=None, comfyui_output_dir=directory)
            backend_client = AsyncMock()
            adapter = AsyncMock()
            with patch.object(executor_module, "settings", settings), \
                    patch.object(executor_module.httpx, "AsyncClient", return_value=backend_client), \
                    patch.object(executor_module, "SeedanceAdapter") as adapter_class, \
                    patch.object(executor_module, "OssUploader"), \
                    patch.object(executor_module, "ComfyUIDryRunExecutor") as comfy_class:
                adapter_class.return_value = adapter
                job_executor = executor_module.JobExecutor()

                self.assertFalse(settings.comfyui_enabled)
                self.assertIsNone(job_executor.comfyui_executor)
                comfy_class.assert_not_called()
                self.run_async(job_executor.close())

    def test_enabled_settings_construct_comfyui_path(self):
        import executor as executor_module

        with tempfile.TemporaryDirectory() as directory:
            settings = Settings(
                _env_file=None,
                comfyui_enabled=True,
                comfyui_output_dir=directory,
            )
            backend_client = AsyncMock()
            adapter = AsyncMock()
            with patch.object(executor_module, "settings", settings), \
                    patch.object(executor_module.httpx, "AsyncClient", return_value=backend_client), \
                    patch.object(executor_module, "SeedanceAdapter") as adapter_class, \
                    patch.object(executor_module, "OssUploader"), \
                    patch.object(executor_module, "ComfyUIClient") as client_class, \
                    patch.object(executor_module, "ComfyUIDryRunExecutor") as comfy_class:
                adapter_class.return_value = adapter
                client_class.return_value = AsyncMock()
                job_executor = executor_module.JobExecutor()

                client_class.assert_called_once_with(settings.comfyui_url)
                comfy_class.assert_called_once_with(
                    client_class.return_value,
                    settings.comfyui_workflow_path,
                    settings.comfyui_output_dir,
                    poll_interval=settings.task_status_check_interval,
                    client_id=settings.comfyui_client_id,
                    on_submitted=ANY,
                )
                self.run_async(job_executor.close())

    def run_async(self, awaitable):
        return asyncio.run(awaitable)


if __name__ == "__main__":
    unittest.main()
