import os
import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from comfyui_status import build_dry_run_cost_fields, map_comfyui_status  # noqa: E402
from config import Settings  # noqa: E402


class ComfyUIStatusTests(unittest.TestCase):
    def test_settings_are_disabled_and_use_repository_workflow_default(self):
        settings = Settings(_env_file=None)
        self.assertFalse(settings.comfyui_enabled)
        self.assertEqual(settings.comfyui_url, "http://127.0.0.1:8188")
        self.assertEqual(
            settings.comfyui_workflow_path,
            "workflows/seedance-text-to-video-dry-run.api.json",
        )

    def test_settings_parse_normal_environment_boolean_values(self):
        original = os.environ.get("COMFYUI_ENABLED")
        try:
            os.environ["COMFYUI_ENABLED"] = "true"
            self.assertTrue(Settings(_env_file=None).comfyui_enabled)
            os.environ["COMFYUI_ENABLED"] = "0"
            self.assertFalse(Settings(_env_file=None).comfyui_enabled)
        finally:
            if original is None:
                os.environ.pop("COMFYUI_ENABLED", None)
            else:
                os.environ["COMFYUI_ENABLED"] = original

    def test_status_mapping_covers_queue_execution_completion_and_failure(self):
        cases = {
            "queued": "pending",
            "executing": "running",
            "success": "completed",
            "error": "failed",
        }
        for status, expected in cases.items():
            with self.subTest(status=status):
                self.assertEqual(
                    map_comfyui_status({"status": {"status_str": status}}),
                    expected,
                )

    def test_prompt_wrapped_history_is_supported(self):
        self.assertEqual(
            map_comfyui_status({"prompt-1": {"status": {"status_str": "running"}}}),
            "running",
        )

    def test_malformed_or_ambiguous_history_never_becomes_completed(self):
        cases = (
            {},
            {"status": []},
            {"status": {"status_str": "unknown", "completed": True}},
            {"outputs": {"7": {}}, "status": {"completed": True}},
        )
        for history in cases:
            with self.subTest(history=history):
                self.assertIn(map_comfyui_status(history), {"pending", "failed"})
                self.assertNotEqual(map_comfyui_status(history), "completed")

    def test_empty_history_is_pending_but_malformed_outputs_are_failed(self):
        self.assertEqual(map_comfyui_status({}), "pending")
        self.assertEqual(map_comfyui_status({"outputs": []}), "failed")
        self.assertEqual(map_comfyui_status({"outputs": "invalid"}), "failed")

    def test_prompt_wrapped_non_object_outputs_are_failed(self):
        self.assertEqual(
            map_comfyui_status({"prompt-1": {"outputs": []}}),
            "failed",
        )
        self.assertEqual(
            map_comfyui_status({"prompt-1": {"outputs": "invalid"}}),
            "failed",
        )

    def test_history_without_legal_status_is_failed(self):
        cases = (
            {"outputs": {}},
            {"prompt-1": {}},
            {"prompt-1": {"outputs": {}}},
            {"status": {}},
        )
        for history in cases:
            with self.subTest(history=history):
                self.assertEqual(map_comfyui_status(history), "failed")

    def test_unknown_status_is_failed(self):
        self.assertEqual(
            map_comfyui_status({"status": {"status_str": "unexpected-value"}}),
            "failed",
        )

    def test_dry_run_cost_fields_contain_no_estimate(self):
        self.assertEqual(
            build_dry_run_cost_fields(),
            {
                "actual_cost": None,
                "cost_status": "unavailable",
                "provider_usage": None,
                "pricing_version": None,
            },
        )


if __name__ == "__main__":
    unittest.main()
