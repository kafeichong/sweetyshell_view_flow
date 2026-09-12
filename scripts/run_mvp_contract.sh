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

# 合同环境绝不能持有真实 Provider 凭证：有就直接失败，
# 而不是"碰巧没用到"。CI 与本地都走这道闸门。
if test -n "${VOLCENGINE_ACCESS_KEY:-}"; then
  echo 'VOLCENGINE_ACCESS_KEY must be empty for contract tests' >&2
  exit 1
fi

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


# T11 跨包合同：真实 Worker 代码 + 真实 Backend/DB + Fake Provider。
#
# 默认开启。覆盖"预览不创建 Provider 任务"与"同一意图只创建一次、重跑沿用原 ID"
# 两条跨包不变量。产物交付那一段依赖真实对象存储（合同环境按规约不用真实凭证、
# 也没有 OSS 替身），由各包用例覆盖，端到端留到 T12。
if test "${VIDEO_FLOW_RUN_LIVE_CONTRACT:-1}" != "1"; then
  echo 'T11 跨包合同被显式关闭（VIDEO_FLOW_RUN_LIVE_CONTRACT=0）' >&2
else

  # 起一个独立 Backend 实例（与 jest 合同的实例无关），并写入一条测试凭证。
  LIVE_ACTOR_TOKEN="vf_live_contract_actor_token"
  LIVE_ADMIN_TOKEN="live-contract-admin-token"
  LIVE_WORKER_TOKEN="live-contract-worker-token"
  LIVE_PORT=3399
  LIVE_LOG="$(mktemp -t video-flow-live-backend.XXXXXX)"

  actor_hash="$(printf '%s' "$LIVE_ACTOR_TOKEN" | shasum -a 256 | cut -d' ' -f1)"
  docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U video_contract -d video_flow_contract -c "
      INSERT INTO actor_credentials (id, actor_id, name, token_hash, status, daily_limit_cny, monthly_limit_cny)
      VALUES (gen_random_uuid(), 'live-contract-actor', 'live contract actor', '$actor_hash', 'active', 100, 1000)
      ON CONFLICT (actor_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, status = 'active';
      INSERT INTO production_gates (id, paused, reason) VALUES ('production', false, 'live contract')
      ON CONFLICT (id) DO UPDATE SET paused = false, reason = 'live contract';
      INSERT INTO assets (id, owner_id, role, object_key, file_hash, inspection_status, media_type)
      VALUES (gen_random_uuid(), 'live-contract-actor', 'input', 'live-contract/reference.png', repeat('a', 64), 'uploaded', 'image')
      ON CONFLICT (owner_id, role, file_hash) DO NOTHING;
    " >/dev/null

  LIVE_ASSET_ID="$(docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" exec -T postgres \
    psql -At -U video_contract -d video_flow_contract -c "
      SELECT id FROM assets
      WHERE owner_id = 'live-contract-actor' AND role = 'input' AND inspection_status = 'uploaded'
      ORDER BY created_at LIMIT 1;" | tr -d '\r')"
  if test -z "$LIVE_ASSET_ID"; then
    echo '未能准备跨包合同的输入素材' >&2
    exit 1
  fi

  cd "$REPO_ROOT/packages/backend"
  VIDEO_FLOW_TEST_MODE=1 \
  DATABASE_URL="$DATABASE_URL" \
  VIDEO_FLOW_PROVIDER_BASE_URL="http://127.0.0.1:19091/api/v3" \
  VIDEO_FLOW_ADMIN_TOKEN="$LIVE_ADMIN_TOKEN" \
  VIDEO_FLOW_WORKER_TOKEN="$LIVE_WORKER_TOKEN" \
  VIDEO_FLOW_PRODUCTION_ACTORS="live-contract-actor" \
  OSS_ACCESS_KEY_ID="live-contract-oss" \
  OSS_ACCESS_KEY_SECRET="live-contract-oss-secret" \
  OSS_BUCKET="live-contract-bucket" \
  OSS_REGION="oss-cn-beijing" \
  VIDEO_FLOW_PRODUCTION_SPEC_JSON='{"version":"live-v1","model":"doubao-seedance-2-5-260628","duration":5,"ratio":"16:9","resolution":"720p","generateAudio":false,"watermark":true,"pricingVersion":"seedance-token-v1","reserveCny":"2.000000"}' \
  PORT=$LIVE_PORT \
  node dist/src/main.js >"$LIVE_LOG" 2>&1 &
  LIVE_BACKEND_PID="$!"
  cleanup_live() {
    kill "$LIVE_BACKEND_PID" >/dev/null 2>&1 || true
    wait "$LIVE_BACKEND_PID" >/dev/null 2>&1 || true
  }
  trap 'cleanup_live; cleanup' EXIT

  for _ in $(seq 1 50); do
    live_status="$(curl --silent -o /dev/null -w '%{http_code}' "http://127.0.0.1:$LIVE_PORT/api/tasks" || true)"
    if test "$live_status" = "401"; then
      break
    fi
    sleep 0.2
  done

  cd "$REPO_ROOT/packages/worker"
  CONTRACT_WORKER_PYTHON="python3"
  if test -x "venv/bin/python"; then
    CONTRACT_WORKER_PYTHON="$REPO_ROOT/packages/worker/venv/bin/python"
  fi

  # 跨包用例的环境变量（注意：续行里不能出现注释，否则会把赋值截断）。
  # - Worker 的 Settings 字段是 backend_url / worker_service_token，对应 env 是
  #   BACKEND_URL / WORKER_SERVICE_TOKEN，不是客户端脚本用的
  #   VIDEO_FLOW_BACKEND_URL / VIDEO_FLOW_WORKER_TOKEN。
  # - 宿主机没有容器里的 /app/output 与 /app/audit，用临时目录替代。
  # - 本机可能挂着 SOCKS/HTTP 代理：回环地址必须直连，否则 create 会打到代理上。
  VIDEO_FLOW_TEST_MODE=1 \
  DATABASE_URL="$DATABASE_URL" \
  VIDEO_FLOW_PROVIDER_BASE_URL="http://127.0.0.1:19091/api/v3" \
  BACKEND_URL="http://127.0.0.1:$LIVE_PORT" \
  WORKER_SERVICE_TOKEN="$LIVE_WORKER_TOKEN" \
  VIDEO_FLOW_WORKER_TOKEN="$LIVE_WORKER_TOKEN" \
  VIDEO_FLOW_ADMIN_TOKEN="$LIVE_ADMIN_TOKEN" \
  VIDEO_FLOW_LIVE_BASE_URL="http://127.0.0.1:$LIVE_PORT" \
  VIDEO_FLOW_LIVE_PROVIDER_URL="http://127.0.0.1:19091" \
  VIDEO_FLOW_LIVE_ACTOR_TOKEN="$LIVE_ACTOR_TOKEN" \
  VIDEO_FLOW_LIVE_ASSET_ID="$LIVE_ASSET_ID" \
  VIDEO_FLOW_AUDIT_DIR="$(mktemp -d -t video-flow-live-audit.XXXXXX)" \
  COMFYUI_OUTPUT_DIR="$(mktemp -d -t video-flow-live-output.XXXXXX)" \
OSS_ENDPOINT="http://127.0.0.1:19091/oss" \
OSS_CNAME=1 \
OSS_ACCESS_KEY_ID="live-contract-oss" \
OSS_ACCESS_KEY_SECRET="live-contract-oss-secret" \
OSS_BUCKET="live-contract-bucket" \
OSS_REGION="oss-cn-beijing" \
  NO_PROXY="127.0.0.1,localhost" \
  no_proxy="127.0.0.1,localhost" \
  "$CONTRACT_WORKER_PYTHON" -m pytest tests/test_mvp_live_contract.py -m live_contract -p no:cacheprovider || {
    echo '跨包合同失败；后端日志：' >&2
    tail -60 "$LIVE_LOG" >&2
    exit 1
  }

  # 漏跑必须失败：跨包用例被静默排除等于没跑。
  live_collected="$("$CONTRACT_WORKER_PYTHON" -m pytest tests/test_mvp_live_contract.py -m live_contract \
    --collect-only -q -p no:cacheprovider 2>/dev/null | tail -1)"
  case "$live_collected" in
    *'5 tests collected'*) ;;
    *) echo "跨包合同用例数异常: $live_collected" >&2; exit 1 ;;
  esac
fi
