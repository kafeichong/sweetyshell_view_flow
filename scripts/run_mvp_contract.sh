#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/compose.contract.yml"
PROJECT_NAME="video-flow-contract"
DATABASE_URL="postgresql://video_contract:video_contract@127.0.0.1:55432/video_flow_contract"
UPGRADE_DATABASE_URL="postgresql://video_contract:video_contract@127.0.0.1:55432/video_flow_upgrade_contract"
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
  if curl --fail --silent "http://127.0.0.1:19091/api/v3/__test__/stats" >/dev/null; then
    break
  fi
  sleep 0.1
done
if ! curl --fail --silent "http://127.0.0.1:19091/api/v3/__test__/stats" >/dev/null; then
  sed -n '1,120p' "$FAKE_PROVIDER_LOG" >&2
  exit 1
fi

docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" up -d --wait postgres

cd "$REPO_ROOT/packages/backend"
# 新环境必须能从空库直接执行完整 migration 链。
VIDEO_FLOW_TEST_MODE=1 \
DATABASE_URL="$DATABASE_URL" \
VIDEO_FLOW_PROVIDER_BASE_URL="http://127.0.0.1:19091/api/v3" \
npx prisma migrate deploy

# 模拟生产库已按历史实际顺序登记四个 migration，再验证新增兼容
# migration 可以向前升级；整个过程只使用隔离 PostgreSQL。
docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" exec -T postgres \
  createdb -U video_contract video_flow_upgrade_contract
for migration in \
  20260909000000_init \
  20260910_expand_execution_domain \
  20260911000000_add_attempt_model \
  20260910193000_add_asset_owner_role_hash_unique
do
  docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U video_contract -d video_flow_upgrade_contract \
    < "$REPO_ROOT/packages/backend/prisma/migrations/$migration/migration.sql"
  DATABASE_URL="$UPGRADE_DATABASE_URL" \
    npx prisma migrate resolve --applied "$migration"
done
docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U video_contract -d video_flow_upgrade_contract \
  -c "INSERT INTO tasks (id, created_by, prompt) VALUES ('00000000-0000-0000-0000-000000000001', 'legacy-actor', 'legacy task');"
DATABASE_URL="$UPGRADE_DATABASE_URL" npx prisma migrate deploy
legacy_columns="$({ docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" exec -T postgres \
  psql -At -U video_contract -d video_flow_upgrade_contract \
  -c "SELECT (execution_plan IS NULL)::text || ':' || (delivery_status IS NULL)::text FROM tasks WHERE id = '00000000-0000-0000-0000-000000000001';"; } | tr -d '\r')"
if test "$legacy_columns" != "true:true"; then
  echo "Legacy task columns were unexpectedly inferred during migration" >&2
  exit 1
fi

npm run build

VIDEO_FLOW_TEST_MODE=1 \
DATABASE_URL="$DATABASE_URL" \
VIDEO_FLOW_PROVIDER_BASE_URL="http://127.0.0.1:19091/api/v3" \
npm run test:contract -- --runInBand

cd "$REPO_ROOT"
"$CONTRACT_PYTHON" -m pytest scripts/tests/test_fake_provider.py -q
