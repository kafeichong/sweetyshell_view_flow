#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/compose.contract.yml"
PROJECT_NAME="video-flow-contract"
DATABASE_URL="postgresql://video_contract:video_contract@127.0.0.1:55432/video_flow_contract"
if test -x "$REPO_ROOT/packages/worker/venv/bin/python"; then
  CONTRACT_PYTHON="$REPO_ROOT/packages/worker/venv/bin/python"
else
  CONTRACT_PYTHON="${VIDEO_FLOW_CONTRACT_PYTHON:-python3}"
fi
FAKE_PROVIDER_PID=""
FAKE_PROVIDER_LOG="$(mktemp -t video-flow-fake-provider.XXXXXX)"

cleanup() {
  if test -n "$FAKE_PROVIDER_PID"; then
    kill "$FAKE_PROVIDER_PID" >/dev/null 2>&1 || true
    wait "$FAKE_PROVIDER_PID" >/dev/null 2>&1 || true
  fi
  docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" down -v >/dev/null 2>&1 || true
}
trap cleanup EXIT

"$CONTRACT_PYTHON" "$SCRIPT_DIR/fake_provider.py" >"$FAKE_PROVIDER_LOG" 2>&1 &
FAKE_PROVIDER_PID="$!"
for _ in $(seq 1 50); do
  if curl --fail --silent "http://127.0.0.1:19091/__test__/stats" >/dev/null; then
    break
  fi
  sleep 0.1
done
if ! curl --fail --silent "http://127.0.0.1:19091/__test__/stats" >/dev/null; then
  sed -n '1,120p' "$FAKE_PROVIDER_LOG" >&2
  exit 1
fi

docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" up -d --wait postgres

cd "$REPO_ROOT/packages/backend"
# 当前历史 migration 在空库上的顺序仍需 T01 以新增兼容 migration 修复。
# T00 只验证当前 schema 的真实 HTTP/数据库合同，不能修改已登记的生产 migration。
VIDEO_FLOW_TEST_MODE=1 \
DATABASE_URL="$DATABASE_URL" \
VIDEO_FLOW_PROVIDER_BASE_URL="http://127.0.0.1:19091" \
npx prisma db push --skip-generate
npm run build

VIDEO_FLOW_TEST_MODE=1 \
DATABASE_URL="$DATABASE_URL" \
VIDEO_FLOW_PROVIDER_BASE_URL="http://127.0.0.1:19091" \
npm run test:contract -- --runInBand

cd "$REPO_ROOT"
"$CONTRACT_PYTHON" -m pytest scripts/tests/test_fake_provider.py -q
