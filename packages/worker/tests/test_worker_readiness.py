"""Worker /health 与 /ready 的契约。

两个端点的职责必须分开：/health 只说明进程还在；/ready 才说明主循环与
执行进展是否正常，而且它是最容易被内部系统轮询的端点，不能顺带泄漏配置。
"""

import asyncio
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


class WorkerReadinessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import os
        import tempfile

        directory = tempfile.mkdtemp(prefix="worker-ready-")
        os.environ["COMFYUI_OUTPUT_DIR"] = str(Path(directory) / "output")
        os.environ["VIDEO_FLOW_AUDIT_DIR"] = str(Path(directory) / "audit")

        import config

        config.get_settings.cache_clear()
        import importlib

        importlib.reload(config)

        import executor

        importlib.reload(executor)

        import main

        cls.main = main
        cls.executor = executor

    def test_health_is_process_liveness_only(self):
        payload = asyncio.run(self.main.health_check())

        self.assertEqual(payload, {"status": "alive"})
        # 探针不该顺手回报部署配置。
        serialized = json.dumps(payload)
        self.assertNotIn("backend_url", serialized)
        self.assertNotIn("poll_interval", serialized)

    def test_ready_reports_health_fields_without_secrets(self):
        payload = asyncio.run(self.main.readiness())

        self.assertEqual(
            set(payload),
            {
                "ready",
                "loopAlive",
                "backendLastOkAt",
                "backendLastError",
                "providerPollLastOkAt",
                "activeTaskId",
                "activeTaskAgeSeconds",
                "admissionPaused",
                "lastLoopTickAt",
                "reasons",
            },
        )
        # 主循环还没跑起来：不能报 ready。
        self.assertFalse(payload["ready"])

    def test_ready_sanitizes_backend_errors(self):
        health = self.main.executor.health()
        health.mark_backend_error(
            "HTTPStatusError: https://backend.test/api?Signature=secret-token failed"
        )

        payload = asyncio.run(self.main.readiness())

        self.assertNotIn("secret-token", json.dumps(payload))
        self.assertIn("backend.test", payload["backendLastError"])

    def test_ready_reports_admission_pause_state(self):
        self.main.executor._submission_blocked = True

        payload = asyncio.run(self.main.readiness())

        self.assertTrue(payload["admissionPaused"])


if __name__ == "__main__":
    unittest.main()
