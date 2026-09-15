import importlib.util
import json
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = REPO_ROOT / "scripts" / "comfyui_acceptance_evidence.py"


def load_module():
    spec = importlib.util.spec_from_file_location("comfyui_acceptance_evidence", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def snapshot(*, counters=None, create_count=0, creates_by_key=None, receipts=(), captured_at="2026-09-15T00:00:00+00:00"):
    return {
        "capturedAt": captured_at,
        "runtimeRoot": "/private/tmp/video-flow-comfy-acceptance",
        "ports": {"backend": 3400, "provider": 19093, "worker": 8011, "database": 55434},
        "counters": {
            "tasks": 0, "attempts": 0, "reservations": 0, "preflights": 0, "assets": 0,
            **(counters or {}),
        },
        "provider": {"createCount": create_count, "createCountsByKey": dict(creates_by_key or {})},
        "receiptFiles": list(receipts),
    }


def test_diff_reports_no_change_for_identical_snapshots():
    module = load_module()
    before = snapshot(counters={"tasks": 2}, receipts=["a.json"])

    diff = module.diff_snapshots(before, before)

    assert diff["counters"] == {"tasks": 0, "attempts": 0, "reservations": 0, "preflights": 0, "assets": 0}
    assert diff["providerCreateCount"] == 0
    assert diff["newReceiptFiles"] == []
    assert diff["removedReceiptFiles"] == []


def test_diff_reports_counter_and_provider_increments():
    module = load_module()
    before = snapshot(counters={"tasks": 3, "preflights": 4}, create_count=3, creates_by_key={"a": 1})
    after = snapshot(counters={"tasks": 4, "preflights": 5, "assets": 1}, create_count=4, creates_by_key={"a": 1, "b": 1})

    diff = module.diff_snapshots(before, after)

    assert diff["counters"]["tasks"] == 1
    assert diff["counters"]["preflights"] == 1
    assert diff["counters"]["assets"] == 1
    assert diff["counterIncrements"] == {"tasks": 1, "preflights": 1, "assets": 1}
    assert diff["providerCreateCount"] == 1
    assert diff["providerCreatesByPrompt"] == {"b": 1}


def test_preview_increment_violations_flags_every_moved_counter_and_provider_create():
    module = load_module()
    before = snapshot(counters={"tasks": 3}, create_count=3)
    after = snapshot(counters={"tasks": 4, "attempts": 1, "assets": 1}, create_count=4)

    diff = module.diff_snapshots(before, after)

    assert module.preview_increment_violations(diff) == [
        "counter:tasks", "counter:attempts", "counter:assets",
        "providerCreateCount", "preflightRecords:0",
    ]


def test_preview_increment_violations_is_empty_for_a_clean_preview():
    module = load_module()
    # Preview 的合法副作用恰好是一条独立 PreflightRecord；其余计数器必须不动。
    before = snapshot(counters={"tasks": 3, "preflights": 3}, create_count=3)
    after = snapshot(counters={"tasks": 3, "preflights": 4}, create_count=3, receipts=["preflight.json"])

    diff = module.diff_snapshots(before, after)

    assert module.preview_increment_violations(diff) == []
    assert diff["newReceiptFiles"] == ["preflight.json"]


def test_preview_increment_violations_flags_a_missing_preflight_record():
    module = load_module()
    before = snapshot(counters={"tasks": 3, "preflights": 3}, create_count=3)
    after = snapshot(counters={"tasks": 3, "preflights": 3}, create_count=3)

    diff = module.diff_snapshots(before, after)

    assert module.preview_increment_violations(diff) == ["preflightRecords:0"]


def test_preview_increment_violations_flags_a_retried_preview_creating_two_records():
    module = load_module()
    before = snapshot(counters={"tasks": 3, "preflights": 3}, create_count=3)
    after = snapshot(counters={"tasks": 3, "preflights": 5}, create_count=3)

    diff = module.diff_snapshots(before, after)

    assert module.preview_increment_violations(diff) == ["preflightRecords:2"]


def test_diff_lists_new_and_removed_receipt_files():
    module = load_module()
    before = snapshot(receipts=["a.json", "b.json"])
    after = snapshot(receipts=["b.json", "c.json"])

    diff = module.diff_snapshots(before, after)

    assert diff["newReceiptFiles"] == ["c.json"]
    assert diff["removedReceiptFiles"] == ["a.json"]


def test_capture_snapshot_reads_recorded_state_without_leaking_the_token(tmp_path, monkeypatch):
    module = load_module()
    runtime_root = tmp_path / "runtime"
    runtime_root.mkdir()
    state = {
        "tokenFile": str(runtime_root / "actor.token"),
        "logDir": str(runtime_root / "logs"),
        "ports": {"database": 55434, "provider": 19093, "backend": 3400, "worker": 8011},
    }
    (runtime_root / "state.json").write_text(json.dumps(state), encoding="utf-8")
    (runtime_root / "actor.token").write_text("vf_acceptance_supersecret\n", encoding="utf-8")

    commands = []

    def runner(command, **kwargs):
        commands.append(command)
        if command[:3] == ["docker", "compose", "-p"]:
            rows = command[-1]
            return {
                module.COUNTER_QUERIES["tasks"]: "3",
                module.COUNTER_QUERIES["attempts"]: "3",
                module.COUNTER_QUERIES["reservations"]: "3",
                module.COUNTER_QUERIES["preflights"]: "2",
                module.COUNTER_QUERIES["assets"]: "4",
            }[rows]
        raise AssertionError(f"unexpected command: {command}")

    snapshot_result = module.capture_snapshot(
        runtime_root,
        runner=runner,
        provider_fetch=lambda url: {"createCount": 3, "createCountsByKey": {"prompt": 3}},
        receipt_lister=lambda root: ["preflights/a.json"],
    )

    assert snapshot_result["counters"] == {
        "tasks": 3, "attempts": 3, "reservations": 3, "preflights": 2, "assets": 4,
    }
    assert snapshot_result["provider"]["createCount"] == 3
    assert snapshot_result["receiptFiles"] == ["preflights/a.json"]
    assert snapshot_result["ports"]["provider"] == 19093
    assert "supersecret" not in json.dumps(snapshot_result)


def test_capture_snapshot_fails_closed_when_the_environment_is_not_started(tmp_path):
    module = load_module()

    with pytest.raises(RuntimeError, match="ACCEPTANCE_ENV_NOT_STARTED"):
        module.capture_snapshot(tmp_path / "missing")
