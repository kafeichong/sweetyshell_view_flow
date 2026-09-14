import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from artifact_delivery import (  # noqa: E402
    artifact_object_key,
    object_size_from_head,
    validate_artifact_file,
    verify_uploaded_object,
)


class ArtifactObjectKeyTests(unittest.TestCase):
    def test_artifact_key_is_stable_and_task_scoped(self):
        created_at = "2026-09-14T23:30:00-07:00"
        assert artifact_object_key(
            "task-1", "attempt-1", created_at
        ) == "videos/2026/09/15/task-1/attempt-1/result.mp4"
        assert artifact_object_key("task-2", "attempt-1", created_at) != artifact_object_key(
            "task-1", "attempt-1", created_at
        )

    def test_key_is_stable_across_calls(self):
        # 归档重跑可能跨越午夜，仍必须落到任务创建日的同一个对象上。
        first = artifact_object_key("task-1", "attempt-1", "2026-09-10T00:00:00+00:00")
        second = artifact_object_key("task-1", "attempt-1", "2026-09-10T00:00:00+00:00")
        self.assertEqual(first, second)

    def test_key_rejects_invalid_created_at(self):
        with self.assertRaises(ValueError):
            artifact_object_key("task-1", "attempt-1", "not-a-date")

    def test_key_rejects_missing_created_at(self):
        with self.assertRaises(ValueError):
            artifact_object_key("task-1", "attempt-1", "")

    def test_key_rejects_missing_identifiers(self):
        for args in (("", "attempt-1"), ("task-1", ""), ("", "")):
            with self.assertRaises(ValueError):
                artifact_object_key(*args, "2026-09-10T00:00:00+00:00")


class ArtifactFileValidationTests(unittest.TestCase):
    def test_missing_file_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            ok, reason = validate_artifact_file(Path(directory) / "nope.mp4")

        self.assertFalse(ok)
        self.assertEqual(reason, "ARTIFACT_FILE_MISSING")

    def test_empty_file_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "empty.mp4"
            path.write_bytes(b"")

            ok, reason = validate_artifact_file(path)

        self.assertFalse(ok)
        self.assertEqual(reason, "ARTIFACT_FILE_EMPTY")

    def test_non_empty_file_passes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "video.mp4"
            path.write_bytes(b"video-bytes")

            ok, reason = validate_artifact_file(path)

        self.assertTrue(ok)
        self.assertIsNone(reason)

    def test_directory_is_not_a_file(self):
        with tempfile.TemporaryDirectory() as directory:
            ok, reason = validate_artifact_file(directory)

        self.assertFalse(ok)
        self.assertEqual(reason, "ARTIFACT_NOT_A_FILE")


class UploadedObjectVerificationTests(unittest.TestCase):
    def test_missing_head_means_object_was_not_stored(self):
        ok, reason = verify_uploaded_object(None)

        self.assertFalse(ok)
        self.assertEqual(reason, "ARTIFACT_OBJECT_MISSING")

    def test_empty_object_is_rejected(self):
        ok, reason = verify_uploaded_object(SimpleNamespace(content_length=0))

        self.assertFalse(ok)
        self.assertEqual(reason, "ARTIFACT_OBJECT_EMPTY")

    def test_size_mismatch_is_rejected(self):
        ok, reason = verify_uploaded_object(
            SimpleNamespace(content_length=10), expected_size=20
        )

        self.assertFalse(ok)
        self.assertEqual(reason, "ARTIFACT_OBJECT_SIZE_MISMATCH")

    def test_matching_size_passes(self):
        ok, reason = verify_uploaded_object(
            SimpleNamespace(content_length=2048), expected_size=2048
        )

        self.assertTrue(ok)
        self.assertIsNone(reason)

    def test_head_without_size_still_confirms_existence(self):
        ok, reason = verify_uploaded_object(SimpleNamespace())

        self.assertTrue(ok)
        self.assertIsNone(reason)

    def test_reads_size_from_dict_and_string_forms(self):
        self.assertEqual(object_size_from_head({"content_length": 12}), 12)
        self.assertEqual(object_size_from_head({"content-length": "12"}), 12)
        self.assertIsNone(object_size_from_head({"content_length": True}))
        self.assertIsNone(object_size_from_head(SimpleNamespace()))


if __name__ == "__main__":
    unittest.main()
