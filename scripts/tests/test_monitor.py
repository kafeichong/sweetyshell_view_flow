import json
import sys
from pathlib import Path

import pytest

SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import video_flow_monitor as monitor  # noqa: E402


def healthy_worker(**overrides):
    worker = {
        "ready": True,
        "loopAlive": True,
        "backendLastOkAt": "2026-09-13T12:00:00+00:00",
        "providerPollLastOkAt": None,
        "activeTaskId": None,
        "activeTaskAgeSeconds": None,
        "admissionPaused": False,
        "reasons": [],
    }
    worker.update(overrides)
    return worker


def healthy_backend(**overrides):
    backend = {
        "status": "ok",
        "database": {"status": "ok"},
        "queue": {"pendingCount": 0, "oldestPendingAgeSeconds": None, "pendingStalled": False},
        "backlog": {"requiresReview": 0, "deliveryFailed": 0, "costUnverified": 0},
        "productionGate": {"paused": False, "reason": None},
    }
    backend.update(overrides)
    return backend


def codes(checks):
    return [check["code"] for check in checks]


def test_healthy_snapshot_produces_no_alert():
    checks = monitor.evaluate_checks({"worker": healthy_worker(), "backend": healthy_backend()})

    assert checks == []


def test_normal_generation_below_threshold_is_not_flagged():
    # 5 分钟的正常生成：健康判定与巡检都不该打扰人。
    checks = monitor.evaluate_checks(
        {
            "worker": healthy_worker(activeTaskId="task-1", activeTaskAgeSeconds=300),
            "backend": healthy_backend(),
        }
    )

    assert checks == []


def test_long_generation_is_attention_only_not_a_failure():
    # 40 分钟仍在正常轮询的长任务：只标记"超时关注并查询原任务"，
    # 既不把 Worker 判成不健康（那是 HealthState 的职责，长任务视为存活），
    # 也不宣告免费失败或自动再生成。
    checks = monitor.evaluate_checks(
        {
            "worker": healthy_worker(activeTaskId="task-1", activeTaskAgeSeconds=2400),
            "backend": healthy_backend(),
        }
    )

    assert codes(checks) == ["GENERATION_STALLED"]
    assert checks[0]["action"] == "notify_and_query_provider"
    assert checks[0]["severity"] == "warning"


def test_stalled_generation_is_flagged_without_declaring_free_failure():
    checks = monitor.evaluate_checks(
        {
            "worker": healthy_worker(activeTaskId="task-1", activeTaskAgeSeconds=1000),
            "backend": healthy_backend(),
        }
    )

    stalled = next(check for check in checks if check["code"] == "GENERATION_STALLED")
    assert stalled["taskId"] == "task-1"
    # 只标记关注并查询原任务：不自动再生成、不宣告免费失败。
    assert stalled["action"] == "notify_and_query_provider"


def test_crashed_worker_alerts_only_after_consecutive_failures():
    first = monitor.evaluate_checks(
        {"worker": healthy_worker(ready=False, reasons=["poll loop crashed"]), "backend": healthy_backend()},
        consecutive_failures=1,
    )
    assert codes(first) == ["SERVICE_DEGRADED"]

    second = monitor.evaluate_checks(
        {"worker": healthy_worker(ready=False, reasons=["poll loop crashed"]), "backend": healthy_backend()},
        consecutive_failures=2,
    )
    alert = next(check for check in second if check["code"] == "SERVICE_UNAVAILABLE")
    assert alert["severity"] == "critical"
    assert "poll loop crashed" in alert["message"]


def test_database_unreachable_pauses_and_alerts():
    checks = monitor.evaluate_checks(
        {
            "worker": healthy_worker(),
            "backend": healthy_backend(status="degraded", database={"status": "unavailable"}),
        }
    )

    assert codes(checks) == ["DATABASE_UNAVAILABLE"]
    assert checks[0]["action"] == "notify"


def test_review_and_cost_uncertainty_are_escalated():
    checks = monitor.evaluate_checks(
        {
            "worker": healthy_worker(),
            "backend": healthy_backend(
                backlog={"requiresReview": 1, "deliveryFailed": 0, "costUnverified": 1}
            ),
        }
    )

    found = {check["code"]: check for check in checks}
    assert found["REQUIRES_REVIEW"]["severity"] == "critical"
    # 费用不确定必须暂停后续准入，而不是只发一条通知。
    assert found["COST_UNVERIFIED"]["action"] == "pause_admission"


def test_disk_thresholds_warn_then_pause():
    warning = monitor.evaluate_checks(
        {"worker": healthy_worker(), "backend": healthy_backend(), "diskUsagePercent": 85}
    )
    assert codes(warning) == ["DISK_WARNING"]

    critical = monitor.evaluate_checks(
        {"worker": healthy_worker(), "backend": healthy_backend(), "diskUsagePercent": 92}
    )
    assert critical[0]["code"] == "DISK_CRITICAL"
    assert critical[0]["action"] == "pause_admission"


