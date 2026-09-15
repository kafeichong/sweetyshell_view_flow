#!/usr/bin/env bash
# §6 运行准备：容器重建后审计与产物证据仍可恢复，且日志轮换不会吞掉未结案证据。
#
# 用真实的 worker 镜像与真实的 AuditLog / SubmissionJournal，跨**不同的容器**
# 写入再读回——每次 docker run 都是一个新容器，命名卷与生产 compose 里
# video_audit / video_output 的用法一致。
#
# 验证三件事：
#   1. 一个容器写入的审计事件与 submission journal，在另一个容器里可读且内容一致；
#   2. 产物卷里的文件同样保留；
#   3. 轮换只清理过期的 events-*.jsonl，submission journal 与阻断标记不受影响
#      （ROLLMAP §6 明确要求"不删除未归档产物或未结案资金记录"）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/compose.contract.yml"
IMAGE="video-flow-contract-worker:latest"
BUILD_PROJECT="video-flow-evidence-recovery-build"
PROJECT="video-flow-evidence-recovery"
AUDIT_VOL="${PROJECT}-audit"
OUTPUT_VOL="${PROJECT}-output"

cleanup() {
  docker volume rm "$AUDIT_VOL" "$OUTPUT_VOL" >/dev/null 2>&1 || true
  docker compose -p "$BUILD_PROJECT" -f "$COMPOSE_FILE" down -v >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "[1/4] 构建 worker 镜像"
docker compose -p "$BUILD_PROJECT" -f "$COMPOSE_FILE" build worker-contract >/dev/null

cleanup
docker volume create "$AUDIT_VOL" >/dev/null
docker volume create "$OUTPUT_VOL" >/dev/null

run_worker() {
  docker run --rm -i \
    -v "${AUDIT_VOL}:/app/audit" \
    -v "${OUTPUT_VOL}:/app/output" \
    -e VIDEO_FLOW_AUDIT_DIR=/app/audit \
    -e COMFYUI_OUTPUT_DIR=/app/output \
    "$IMAGE" python -
}

echo "[2/4] 容器 A：写入审计事件、提交 journal 与产物"
run_worker <<'PY'
import os
from pathlib import Path
from audit_log import AuditLog
from submission_journal import SubmissionJournal

directory = Path(os.environ["VIDEO_FLOW_AUDIT_DIR"])
log = AuditLog(directory, echo=False)
log.emit("acceptance_probe", taskId="task-probe", stage="probe", detail="容器重建证据")
journal = SubmissionJournal(directory)
journal.append(
    {"taskId": "task-probe", "providerTaskId": "fake-probe-1", "event": "provider_submit_attempt"}
)
# 让阻断标记真实存在，否则"轮换不删未结案证据"只是对着一个不存在的文件断言。
journal.mark_blocked("acceptance probe")
Path(os.environ["COMFYUI_OUTPUT_DIR"], "task-probe-result.mp4").write_bytes(b"probe-artifact")
print("      已写入", sorted(p.name for p in directory.iterdir()))
PY

echo "[3/4] 容器 B：换一个全新容器读回同一批证据"
run_worker <<'PY'
import os
import sys
from pathlib import Path
from audit_log import AuditLog
from submission_journal import SubmissionJournal

directory = Path(os.environ["VIDEO_FLOW_AUDIT_DIR"])
events = AuditLog(directory, echo=False).read(task_id="task-probe")
entries = SubmissionJournal(directory).entries()
artifact = Path(os.environ["COMFYUI_OUTPUT_DIR"], "task-probe-result.mp4")

problems = []
if not any(item.get("event") == "acceptance_probe" for item in events):
    problems.append(f"审计事件未恢复: {events}")
if not any(item.get("providerTaskId") == "fake-probe-1" for item in entries):
    problems.append(f"submission journal 未恢复: {entries}")
if not artifact.is_file() or artifact.read_bytes() != b"probe-artifact":
    problems.append("产物卷内容未恢复")
if problems:
    print("      FAIL: " + "；".join(problems), file=sys.stderr)
    sys.exit(1)
print(f"      读回 审计事件={len(events)} journal={len(entries)} 产物={artifact.stat().st_size}B")
PY

echo "[4/4] 轮换：过期事件被清理，未结案证据必须留下"
run_worker <<'PY'
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from audit_log import AuditLog

directory = Path(os.environ["VIDEO_FLOW_AUDIT_DIR"])
log = AuditLog(directory, echo=False, retention_days=1)
removed = log.rotate(now=datetime.now(timezone.utc) + timedelta(days=30))

# protected_paths() 返回的是路径名，不代表文件存在；断言要看目录实际内容。
protected = sorted({path.name for path in log.protected_paths()})
survivors = sorted(path.name for path in directory.iterdir())

problems = []
if not removed:
    problems.append("过期事件没有被清理，轮换没有真正生效")
for name in ("submissions.jsonl", "SUBMISSIONS_BLOCKED"):
    if name not in survivors:
        problems.append(f"轮换删掉了未结案证据 {name}: {survivors}")
if problems:
    print("      FAIL: " + "；".join(problems), file=sys.stderr)
    sys.exit(1)
print(f"      已清理 {[p.name for p in removed]}；目录现存 {survivors}（受保护名单 {protected}）")
PY

echo "容器重建证据恢复验证通过：审计、journal 与产物跨容器可恢复，轮换不吞未结案证据"
