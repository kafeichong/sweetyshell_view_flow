import json
import os
import stat
import tempfile
import unittest
from pathlib import Path

from submission_journal import (
    BLOCK_MARKER_NAME,
    BLOCKED_REASON,
    JOURNAL_FILE_NAME,
    STAGE_DB_CONFIRMED,
    STAGE_OUTCOME_OBSERVED,
    STAGE_PROVIDER_ACCEPTED,
    SubmissionJournal,
    resolve_journal_directory,
)


class SubmissionJournalTests(unittest.TestCase):
    def test_append_persists_identifiers_and_is_readable_immediately(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = SubmissionJournal(Path(directory) / "audit")

            journal.append(
                {
                    "stage": STAGE_PROVIDER_ACCEPTED,
                    "taskId": "task-1",
                    "attemptId": "attempt-1",
                    "providerTaskId": "provider-1",
                }
            )

            # 不重新构造对象、不等待：写入必须已经 flush/fsync 到磁盘。
            line = journal.journal_path.read_text(encoding="utf-8").strip()
            record = json.loads(line)

        self.assertEqual(record["stage"], STAGE_PROVIDER_ACCEPTED)
        self.assertEqual(record["taskId"], "task-1")
        self.assertEqual(record["attemptId"], "attempt-1")
        self.assertEqual(record["providerTaskId"], "provider-1")
        self.assertRegex(record["at"], r"^\d{4}-\d{2}-\d{2}T")

    def test_append_drops_secrets_prompt_and_response_url(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = SubmissionJournal(Path(directory) / "audit")

            journal.append(
                {
                    "stage": STAGE_PROVIDER_ACCEPTED,
                    "taskId": "task-1",
                    "prompt": "product from water",
                    "token": "ark-secret",
                    "response": {"video_url": "https://provider.test/v.mp4"},
                    "url": "https://signed.example/input?signature=abc",
                }
            )

            record = json.loads(journal.journal_path.read_text(encoding="utf-8").strip())

        self.assertEqual(record["taskId"], "task-1")
        for forbidden in ("prompt", "token", "response", "url"):
            self.assertNotIn(forbidden, record)

    def test_append_keeps_only_sanitized_usage_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = SubmissionJournal(Path(directory) / "audit")

            journal.append(
                {
                    "stage": STAGE_OUTCOME_OBSERVED,
                    "taskId": "task-1",
                    "status": "succeeded",
                    "usage": {
                        "total_tokens": 1000,
                        "video_url": "https://provider.test/v.mp4",
                        "debug": {"signed": "https://oss.test/x?signature=abc"},
                    },
                }
            )

            record = json.loads(journal.journal_path.read_text(encoding="utf-8").strip())

        self.assertEqual(record["status"], "succeeded")
        self.assertEqual(record["usage"], {"total_tokens": 1000})
        self.assertNotIn("video_url", record["usage"])

    def test_append_omits_usage_when_nothing_is_verifiable(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = SubmissionJournal(Path(directory) / "audit")

            journal.append(
                {
                    "stage": STAGE_OUTCOME_OBSERVED,
                    "taskId": "task-1",
                    "usage": {"video_url": "https://provider.test/v.mp4"},
                }
            )

            record = json.loads(journal.journal_path.read_text(encoding="utf-8").strip())

        self.assertNotIn("usage", record)

    def test_append_accumulates_one_record_per_line(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = SubmissionJournal(Path(directory) / "audit")

            journal.append({"stage": STAGE_PROVIDER_ACCEPTED, "taskId": "task-1"})
            journal.append({"stage": STAGE_DB_CONFIRMED, "taskId": "task-1"})

            lines = [
                line
                for line in journal.journal_path.read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]

        self.assertEqual(len(lines), 2)
        self.assertEqual([json.loads(line)["stage"] for line in lines], [
            STAGE_PROVIDER_ACCEPTED,
            STAGE_DB_CONFIRMED,
        ])

    def test_journal_and_directory_permissions_are_restricted(self):
        with tempfile.TemporaryDirectory() as directory:
            audit_dir = Path(directory) / "audit"
            journal = SubmissionJournal(audit_dir)
            journal.append({"stage": STAGE_PROVIDER_ACCEPTED, "taskId": "task-1"})

            journal_mode = stat.S_IMODE(os.stat(journal.journal_path).st_mode)
            directory_mode = stat.S_IMODE(os.stat(audit_dir).st_mode)

        self.assertEqual(journal_mode, 0o600)
        self.assertEqual(directory_mode, 0o700)

    def test_append_raises_when_journal_is_not_writable(self):
        # journal 写不进去时必须抛错：调用方据此停止新的提交，
        # 绝不能静默吞掉"提交已发生但没有证据"。
        with tempfile.TemporaryDirectory() as directory:
            audit_dir = Path(directory) / "audit"
            journal = SubmissionJournal(audit_dir)
            journal.append({"stage": STAGE_PROVIDER_ACCEPTED, "taskId": "task-1"})

            # 情况一：已存在的 journal 变为只读（磁盘/权限故障）。
            journal.journal_path.chmod(0o400)
            try:
                with self.assertRaises(OSError):
                    journal.append({"stage": STAGE_PROVIDER_ACCEPTED, "taskId": "task-2"})
            finally:
                journal.journal_path.chmod(0o600)

        with tempfile.TemporaryDirectory() as directory:
            audit_dir = Path(directory) / "audit"
            audit_dir.mkdir()
            audit_dir.chmod(0o500)

            # 情况二：目录不可写，连新建 journal 都失败。
            try:
                with self.assertRaises(OSError):
                    SubmissionJournal(audit_dir).append(
                        {"stage": STAGE_PROVIDER_ACCEPTED, "taskId": "task-3"}
                    )
            finally:
                audit_dir.chmod(0o700)

    def test_block_marker_survives_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            audit_dir = Path(directory) / "audit"
            journal = SubmissionJournal(audit_dir)
            self.assertFalse(journal.is_blocked())

            journal.mark_blocked()

            # 新进程只认磁盘标记，不依赖上一个进程的内存状态。
            restarted = SubmissionJournal(audit_dir)
            self.assertTrue(restarted.is_blocked())
            marker_text = restarted.block_marker.read_text(encoding="utf-8").strip()

        self.assertEqual(marker_text, BLOCKED_REASON)
        self.assertEqual(BLOCK_MARKER_NAME, "SUBMISSIONS_BLOCKED")

    def test_clear_block_removes_marker_only_when_present(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = SubmissionJournal(Path(directory) / "audit")

            journal.mark_blocked()
            journal.clear_block()
            self.assertFalse(journal.is_blocked())

            # 重复解封不应抛错（人工核对可能执行多次）。
            journal.clear_block()

    def test_unresolved_submissions_lists_accepted_without_confirmation(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = SubmissionJournal(Path(directory) / "audit")

            journal.append(
                {
                    "stage": STAGE_PROVIDER_ACCEPTED,
                    "taskId": "task-crashed",
                    "attemptId": "attempt-crashed",
                    "providerTaskId": "provider-crashed",
                }
            )
            journal.append(
                {
                    "stage": STAGE_PROVIDER_ACCEPTED,
                    "taskId": "task-confirmed",
                    "attemptId": "attempt-confirmed",
                    "providerTaskId": "provider-confirmed",
                }
            )
            journal.append(
                {
                    "stage": STAGE_DB_CONFIRMED,
                    "taskId": "task-confirmed",
                    "attemptId": "attempt-confirmed",
                    "providerTaskId": "provider-confirmed",
                }
            )

            unresolved = journal.unresolved_submissions()

        self.assertEqual(len(unresolved), 1)
        self.assertEqual(unresolved[0]["providerTaskId"], "provider-crashed")

    def test_unresolved_submissions_deduplicates_repeated_attempts(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = SubmissionJournal(Path(directory) / "audit")

            entry = {
                "stage": STAGE_PROVIDER_ACCEPTED,
                "taskId": "task-1",
                "attemptId": "attempt-1",
                "providerTaskId": "provider-1",
            }
            journal.append(entry)
            journal.append(entry)

            unresolved = journal.unresolved_submissions()

        self.assertEqual(len(unresolved), 1)

    def test_entries_skips_corrupt_lines(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = SubmissionJournal(Path(directory) / "audit")
            journal.append({"stage": STAGE_PROVIDER_ACCEPTED, "taskId": "task-1"})

            # 最后一行常常因断电被截断；损坏行不能挡住整份应急记录。
            with journal.journal_path.open("a", encoding="utf-8") as handle:
                handle.write('{"stage":"provider_acc\n')

            entries = journal.entries()

        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["taskId"], "task-1")

    def test_entries_on_missing_journal_returns_empty(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = SubmissionJournal(Path(directory) / "audit")

            self.assertEqual(journal.entries(), [])
            self.assertEqual(journal.unresolved_submissions(), [])

    def test_resolve_journal_directory_prefers_configured_audit_dir(self):
        fallback = Path("/app/output/.video-flow-journal")

        self.assertEqual(
            resolve_journal_directory("/app/audit", fallback),
            Path("/app/audit"),
        )
        # 未配置（含空白字符串）时退回默认目录，兼容本地调试。
        self.assertEqual(resolve_journal_directory("", fallback), fallback)
        self.assertEqual(resolve_journal_directory("   ", fallback), fallback)
        self.assertEqual(resolve_journal_directory(None, fallback), fallback)

    def test_journal_file_name_constant(self):
        self.assertEqual(JOURNAL_FILE_NAME, "submissions.jsonl")


if __name__ == "__main__":
    unittest.main()