def test_pending_not_claimed_is_flagged_with_task_id():
    checks = monitor.evaluate_checks(
        {
            "worker": healthy_worker(),
            "backend": healthy_backend(
                queue={
                    "pendingCount": 1,
                    "oldestPendingTaskId": "task-old",
                    "oldestPendingAgeSeconds": 300,
                    "pendingStalled": True,
                }
            ),
        }
    )

    stalled = next(check for check in checks if check["code"] == "PENDING_NOT_CLAIMED")
    assert stalled["taskId"] == "task-old"


def test_diff_reports_first_ongoing_and_recovered():
    previous = {"REQUIRES_REVIEW": {"code": "REQUIRES_REVIEW"}}
    current = [
        {"code": "REQUIRES_REVIEW"},
        {"code": "DISK_WARNING"},
    ]

    diff = monitor.diff_checks(previous, current)

    assert [check["code"] for check in diff["first_time"]] == ["DISK_WARNING"]
    assert [check["code"] for check in diff["ongoing"]] == ["REQUIRES_REVIEW"]
    assert [check["code"] for check in diff["recovered"]] == []

    diff_after_fix = monitor.diff_checks(
        {"REQUIRES_REVIEW": {"code": "REQUIRES_REVIEW"}}, []
    )
    assert [check["code"] for check in diff_after_fix["recovered"]] == ["REQUIRES_REVIEW"]


def test_notification_failure_is_reported_and_queued(monkeypatch, tmp_path, capsys):
    webhook_file = tmp_path / "webhook"
    webhook_file.write_text("https://hooks.test/alert", encoding="utf-8")
    monkeypatch.setenv("VIDEO_FLOW_ALERT_WEBHOOK_FILE", str(webhook_file))
    token_file = tmp_path / "admin-token"
    token_file.write_text("admin-token", encoding="utf-8")
    monkeypatch.setenv("VIDEO_FLOW_ADMIN_TOKEN_FILE", str(token_file))

    monkeypatch.setattr(
        monitor, "collect_snapshot",
        lambda *a, **k: {
            "worker": healthy_worker(ready=False, reasons=["crashed"]),
            "backend": healthy_backend(),
            "diskUsagePercent": 10,
        },
    )

    def failing_notify(*_args, **_kwargs):
        raise RuntimeError("webhook down")

    monkeypatch.setattr(monitor, "send_webhook", failing_notify)

    state_file = tmp_path / "state.json"
    exit_code = monitor.main(
        ["--state-file", str(state_file), "--base-url", "https://backend.test"]
    )

    # 通知发不出去必须非零退出，并且把待通知记录留下来。
    assert exit_code == 1
    state = json.loads(state_file.read_text(encoding="utf-8"))
    assert state["pending_notifications"]
    assert "通知失败" in capsys.readouterr().err


def test_webhook_not_configured_stays_dry_run(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("VIDEO_FLOW_ALERT_WEBHOOK_FILE", str(tmp_path / "missing-webhook"))
    token_file = tmp_path / "admin-token"
    token_file.write_text("admin-token", encoding="utf-8")
    monkeypatch.setenv("VIDEO_FLOW_ADMIN_TOKEN_FILE", str(token_file))

    monkeypatch.setattr(
        monitor, "collect_snapshot",
        lambda *a, **k: {
            "worker": healthy_worker(ready=False, reasons=["crashed"]),
            "backend": healthy_backend(),
            "diskUsagePercent": 10,
        },
    )
    frames = []
    monkeypatch.setattr(monitor, "send_webhook", lambda *a, **k: frames.append(a))

    exit_code = monitor.main(["--state-file", str(tmp_path / "state.json")])

    # 未配置渠道时只 dry-run：不允许把"打印了一行"当成告警已送达。
    assert exit_code == 0
    assert frames == []
    assert "dry-run" in capsys.readouterr().err


def test_monitor_never_resumes_the_gate(monkeypatch, tmp_path):
    token_file = tmp_path / "admin-token"
    token_file.write_text("admin-token", encoding="utf-8")
    monkeypatch.setenv("VIDEO_FLOW_ADMIN_TOKEN_FILE", str(token_file))
    monkeypatch.setenv("VIDEO_FLOW_ALERT_WEBHOOK_FILE", str(tmp_path / "no-webhook"))

    gate_calls = []

    class _Response:
        def raise_for_status(self):
            return None

    def fake_patch(url, headers=None, json=None, timeout=None):
        gate_calls.append({"url": url, "json": json})
        return _Response()

    import httpx

    monkeypatch.setattr(httpx, "patch", fake_patch)
    monkeypatch.setattr(
        monitor, "collect_snapshot",
        lambda *a, **k: {
            "worker": healthy_worker(),
            "backend": healthy_backend(
                backlog={"requiresReview": 0, "deliveryFailed": 0, "costUnverified": 1}
            ),
            "diskUsagePercent": 10,
        },
    )

    monitor.main(["--state-file", str(tmp_path / "state.json")])

    # 只有暂停，没有解除：解除必须由管理员核实原因后手动执行。
    assert [call["json"]["paused"] for call in gate_calls] == [True]
    assert "operations/production-gate" in gate_calls[0]["url"]
