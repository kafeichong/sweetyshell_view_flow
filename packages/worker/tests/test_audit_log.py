import json
import os
import stat
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from audit_log import (  # noqa: E402
    EVIDENCE_MISSING,
    AuditLog,
    is_sensitive_key,
    sanitize_event,
    strip_url_secrets,
)


class SanitizeEventTests(unittest.TestCase):
    def test_sensitive_material_does_not_reach_logs(self):
        event = sanitize_event(
            {
                "taskId": "t1",
                "Authorization": "Bearer secret",
                "prompt": "private",
                "url": "https://oss.test/a?Signature=secret",
            }
        )
        output = json.dumps(event)

        assert "secret" not in output
        assert "private" not in output
        assert "t1" in output

    def test_recursively_redacts_nested_structures(self):
        event = sanitize_event(
            {
                "taskId": "t1",
                "headers": {"X-Worker-Token": "shared-service-token"},
                "attempts": [{"access_token": "abc", "status": "running"}],
            }
        )

        output = json.dumps(event)
        assert "shared-service-token" not in output
        assert "abc" not in output
        assert event["attempts"][0]["status"] == "running"

    def test_url_keeps_identity_but_drops_query_and_fragment(self):
        self.assertEqual(
            strip_url_secrets("https://oss.test/videos/a.mp4?Signature=x&Expires=1#frag"),
            "https://oss.test/videos/a.mp4",
        )
        self.assertEqual(
            strip_url_secrets("https://ark.test/api/v3/contents/generations"),
            "https://ark.test/api/v3/contents/generations",
        )
        # 非 URL 的字符串原样保留（错误消息常常是唯一线索）。
        self.assertEqual(strip_url_secrets("HTTP 429: slow down"), "HTTP 429: slow down")

    def test_url_userinfo_is_dropped(self):
        self.assertEqual(
            strip_url_secrets("https://user:pass@ark.test/tasks"),
            "https://ark.test/tasks",
        )

    def test_keeps_harmless_identifiers_and_status(self):
        event = sanitize_event(
            {
                "taskId": "task-1",
                "providerTaskId": "provider-1",
                "stage": "upload",
                "code": "ARTIFACT_UPLOAD_FAILED",
                "httpStatus": 500,
                "requestId": "req-1",
            }
        )

        # HTTP 状态码、Provider 任务 ID、错误分类都是排障必需，必须保留。
        self.assertEqual(event["httpStatus"], 500)
        self.assertEqual(event["providerTaskId"], "provider-1")
        self.assertEqual(event["code"], "ARTIFACT_UPLOAD_FAILED")

    def test_idempotency_key_is_not_treated_as_a_secret(self):
        # 幂等键是哈希，不是凭证；误伤它会让"同一个意图"无法核对。
        self.assertFalse(is_sensitive_key("idempotencyKey"))
        self.assertTrue(is_sensitive_key("X-Worker-Token"))
        self.assertTrue(is_sensitive_key("authorization"))


class AuditLogTests(unittest.TestCase):
    def test_emit_writes_uniform_fields_and_sanitizes(self):
        with tempfile.TemporaryDirectory() as directory:
            log = AuditLog(Path(directory), component="worker", echo=False)

            log.emit(
                "artifact_upload_failed",
                level="error",
                taskId="task-1",
                attemptId="attempt-1",
                providerTaskId="provider-1",
                stage="upload",
                code="ARTIFACT_UPLOAD_FAILED",
                requestId="req-1",
                url="https://oss.test/a?Signature=secret",
                prompt="private prompt",
            )

            record = json.loads(log.path_for().read_text(encoding="utf-8").strip())

        for field in ("at", "level", "event", "taskId", "attemptId", "providerTaskId", "stage", "code", "requestId"):
            self.assertIn(field, record)
        self.assertEqual(record["event"], "artifact_upload_failed")
        self.assertEqual(record["level"], "error")
        serialized = json.dumps(record)
        self.assertNotIn("secret", serialized)
        self.assertNotIn("private prompt", serialized)

    def test_event_file_permissions_are_restricted(self):
        with tempfile.TemporaryDirectory() as directory:
            log = AuditLog(Path(directory), echo=False)
            log.emit("started", taskId="task-1")

            mode = stat.S_IMODE(os.stat(log.path_for()).st_mode)
            directory_mode = stat.S_IMODE(os.stat(Path(directory)).st_mode)

        self.assertEqual(mode, 0o600)
        self.assertEqual(directory_mode, 0o700)

    def test_read_filters_by_task_id_and_keeps_order(self):
        with tempfile.TemporaryDirectory() as directory:
            log = AuditLog(Path(directory), echo=False)
            log.emit("submitted", taskId="task-1")
            log.emit("submitted", taskId="task-2")
            log.emit("delivered", taskId="task-1")

            records = log.read(task_id="task-1")

        self.assertEqual([record["event"] for record in records], ["submitted", "delivered"])

    def test_evidence_status_distinguishes_missing_from_empty(self):
        with tempfile.TemporaryDirectory() as directory:
            log = AuditLog(Path(directory) / "audit", echo=False)

            missing = log.evidence_status("task-1")
            self.assertFalse(missing["available"])
            self.assertEqual(missing["reason"], EVIDENCE_MISSING)

            log.emit("submitted", taskId="task-1")
            available = log.evidence_status("task-1")

        self.assertTrue(available["available"])
        self.assertEqual(available["matchingRecords"], 1)

    def test_rotate_only_removes_expired_event_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            log = AuditLog(root, retention_days=7, echo=False)
            log.emit("submitted", taskId="task-1")

            old = root / "events-2026-01-01.jsonl"
            old.write_text('{"event":"ancient"}\n', encoding="utf-8")
            # 未结案的应急证据不能跟着普通日志一起过期。
            journal = root / "submissions.jsonl"
            journal.write_text('{"stage":"provider_accepted"}\n', encoding="utf-8")
            marker = root / "SUBMISSIONS_BLOCKED"
            marker.write_text("manual_review_required\n", encoding="utf-8")

            removed = log.rotate(now=datetime.now(timezone.utc) + timedelta(days=1))

            self.assertEqual([path.name for path in removed], ["events-2026-01-01.jsonl"])
            self.assertFalse(old.exists())
            self.assertTrue(journal.exists())
            self.assertTrue(marker.exists())

    def test_events_survive_a_container_rebuild(self):
        # 容器重建等于进程重启：日志落在挂载卷上，新实例仍要能按 taskId 查回。
        with tempfile.TemporaryDirectory() as directory:
            first = AuditLog(Path(directory), echo=False)
            first.emit("provider_accepted", taskId="task-1", providerTaskId="provider-1")

            restarted = AuditLog(Path(directory), echo=False)
            records = restarted.read(task_id="task-1")

        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["providerTaskId"], "provider-1")


if __name__ == "__main__":
    unittest.main()
