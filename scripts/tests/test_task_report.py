import json
import sys
from pathlib import Path

import pytest

SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import video_flow_task_report as report_cli  # noqa: E402


def _report(**overrides):
    report = {
        "task": {
            "id": "task-1",
            "status": "failed",
            "taskStatus": "failed",
            "deliveryStatus": "failed",
            "errorMsg": "upload:ARTIFACT_UPLOAD_FAILED https://oss.test/x?Signature=secret",
        },
        "attempts": [
            {
                "attemptId": "attempt-1",
                "providerTaskId": "provider-1",
                "status": "completed",
                "costStatus": "usage_calculated",
                "failureCode": None,
                "failureMessage": None,
            }
        ],
        "assets": [{"assetId": "asset-1", "objectKey": "videos/task-1/attempt-1/result.mp4"}],
        "budget": {
            "state": "review",
            "reservedCny": "2.000000",
            "settledCny": None,
            "reviewOperator": None,
            "operatorIsDeclaredClaim": False,
        },
        "lastError": {"source": "task", "code": "DELIVERY_FAILED", "message": "upload failed"},
        "correlation": {
            "taskId": "task-1",
            "attemptIds": ["attempt-1"],
            "providerTaskIds": ["provider-1"],
            "objectKeys": ["videos/task-1/attempt-1/result.mp4"],
        },
        "evidence": {
            "sources": [
                {"source": "database", "available": True, "records": {"tasks": 1}},
                {"source": "worker-audit", "available": False, "reason": "evidence_missing"},
            ]
        },
    }
    report.update(overrides)
    return report


def test_report_output_never_contains_prompts_or_signed_urls(capsys, tmp_path):
    report = _report()
    report["task"]["prompt"] = "私有提示词"
    report["attempts"][0]["requestSnapshot"] = {"prompt": "私有提示词"}
    # 真实形态是「阶段:错误码 + 可能带签名的 URL」，两者都要处理好。
    report["task"]["errorMsg"] = (
        "upload:ARTIFACT_UPLOAD_FAILED https://oss.test/x?Signature=secret-token"
    )

    report_cli.print = print  # 保持真实输出
    payload = report_cli.summarize(report)
    print(json.dumps(report_cli.sanitize(payload), ensure_ascii=False))

    output = capsys.readouterr().out
    assert "私有提示词" not in output
    assert "secret-token" not in output
    # 排障线索必须留下：任务 id、Provider 任务 id、产物 key、错误分类。
    assert "task-1" in output
    assert "provider-1" in output
    assert "videos/task-1/attempt-1/result.mp4" in output
    assert "ARTIFACT_UPLOAD_FAILED" in output


def test_sensitive_keys_and_url_queries_are_redacted():
    sanitized = report_cli.sanitize(
        {
            "taskId": "task-1",
            "Authorization": "Bearer secret",
            "prompt": "private",
            "url": "https://oss.test/a?Signature=secret",
            "idempotencyKey": "abc123",
        }
    )

    assert sanitized["Authorization"] == report_cli.REDACTED
    assert sanitized["prompt"] == report_cli.REDACTED
    assert sanitized["url"] == "https://oss.test/a"
    # 幂等键是哈希不是凭证，误伤它会让"同一个意图"没法核对。
    assert sanitized["idempotencyKey"] == "abc123"
    assert sanitized["taskId"] == "task-1"


def test_admin_token_comes_from_a_file(tmp_path, monkeypatch):
    token_file = tmp_path / "admin-token"
    token_file.write_text("shared-admin-token\n", encoding="utf-8")
    monkeypatch.setenv("VIDEO_FLOW_ADMIN_TOKEN_FILE", str(token_file))

    assert report_cli.read_admin_token() == "shared-admin-token"


def test_missing_admin_token_file_fails_before_any_request(tmp_path, monkeypatch):
    monkeypatch.setenv("VIDEO_FLOW_ADMIN_TOKEN_FILE", str(tmp_path / "nope"))

    with pytest.raises(SystemExit) as error:
        report_cli.read_admin_token()

    assert "admin token file not found" in str(error.value)


def test_cli_fetches_the_report_with_the_admin_token(monkeypatch, capsys, tmp_path):
    token_file = tmp_path / "admin-token"
    token_file.write_text("shared-admin-token", encoding="utf-8")
    monkeypatch.setenv("VIDEO_FLOW_ADMIN_TOKEN_FILE", str(token_file))

    seen = {}

    def fake_fetch(base_url, task_id, token, **_kwargs):
        seen.update({"base_url": base_url, "task_id": task_id, "token": token})
        return _report()

    monkeypatch.setattr(report_cli, "fetch_report", fake_fetch)

    exit_code = report_cli.main(["--task-id", "task-1", "--base-url", "https://backend.test"])

    assert exit_code == 0
    assert seen == {
        "base_url": "https://backend.test",
        "task_id": "task-1",
        "token": "shared-admin-token",
    }
    output = capsys.readouterr()
    assert "task-1" in output.out
    # 证据缺口要明确提示，不能让人以为"没有记录"。
    assert "evidence_missing" in output.err


def test_cli_reports_fetch_failures_without_traceback(monkeypatch, capsys, tmp_path):
    token_file = tmp_path / "admin-token"
    token_file.write_text("shared-admin-token", encoding="utf-8")
    monkeypatch.setenv("VIDEO_FLOW_ADMIN_TOKEN_FILE", str(token_file))

    def failing_fetch(*_args, **_kwargs):
        raise RuntimeError("404 Task not found")

    monkeypatch.setattr(report_cli, "fetch_report", failing_fetch)

    exit_code = report_cli.main(["--task-id", "missing"])

    assert exit_code == 1
    assert "404 Task not found" in capsys.readouterr().err
