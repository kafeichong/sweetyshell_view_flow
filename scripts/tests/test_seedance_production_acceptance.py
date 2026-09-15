import hashlib
import importlib.util
import json
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = REPO_ROOT / "scripts" / "seedance_production_acceptance.py"
MUTATING_METHODS = (
    "create_task",
    "create_task_with_receipt",
    "upload_media",
    "complete_upload",
    "create_upload_ticket",
    "confirm_client_delivery",
)


def load_module():
    spec = importlib.util.spec_from_file_location("seedance_production_acceptance", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def summary(**overrides):
    base = {
        "id": "task-1",
        "status": "completed",
        "workflowKey": "seedance.reference-image-to-video.v1",
        "executionSlotId": "slot-1",
        "slotSequence": 1,
        "executionPlan": {"outputFormat": "mp4", "duration": 5},
        "execution": {
            "attemptId": "attempt-1",
            "provider": "seedance",
            "model": "doubao-seedance-2-5-260628",
            "providerTaskId": "fake-1",
            "status": "completed",
        },
        "delivery": {"status": "ready", "assetId": "asset-1", "errorCode": None},
        "costSummary": {
            "status": "usage_calculated",
            "usageCalculatedCny": "0.070000",
            "reservedCny": "7.560000",
            "settledCny": "0.070000",
            "reservationState": "settled",
            "pricingVersion": "seedance-2.5-public-catalog-2026-09-15",
        },
    }
    base.update(overrides)
    return base


def codes(findings):
    return {item["code"] for item in findings if not item["ok"]}


class FakeClient:
    """只读命令一旦触碰到会改变状态的方法就立刻失败。

    strict=False 用于 upload / preflight 这类"会写状态但不花钱"的命令，
    它们本来就要调用写接口。
    """

    def __init__(self, *, task=None, slot_task=None, artifact=None, strict=True, report=None):
        self.task = task if task is not None else summary()
        self.slot_task = slot_task
        self.strict = strict
        self.report = report
        self.artifact = artifact or {
            "localPath": "/tmp/out/task-1-result.mp4",
            "sizeBytes": 2246,
            "sha256": "a" * 64,
            "mimeType": "video/mp4",
        }
        self.calls = []

    def _record(self, name, *args):
        self.calls.append(name)
        if self.strict and name in MUTATING_METHODS:
            raise AssertionError(f"只读命令调用了会改变状态的方法: {name}")

    def upload_media(self, media, *, filename, mime_type):
        self._record("upload_media", filename)
        return {"assetId": "asset-uploaded-1", "filename": filename, "mimeType": mime_type}

    def preflight(self, intent):
        self._record("preflight", intent)
        self.last_intent = intent
        if self.report is not None:
            return self.report
        return {
            "preflightId": "preflight-1",
            "requestCheck": {"status": "passed", "items": []},
            "productionAdmission": {"canSubmit": True, "blockers": []},
            "quote": {"status": "estimated", "reserveCny": "7.560000", "missing": []},
            "willUploadMedia": False,
            "willCallProvider": False,
        }

    def get_task(self, task_id):
        self._record("get_task", task_id)
        return self.task

    def get_current_task_for_slot(self, slot_id):
        self._record("get_current_task_for_slot", slot_id)
        return {"currentTask": self.slot_task}

    def download_task_result(self, task_id, destination):
        self._record("download_task_result", task_id)
        return self.artifact

    def cost_is_unverified(self, payload):
        return (payload.get("costSummary") or {}).get("status") not in {"usage_calculated", "billed"}

    def cost_note(self, payload):
        return "费用待核实" if self.cost_is_unverified(payload) else "费用已确认"


def decode_probe(path):
    return {"codecName": "h264", "width": 64, "height": 64, "duration": 1.0}


def failing_probe(path):
    raise RuntimeError("ffprobe failed: moov atom not found")


def test_task_findings_pass_for_a_completed_delivered_task():
    module = load_module()

    findings = module.task_findings(summary(), cost_verified=True)

    assert codes(findings) == set()
    assert module.verdict(findings) == (True, [])


@pytest.mark.parametrize(
    "overrides, expected",
    [
        ({"execution": {"status": "running", "providerTaskId": "fake-1"}}, "execution_completed"),
        ({"delivery": {"status": "pending", "assetId": None}}, "delivery_ready"),
        ({"delivery": {"status": "ready", "assetId": None}}, "output_asset_present"),
        ({"execution": {"status": "completed", "providerTaskId": None}}, "provider_task_id_present"),
    ],
)
def test_task_findings_block_incomplete_delivery(overrides, expected):
    module = load_module()

    findings = module.task_findings(summary(**overrides), cost_verified=True)

    assert expected in codes(findings)
    assert module.verdict(findings)[0] is False


def test_unverified_cost_is_recorded_without_blocking_delivery():
    module = load_module()
    payload = summary(costSummary={"status": "unavailable", "reservationState": "reserved"})

    findings = module.task_findings(payload, cost_verified=False)

    assert "cost_verified" in codes(findings)
    # 费用不确定不能把已经生成好的片扣住不给。
    assert module.verdict(findings) == (True, ["cost_verified"])


@pytest.mark.parametrize(
    "output_format, mime_type, suffix",
    [("mp4", "video/mp4", ".mp4"), ("mov", "video/quicktime", ".mov")],
)
def test_artifact_findings_accept_the_frozen_output_format(output_format, mime_type, suffix):
    module = load_module()
    artifact = {
        "localPath": f"/tmp/out/task-1-result{suffix}",
        "sizeBytes": 2246,
        "sha256": "a" * 64,
        "mimeType": mime_type,
    }

    findings = module.artifact_findings(artifact, decode_probe, output_format=output_format)

    assert codes(findings) == set()


def test_artifact_findings_reject_a_silently_retyped_mp4_for_a_mov_workflow():
    """冻结格式是 MOV，归档却写成了 MP4 —— 这正是 R6.6 修过的那类回归。"""
    module = load_module()
    artifact = {
        "localPath": "/tmp/out/task-1-result.mp4",
        "sizeBytes": 2246,
        "sha256": "a" * 64,
        "mimeType": "video/mp4",
    }

    findings = module.artifact_findings(artifact, decode_probe, output_format="mov")

    assert {"artifact_extension", "artifact_mime"} <= codes(findings)


def test_artifact_findings_reject_an_undecodable_file():
    module = load_module()
    artifact = {
        "localPath": "/tmp/out/task-1-result.mp4",
        "sizeBytes": 0,
        "sha256": "a" * 64,
        "mimeType": "video/mp4",
    }

    findings = module.artifact_findings(artifact, failing_probe, output_format="mp4")

    assert {"artifact_decodable", "artifact_nonempty"} <= codes(findings)


def test_artifact_findings_reject_an_unknown_output_format():
    module = load_module()

    findings = module.artifact_findings({}, decode_probe, output_format="webm")

    assert "artifact_format_supported" in codes(findings)


@pytest.mark.parametrize(
    "argv",
    [
        ["query", "--task-id", "task-1"],
        ["slot", "--slot-id", "slot-1"],
        ["budget", "--task-id", "task-1"],
        ["verify", "--task-id", "task-1"],
        ["evidence", "--task-id", "task-1"],
    ],
)
def test_read_only_commands_never_touch_a_mutating_client_method(argv, tmp_path):
    module = load_module()
    client = FakeClient()

    exit_code = module.run(
        module.parse_args(argv), client=client, probe=decode_probe, workdir=tmp_path,
    )

    assert exit_code == 0
    assert not any(name in MUTATING_METHODS for name in client.calls)


def test_next_refuses_without_explicit_spend_confirmation(tmp_path):
    module = load_module()
    args = module.parse_args([
        "next", "--slot-id", "slot-1", "--preflight-id", "p-1", "--idempotency-key", "k-1",
    ])

    with pytest.raises(module.AcceptanceRefused, match="SPEND_CONFIRMATION_REQUIRED"):
        module.run(args, client=FakeClient(), probe=decode_probe, workdir=tmp_path)


def test_next_refuses_without_an_operator_supplied_idempotency_key(tmp_path):
    module = load_module()
    args = module.parse_args([
        "next", "--slot-id", "slot-1", "--preflight-id", "p-1", "--confirm-spend",
    ])

    with pytest.raises(module.AcceptanceRefused, match="IDEMPOTENCY_KEY_REQUIRED"):
        module.run(args, client=FakeClient(), probe=decode_probe, workdir=tmp_path)


def test_next_refuses_while_the_slot_still_holds_an_undelivered_task(tmp_path):
    module = load_module()
    in_flight = summary(id="task-in-flight", delivery={"status": "pending", "assetId": None})
    # 其余条件都给足，专门隔离"槽内还有未交付任务"这一道闸门。
    args = module.parse_args([
        "next", "--slot-id", "slot-1", "--preflight-id", "p-1",
        "--idempotency-key", "k-1", "--confirm-spend",
        "--media", "reference-image=asset-1",
    ])

    with pytest.raises(module.AcceptanceRefused, match="SLOT_HAS_UNDELIVERED_TASK:task-in-flight"):
        module.run(
            args,
            client=FakeClient(slot_task=in_flight),
            probe=decode_probe,
            workdir=tmp_path,
        )


def test_next_refuses_without_media_slot_bindings(tmp_path):
    module = load_module()
    args = module.parse_args([
        "next", "--slot-id", "slot-1", "--preflight-id", "p-1",
        "--idempotency-key", "k-1", "--confirm-spend",
    ])

    with pytest.raises(module.AcceptanceRefused, match="MEDIA_BINDINGS_REQUIRED"):
        module.run(args, client=FakeClient(), probe=decode_probe, workdir=tmp_path)


def media_fixture(tmp_path, name="reference.webp", payload=b"media-bytes"):
    path = tmp_path / name
    path.write_bytes(payload)
    return path


def descriptor(path, role, slot_id):
    return {
        "path": str(path), "filename": path.name,
        "descriptor": {
            "slotId": slot_id, "role": role, "sha256": "b" * 64,
            "mimeType": "image/webp", "sizeBytes": 11, "metadata": {"kind": "image", "width": 769, "height": 1163},
        },
    }


def test_upload_records_the_asset_identity_without_spending(tmp_path):
    module = load_module()
    path = media_fixture(tmp_path)
    out = tmp_path / "uploaded.json"
    client = FakeClient(strict=False)
    args = module.parse_args(["upload", "--file", str(path), "--out", str(out)])

    exit_code = module.run(args, client=client, probe=decode_probe, workdir=tmp_path)

    assert exit_code == 0
    record = json.loads(out.read_text(encoding="utf-8"))
    assert record["assetId"] == "asset-uploaded-1"
    assert record["filename"] == "reference.webp"
    assert record["sizeBytes"] == len(b"media-bytes")
    assert record["sha256"] == hashlib.sha256(b"media-bytes").hexdigest()
    assert client.calls == ["upload_media"], "上传不应当触发任何付费或建任务调用"


def test_preflight_builds_one_descriptor_per_media_and_reports_the_quote(tmp_path):
    module = load_module()
    first = media_fixture(tmp_path, "a.webp")
    second = media_fixture(tmp_path, "b.webp")
    out = tmp_path / "preflight.json"
    client = FakeClient(strict=False)
    inspected = []

    def inspector(path, role, slot_id):
        inspected.append((path, role, slot_id))
        return descriptor(Path(path), role, slot_id)

    args = module.parse_args([
        "preflight", "--workflow-key", "seedance.reference-image-to-video.v1",
        "--prompt", "验收用参考图", "--duration", "4", "--ratio", "16:9", "--resolution", "720p",
        "--media", f"reference_image:reference-image:{first}",
        "--media", f"reference_image:reference-image-2:{second}",
        "--out", str(out),
    ])

    exit_code = module.run(args, client=client, probe=decode_probe, inspector=inspector, workdir=tmp_path)

    assert exit_code == 0
    assert [item[1:] for item in inspected] == [
        ("reference_image", "reference-image"),
        ("reference_image", "reference-image-2"),
    ]
    intent = client.last_intent
    assert intent["workflowKey"] == "seedance.reference-image-to-video.v1"
    assert intent["generation"]["duration"] == 4
    assert [item["slotId"] for item in intent["media"]] == ["reference-image", "reference-image-2"]
    record = json.loads(out.read_text(encoding="utf-8"))
    assert record["preflightId"] == "preflight-1"
    assert record["quote"]["status"] == "estimated"
    assert record["canSubmit"] is True
    assert "create_task" not in client.calls, "预检不得创建任务"


def test_preflight_refuses_a_report_that_would_upload_or_call_the_provider(tmp_path):
    module = load_module()
    path = media_fixture(tmp_path)
    report = {
        "preflightId": "preflight-1",
        "requestCheck": {"status": "passed"},
        "productionAdmission": {"canSubmit": True, "blockers": []},
        "quote": {"status": "estimated"},
        "willUploadMedia": True,
        "willCallProvider": False,
    }
    args = module.parse_args([
        "preflight", "--workflow-key", "seedance.reference-image-to-video.v1",
        "--prompt", "x", "--duration", "4", "--ratio", "16:9", "--resolution", "720p",
        "--media", f"reference_image:reference-image:{path}",
    ])

    with pytest.raises(module.AcceptanceRefused, match="PREFLIGHT_REPORT_INCOMPLETE"):
        module.run(
            args,
            client=FakeClient(strict=False, report=report),
            probe=decode_probe,
            inspector=lambda p, r, s: descriptor(Path(p), r, s),
            workdir=tmp_path,
        )


def test_preflight_rejects_a_malformed_media_spec(tmp_path):
    module = load_module()
    args = module.parse_args([
        "preflight", "--workflow-key", "seedance.reference-image-to-video.v1",
        "--prompt", "x", "--duration", "4", "--ratio", "16:9", "--resolution", "720p",
        "--media", "reference_image:missing-path-part",
    ])

    with pytest.raises(module.AcceptanceUsageError, match="MEDIA_SPEC_MALFORMED"):
        module.run(
            args,
            client=FakeClient(strict=False),
            probe=decode_probe,
            inspector=lambda p, r, s: descriptor(Path(p), r, s),
            workdir=tmp_path,
        )


def test_evidence_export_records_the_r8_acceptance_fields(tmp_path):
    module = load_module()
    out = tmp_path / "evidence.json"
    args = module.parse_args(["evidence", "--task-id", "task-1", "--out", str(out)])

    exit_code = module.run(args, client=FakeClient(), probe=decode_probe, workdir=tmp_path)

    assert exit_code == 0
    record = module.json.loads(out.read_text(encoding="utf-8"))
    assert record["taskId"] == "task-1"
    assert record["workflowKey"] == "seedance.reference-image-to-video.v1"
    assert record["providerTaskId"] == "fake-1"
    assert record["executionPlan"] == {"outputFormat": "mp4", "duration": 5}
    assert record["artifact"]["sha256"] == "a" * 64
    assert record["artifact"]["probe"]["codecName"] == "h264"
    assert record["cost"]["reservedCny"] == "7.560000"
    assert record["cost"]["settledCny"] == "0.070000"
    assert record["verdict"]["passed"] is True
