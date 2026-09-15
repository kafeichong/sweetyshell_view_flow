"""R8 受控验收取证工具：默认只读，绝不默认新建付费任务。

R8 要在正式环境上逐项验收，但真实验收会**产生火山引擎费用**。因此本工具把五件事
拆成显式子命令，其中只有最后一件会花钱：

    query     按 taskId 查询任务状态、执行、交付与费用
    slot      按执行槽查询当前任务（原任务恢复路径）
    budget    校验该任务的预算预占与结算是否自洽
    verify    实际下载产物并 ffprobe 解码校验（不改任务状态、不确认交付）
    evidence  把上述证据导出成一份 JSON 记录
    next      在同一执行槽创建下一版（**唯一会付费的命令，需要显式确认**）

每次 Queue 都可能花钱，所以默认行为是"查询已有任务"。`next` 需要同时具备
`--confirm-spend`、操作者自己提供的幂等键、以及 slotId→assetId 的素材绑定；
槽内还有未完成本地交付的任务时会拒绝，因为此时正确的动作是恢复原任务而不是
新建下一版。

验收判定不看单一状态字段：`execution.status` 与 `delivery.status` 只是必要条件，
产物必须**真的下载下来并且能被解码**才算通过。费用未核实不算失败（已经生成好的
片不该被扣住），但会如实记录。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse


REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CLIENT_DIR = REPO_ROOT / "packages" / "comfyui-video-flow-client"

# 冻结的 outputFormat 决定归档扩展名与 MIME；两者不一致就说明产物被"改名"过。
ARTIFACT_TYPES: dict[str, tuple[str, str]] = {
    "mp4": (".mp4", "video/mp4"),
    "mov": (".mov", "video/quicktime"),
}

EXIT_USAGE = 2
EXIT_REFUSED = 3


class AcceptanceUsageError(RuntimeError):
    """用法或环境不完整。"""


class AcceptanceRefused(RuntimeError):
    """出于花钱或重复计量的风险主动拒绝执行。"""


def finding(code: str, ok: bool, detail: Any, *, blocking: bool = True) -> dict[str, Any]:
    return {"code": code, "ok": bool(ok), "detail": detail, "blocking": bool(blocking)}


def verdict(findings: list[dict[str, Any]]) -> tuple[bool, list[str]]:
    failures = [item["code"] for item in findings if not item["ok"]]
    blocking = [item["code"] for item in findings if not item["ok"] and item["blocking"]]
    return (not blocking, failures)


def task_findings(summary: dict[str, Any], *, cost_verified: bool) -> list[dict[str, Any]]:
    execution = summary.get("execution") or {}
    delivery = summary.get("delivery") or {}
    cost = summary.get("costSummary") or {}
    return [
        finding("execution_completed", execution.get("status") == "completed", execution.get("status")),
        finding("delivery_ready", delivery.get("status") == "ready", delivery.get("status")),
        finding("output_asset_present", bool(delivery.get("assetId")), delivery.get("assetId")),
        finding("provider_task_id_present", bool(execution.get("providerTaskId")), execution.get("providerTaskId")),
        finding("reservation_present", bool(cost.get("reservationState")), cost.get("reservationState")),
        # 费用不确定时 Backend 会保留预占待人工核查，产物仍然可用。
        finding("cost_verified", cost_verified, cost.get("status"), blocking=False),
    ]


def artifact_findings(
    artifact: dict[str, Any],
    probe: Callable[[str], dict[str, Any]],
    *,
    output_format: str | None,
) -> list[dict[str, Any]]:
    findings = [
        finding("artifact_downloaded", bool(artifact.get("localPath")), artifact.get("localPath")),
    ]
    expected = ARTIFACT_TYPES.get(str(output_format))
    findings.append(
        finding("artifact_format_supported", expected is not None, f"outputFormat={output_format}")
    )
    if expected is None:
        return findings

    suffix, mime_type = expected
    local_path = str(artifact.get("localPath") or "")
    findings.append(finding("artifact_extension", local_path.endswith(suffix), local_path))
    findings.append(finding("artifact_mime", artifact.get("mimeType") == mime_type, artifact.get("mimeType")))
    findings.append(
        finding("artifact_nonempty", int(artifact.get("sizeBytes") or 0) > 0, artifact.get("sizeBytes"))
    )
    try:
        probed = probe(local_path)
    except Exception as error:  # noqa: BLE001 - 解码失败本身就是结论
        findings.append(finding("artifact_decodable", False, f"{type(error).__name__}: {error}"))
    else:
        findings.append(finding("artifact_decodable", bool(probed.get("codecName")), probed))
    return findings


def probe_media(path: str) -> dict[str, Any]:
    result = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=codec_name,width,height",
            "-show_entries", "format=duration", "-of", "json", path,
        ],
        check=True, capture_output=True, text=True,
    )
    payload = json.loads(result.stdout or "{}")
    streams = payload.get("streams") or []
    if not streams:
        raise RuntimeError(f"NO_VIDEO_STREAM:{path}")
    stream = streams[0]
    return {
        "codecName": stream.get("codec_name"),
        "width": stream.get("width"),
        "height": stream.get("height"),
        "duration": float((payload.get("format") or {}).get("duration") or 0.0),
    }


def _parse_binding(value: str) -> tuple[str, str]:
    slot_id, separator, asset_id = value.partition("=")
    if not separator or not slot_id.strip() or not asset_id.strip():
        raise AcceptanceUsageError(f"MEDIA_BINDING_MALFORMED:{value}")
    return slot_id.strip(), asset_id.strip()


def _parse_media_spec(value: str) -> tuple[str, str, str]:
    """解析 ROLE:SLOT_ID:PATH；路径本身可能含冒号，所以只切前两段。"""
    role, slot_id, path = (value.split(":", 2) + ["", "", ""])[:3]
    if not role.strip() or not slot_id.strip() or not path.strip():
        raise AcceptanceUsageError(f"MEDIA_SPEC_MALFORMED:{value}")
    return role.strip(), slot_id.strip(), path.strip()


def default_inspector() -> Callable[[str, str, str], dict[str, Any]]:
    try:
        # 素材检查要用 Pillow / ffprobe，这些是客户端包自己的依赖。
        from media_inspection import inspect_media  # noqa: PLC0415
    except ImportError as error:
        raise AcceptanceUsageError(
            f"CLIENT_DEPENDENCY_MISSING:{error}；preflight 需要客户端依赖（Pillow/ffprobe），"
            "请用 packages/comfyui-video-flow-client/.venv/bin/python 运行本工具"
        ) from error

    def inspect(path: str, role: str, slot_id: str) -> dict[str, Any]:
        return inspect_media(path, role, slot_id)

    return inspect


def _run_upload(args: argparse.Namespace, client: Any) -> int:
    path = Path(args.file).expanduser()
    if not path.is_file():
        raise AcceptanceUsageError(f"FILE_NOT_FOUND:{path}")
    data = path.read_bytes()
    mime_type = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
    uploaded = client.upload_media(data, filename=path.name, mime_type=mime_type)
    record = {
        "assetId": uploaded.get("assetId"),
        "file": str(path),
        "filename": path.name,
        "sizeBytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "mimeType": mime_type,
    }
    if getattr(args, "out", None):
        Path(args.out).write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"assetId           {record['assetId']}")
    print(f"file              {record['filename']} ({record['sizeBytes']} 字节, {mime_type})")
    print(f"sha256            {record['sha256']}")
    return 0


def _run_preflight(args: argparse.Namespace, client: Any, inspector: Callable[[str, str, str], dict[str, Any]]) -> int:
    media = []
    for item in args.media:
        role, slot_id, path = _parse_media_spec(item)
        media.append(inspector(path, role, slot_id))

    intent = {
        "contractVersion": 2,
        "workflowKey": args.workflow_key,
        "prompt": {"positive": args.prompt},
        "generation": {
            "duration": args.duration,
            "ratio": args.ratio,
            "resolution": args.resolution,
            "generateAudio": True,
            "watermark": False,
            "outputFormat": args.output_format,
        },
        "media": [item["descriptor"] for item in media],
    }
    report = client.preflight(intent)
    # 预检必须明确声明零副作用，否则不得据此进入 Production。
    if report.get("willUploadMedia") is not False or report.get("willCallProvider") is not False:
        raise AcceptanceRefused(
            "PREFLIGHT_REPORT_INCOMPLETE: 报告未明确声明不上传、不调用 Provider"
            f"（willUploadMedia={report.get('willUploadMedia')}, willCallProvider={report.get('willCallProvider')}）"
        )

    admission = report.get("productionAdmission") or {}
    quote = report.get("quote") or {}
    record = {
        "preflightId": report.get("preflightId"),
        "workflowKey": args.workflow_key,
        "generation": intent["generation"],
        "requestCheck": report.get("requestCheck"),
        "canSubmit": admission.get("canSubmit"),
        "blockers": [
            item.get("code") if isinstance(item, dict) else item
            for item in (admission.get("blockers") or [])
        ],
        "quote": quote,
        "mediaBindings": [
            {"role": item["descriptor"]["role"], "slotId": item["descriptor"]["slotId"], "sha256": item["descriptor"]["sha256"]}
            for item in media
        ],
    }
    if getattr(args, "out", None):
        Path(args.out).write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"preflightId       {record['preflightId']}")
    print(f"requestCheck      {(report.get('requestCheck') or {}).get('status')}")
    print(f"quote             status={quote.get('status')} reserve={quote.get('reserveCny')} missing={quote.get('missing')}")
    print(f"canSubmit         {record['canSubmit']} blockers={record['blockers']}")
    for binding in record["mediaBindings"]:
        print(f"  media           {binding['role']} slot={binding['slotId']} sha={binding['sha256'][:12]}…")
    print("预检不产生费用；正式提交需要 --confirm-spend")
    return 0


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="seedance_production_acceptance.py",
        description="R8 受控验收取证工具（默认只读）",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    def add(name: str, help_text: str, *, task: bool = False, slot: bool = False) -> argparse.ArgumentParser:
        child = sub.add_parser(name, help=help_text)
        if task:
            child.add_argument("--task-id", required=True)
        if slot:
            child.add_argument("--slot-id", required=True)
        child.add_argument("--out", type=Path)
        return child

    add("query", "只读：查询已有任务", task=True)
    add("slot", "只读：按执行槽恢复当前任务", slot=True)
    add("budget", "只读：校验预占与结算", task=True)
    add("verify", "只读：下载产物并解码校验", task=True)
    add("evidence", "只读：导出验收证据 JSON", task=True)

    upload_parser = sub.add_parser("upload", help="上传素材取得 assetId（不付费）")
    upload_parser.add_argument("--file", required=True)
    upload_parser.add_argument("--out", type=Path)

    preflight_parser = sub.add_parser("preflight", help="提交预检取得报价与 preflightId（不付费）")
    preflight_parser.add_argument("--workflow-key", required=True)
    preflight_parser.add_argument("--prompt", required=True)
    preflight_parser.add_argument("--duration", type=int, required=True, help="视频编辑用 -1")
    preflight_parser.add_argument("--ratio", required=True)
    preflight_parser.add_argument("--resolution", required=True)
    preflight_parser.add_argument("--output-format", default="mp4", choices=("mp4", "mov"))
    preflight_parser.add_argument("--media", action="append", default=[], metavar="ROLE:SLOT_ID:PATH")
    preflight_parser.add_argument("--out", type=Path)

    next_parser = sub.add_parser("next", help="创建下一版（会付费，需显式确认）")
    next_parser.add_argument("--slot-id", required=True)
    next_parser.add_argument("--preflight-id", required=True)
    next_parser.add_argument("--idempotency-key")
    next_parser.add_argument("--media", action="append", default=[], metavar="SLOT_ID=ASSET_ID")
    next_parser.add_argument("--confirm-spend", action="store_true")
    next_parser.add_argument("--out", type=Path)
    return parser.parse_args(argv)


def _summarize_task(summary: dict[str, Any], *, cost_verified: bool) -> int:
    execution = summary.get("execution") or {}
    delivery = summary.get("delivery") or {}
    cost = summary.get("costSummary") or {}
    print(f"taskId            {summary.get('id')}")
    print(f"workflowKey       {summary.get('workflowKey') or summary.get('workflowName')}")
    print(f"slot              {summary.get('executionSlotId')} (sequence {summary.get('slotSequence')})")
    print(f"execution         {execution.get('status')} model={execution.get('model')} providerTaskId={execution.get('providerTaskId')}")
    print(f"delivery          {delivery.get('status')} assetId={delivery.get('assetId')}")
    print(f"clientDelivery    {summary.get('clientDeliveryStatus')}")
    print(f"cost              status={cost.get('status')} reserved={cost.get('reservedCny')} settled={cost.get('settledCny')} usage={cost.get('usageCalculatedCny')}")
    if not cost_verified:
        print("                  费用待核实：已保留预占，需人工核对 Provider usage")
    return 0


def _run_verify(args: argparse.Namespace, client: Any, probe: Callable[[str], dict[str, Any]], workdir: Path) -> int:
    summary = client.get_task(args.task_id)
    output_format = (summary.get("executionPlan") or {}).get("outputFormat")
    artifact = client.download_task_result(args.task_id, workdir / "artifacts")
    findings = task_findings(summary, cost_verified=not client.cost_is_unverified(summary))
    findings += artifact_findings(artifact, probe, output_format=output_format)
    passed, failures = verdict(findings)
    for item in findings:
        mark = "ok  " if item["ok"] else ("FAIL" if item["blocking"] else "WARN")
        print(f"  [{mark}] {item['code']}: {item['detail']}")
    print(f"artifact probe    {artifact.get('probe') or probe(str(artifact.get('localPath') or '')) if artifact.get('localPath') else None}")
    print("PASS: 产物已下载并解码通过" if passed else f"FAIL: {failures}")
    return 0 if passed else 1


def _run_evidence(args: argparse.Namespace, client: Any, probe: Callable[[str], dict[str, Any]], workdir: Path) -> int:
    summary = client.get_task(args.task_id)
    output_format = (summary.get("executionPlan") or {}).get("outputFormat")
    artifact = client.download_task_result(args.task_id, workdir / "artifacts")
    probed = None
    if artifact.get("localPath"):
        try:
            probed = probe(str(artifact["localPath"]))
        except Exception as error:  # noqa: BLE001 - 探测失败写进证据，不中断导出
            probed = {"error": f"{type(error).__name__}: {error}"}
    findings = task_findings(summary, cost_verified=not client.cost_is_unverified(summary))
    findings += artifact_findings(artifact, probe, output_format=output_format)
    passed, failures = verdict(findings)
    cost = summary.get("costSummary") or {}
    record = {
        "capturedAt": datetime.now(timezone.utc).isoformat(),
        "taskId": summary.get("id"),
        "workflowKey": summary.get("workflowKey") or summary.get("workflowName"),
        "executionSlotId": summary.get("executionSlotId"),
        "slotSequence": summary.get("slotSequence"),
        "providerTaskId": (summary.get("execution") or {}).get("providerTaskId"),
        "model": (summary.get("execution") or {}).get("model"),
        "executionPlan": summary.get("executionPlan"),
        "artifact": {
            "localPath": artifact.get("localPath"),
            "sizeBytes": artifact.get("sizeBytes"),
            "sha256": artifact.get("sha256"),
            "mimeType": artifact.get("mimeType"),
            "probe": probed,
        },
        "cost": {
            "status": cost.get("status"),
            "reservedCny": cost.get("reservedCny"),
            "settledCny": cost.get("settledCny"),
            "usageCalculatedCny": cost.get("usageCalculatedCny"),
            "billedCny": cost.get("billedCny"),
            "pricingVersion": cost.get("pricingVersion"),
            "reservationState": cost.get("reservationState"),
        },
        "verdict": {"passed": passed, "failures": failures},
    }
    destination = args.out or (workdir / f"acceptance-{summary.get('id')}.json")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"证据已写入 {destination}")
    print("PASS" if passed else f"FAIL: {failures}")
    return 0 if passed else 1


def _preflight_slot_ids(client: Any, preflight_id: str) -> list[str]:
    """预检声明的素材 slot；空列表表示该工作流没有输入素材。"""
    report = client.check_preflight(preflight_id) or {}
    media = (report.get("effectiveRequest") or {}).get("media") or []
    return [
        item["slotId"] for item in media
        if isinstance(item, dict) and item.get("slotId")
    ]


def _run_next(args: argparse.Namespace, client: Any) -> int:
    # 三道闸门缺一不可：花钱确认、操作者自备幂等键、素材 slot 绑定。
    if not args.confirm_spend:
        raise AcceptanceRefused(
            "SPEND_CONFIRMATION_REQUIRED: 该命令会创建真实付费任务；确认范围后加 --confirm-spend"
        )
    if not args.idempotency_key:
        raise AcceptanceRefused(
            "IDEMPOTENCY_KEY_REQUIRED: 必须由操作者提供稳定幂等键，重试时沿用同一个键；"
            "不要使用时间戳，否则重试会变成第二次付费"
        )
    current = (client.get_current_task_for_slot(args.slot_id) or {}).get("currentTask")
    if current and current.get("clientDeliveryStatus") != "delivered":
        raise AcceptanceRefused(
            f"SLOT_HAS_UNDELIVERED_TASK:{current.get('id')}: "
            "该槽仍有未完成本地交付的任务，正确动作是恢复原任务而不是新建下一版"
        )

    # 绑定必须与预检声明的 slot 完全一致：少一个会漏素材，多一个说明绑错了预检。
    # 文生视频这类没有输入素材的工作流声明为空，因此不需要任何 --media。
    declared = _preflight_slot_ids(client, args.preflight_id)
    bindings = dict(_parse_binding(item) for item in args.media)
    missing = [slot for slot in declared if slot not in bindings]
    if missing:
        raise AcceptanceRefused(
            f"MEDIA_BINDINGS_INCOMPLETE: 预检声明了 {declared}，缺少 {missing}"
        )
    extra = [slot for slot in bindings if slot not in declared]
    if extra:
        raise AcceptanceRefused(
            f"MEDIA_BINDING_NOT_IN_PREFLIGHT: {extra} 不在预检声明的 {declared} 里"
        )

    payload = {
        "preflightId": args.preflight_id,
        "executionSlotId": args.slot_id,
        "media": [{"slotId": slot, "assetId": bindings[slot]} for slot in declared],
    }
    task = client.create_task(
        idempotency_key=args.idempotency_key, mode="production", payload=payload,
    )
    print(f"已创建下一版 taskId={task.get('id')} status={task.get('status')}")
    print(f"TASK_ID={task.get('id')}")
    return 0


def run(
    args: argparse.Namespace,
    *,
    client: Any,
    probe: Callable[[str], dict[str, Any]] = probe_media,
    inspector: Callable[[str, str, str], dict[str, Any]] | None = None,
    workdir: Path,
) -> int:
    workdir = Path(workdir)
    command = args.command

    if command == "upload":
        return _run_upload(args, client)

    if command == "preflight":
        return _run_preflight(args, client, inspector or default_inspector())

    if command == "query":
        summary = client.get_task(args.task_id)
        payload = json.dumps(summary, ensure_ascii=False, indent=2)
        if getattr(args, "out", None):
            Path(args.out).write_text(payload + "\n", encoding="utf-8")
            print(f"已写入 {args.out}")
        else:
            print(payload)
        return 0

    if command == "slot":
        current = (client.get_current_task_for_slot(args.slot_id) or {}).get("currentTask")
        if not current:
            print(f"槽 {args.slot_id} 当前没有任务")
            return 0
        return _summarize_task(current, cost_verified=not client.cost_is_unverified(current))

    if command == "budget":
        summary = client.get_task(args.task_id)
        return _summarize_task(summary, cost_verified=not client.cost_is_unverified(summary))

    if command == "verify":
        return _run_verify(args, client, probe, workdir)

    if command == "evidence":
        return _run_evidence(args, client, probe, workdir)

    if command == "next":
        return _run_next(args, client)

    raise AcceptanceUsageError(f"UNKNOWN_COMMAND:{command}")


def build_client() -> Any:
    client_dir = Path(os.environ.get("VIDEO_FLOW_CLIENT_DIR") or DEFAULT_CLIENT_DIR).expanduser()
    if not client_dir.is_dir():
        raise AcceptanceUsageError(f"CLIENT_DIR_MISSING:{client_dir}")
    if str(client_dir) not in sys.path:
        sys.path.insert(0, str(client_dir))

    from client import VideoFlowClient  # noqa: PLC0415
    from config import VideoFlowConfig  # noqa: PLC0415

    config = VideoFlowConfig.from_env()
    if not config.token:
        raise AcceptanceUsageError("NO_CREDENTIAL: 需要 VIDEO_FLOW_TOKEN 或 VIDEO_FLOW_TOKEN_FILE")
    parsed = urlparse(config.backend_url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise AcceptanceUsageError(f"BACKEND_URL_INVALID:{config.backend_url}")
    print(f"backend={config.backend_url} 身份=已提供凭证", file=sys.stderr)
    return VideoFlowClient(config)


def default_workdir() -> Path:
    """产物与证据默认落系统临时目录，避免在仓库里留下下载的视频。"""
    override = os.environ.get("VIDEO_FLOW_ACCEPTANCE_WORKDIR")
    return Path(override).expanduser() if override else Path(tempfile.gettempdir()) / "video-flow-acceptance"


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    workdir = default_workdir()
    try:
        client = build_client()
        print(f"workdir={workdir}", file=sys.stderr)
        return run(args, client=client, probe=probe_media, workdir=workdir)
    except AcceptanceRefused as error:
        print(f"REFUSED: {error}", file=sys.stderr)
        return EXIT_REFUSED
    except AcceptanceUsageError as error:
        print(f"FAIL: {error}", file=sys.stderr)
        return EXIT_USAGE
    except subprocess.CalledProcessError as error:
        print(f"FAIL: 外部命令失败 {error}", file=sys.stderr)
        return 1
    except Exception as error:  # noqa: BLE001 - 验收工具要给操作者干净结论，不是 traceback
        # 任务不存在、凭证无权、后端不可达都走这里；保留异常类型以便排查。
        print(f"FAIL: {type(error).__name__}: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
