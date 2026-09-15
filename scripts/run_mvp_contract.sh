#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/compose.contract.yml"
PROJECT_NAME="video-flow-contract"
CONTRACT_DB_PORT="${VIDEO_FLOW_CONTRACT_DB_PORT:-55432}"
CONTRACT_PROVIDER_PORT="${VIDEO_FLOW_CONTRACT_PROVIDER_PORT:-19091}"
# 仅供 contract-backend.cjs 的依赖替身使用：跨包矩阵必须覆盖全部已声明
# 工作流；正式 catalog 资源仍保持 fail-closed。
CONTRACT_READY_WORKFLOWS="${VIDEO_FLOW_CONTRACT_READY_WORKFLOWS:-seedance.text-to-video.v1,seedance.reference-image-to-video.v1,seedance.first-frame-to-video.v1,seedance.first-last-frame-to-video.v1,seedance.omni-reference.v1,seedance.video-edit.v1,seedance.video-extend.v1,seedance.audio-reference-to-video.v1}"
DATABASE_URL="postgresql://video_contract:video_contract@127.0.0.1:${CONTRACT_DB_PORT}/video_flow_contract"
UPGRADE_DATABASE_URL="postgresql://video_contract:video_contract@127.0.0.1:${CONTRACT_DB_PORT}/video_flow_upgrade_contract"
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

VIDEO_FLOW_FAKE_PROVIDER_PORT="$CONTRACT_PROVIDER_PORT" \
  "$CONTRACT_PYTHON" "$SCRIPT_DIR/fake_provider.py" >"$FAKE_PROVIDER_LOG" 2>&1 &
FAKE_PROVIDER_PID="$!"
for _ in $(seq 1 50); do
  if curl --fail --silent "http://127.0.0.1:${CONTRACT_PROVIDER_PORT}/api/v3/__test__/stats" >/dev/null; then
    break
  fi
  sleep 0.1
done
if ! curl --fail --silent "http://127.0.0.1:${CONTRACT_PROVIDER_PORT}/api/v3/__test__/stats" >/dev/null; then
  sed -n '1,120p' "$FAKE_PROVIDER_LOG" >&2
  exit 1
fi

docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" up -d --wait postgres

cd "$REPO_ROOT/packages/backend"
# 新环境必须能从空库直接执行完整 migration 链。
VIDEO_FLOW_TEST_MODE=1 \
DATABASE_URL="$DATABASE_URL" \
VIDEO_FLOW_PROVIDER_BASE_URL="http://127.0.0.1:${CONTRACT_PROVIDER_PORT}/api/v3" \
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
  -c "
    INSERT INTO tasks (id, created_by, prompt, cost)
    VALUES ('00000000-0000-0000-0000-000000000001', 'legacy-actor', 'legacy task', 1.23456789);
    INSERT INTO execution_attempts (
      id, task_id, attempt_no, mode, provider,
      estimated_cost_cny, usage_calculated_cost_cny, billed_cost_cny
    ) VALUES (
      '00000000-0000-0000-0000-000000000002',
      '00000000-0000-0000-0000-000000000001',
      1, 'production', 'seedance', 2.34567891, 3.45678912, 4.56789123
    );
  "
DATABASE_URL="$UPGRADE_DATABASE_URL" npx prisma migrate deploy
legacy_columns="$({ docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" exec -T postgres \
  psql -At -U video_contract -d video_flow_upgrade_contract \
  -c "SELECT (execution_plan IS NULL)::text || ':' || (delivery_status IS NULL)::text FROM tasks WHERE id = '00000000-0000-0000-0000-000000000001';"; } | tr -d '\r')"
if test "$legacy_columns" != "true:true"; then
  echo "Legacy task columns were unexpectedly inferred during migration" >&2
  exit 1
fi
preflight_table="$({ docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" exec -T postgres \
  psql -At -U video_contract -d video_flow_upgrade_contract \
  -c "SELECT to_regclass('public.preflight_records')::text;"; } | tr -d '\r')"
if test "$preflight_table" != "preflight_records"; then
  echo "PreflightRecord migration was not applied to the historical database" >&2
  exit 1
fi
legacy_task_count="$({ docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" exec -T postgres \
  psql -At -U video_contract -d video_flow_upgrade_contract \
  -c "SELECT count(*) FROM tasks WHERE id = '00000000-0000-0000-0000-000000000001';"; } | tr -d '\r')"
if test "$legacy_task_count" != "1"; then
  echo "Historical task was lost during PreflightRecord migration" >&2
  exit 1
fi
decimal_costs="$({ docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" exec -T postgres \
  psql -At -U video_contract -d video_flow_upgrade_contract \
  -c "
    SELECT cost::text || ':' || estimated_cost_cny::text || ':' ||
      usage_calculated_cost_cny::text || ':' || billed_cost_cny::text
    FROM tasks
    JOIN execution_attempts ON execution_attempts.task_id = tasks.id
    WHERE tasks.id = '00000000-0000-0000-0000-000000000001';
  "; } | tr -d '\r')"
if test "$decimal_costs" != "1.234570:2.345679:3.456789:4.567891"; then
  echo "Historical execution costs were not preserved as Decimal(18,6): $decimal_costs" >&2
  exit 1
fi

if test "${VIDEO_FLOW_MIGRATION_ONLY:-0}" = "1"; then
  echo 'Migration checks passed for fresh and historical databases'
  exit 0
fi

npm run build

if test "${VIDEO_FLOW_SKIP_LEGACY_CONTRACT_SUITES:-0}" != "1"; then
  VIDEO_FLOW_TEST_MODE=1 \
  DATABASE_URL="$DATABASE_URL" \
  VIDEO_FLOW_PROVIDER_BASE_URL="http://127.0.0.1:${CONTRACT_PROVIDER_PORT}/api/v3" \
    npm run test:contract -- --runInBand
else
  echo '按显式配置跳过旧合同套件，仅运行新工作流纵向合同'
fi

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
      INSERT INTO assets (id, owner_id, role, object_key, file_hash, inspection_status, media_type, mime_type, media_metadata, size_bytes)
      VALUES (gen_random_uuid(), 'live-contract-actor', 'input', 'live-contract/reference.png', '2bec78f9edca83498eba36c257e0d0a95a0ff0a21c6ff985739c51a5e0c81ec5', 'verified', 'image', 'image/png', json_build_object('kind', 'image', 'width', 1280, 'height', 720), 43)
      ON CONFLICT (owner_id, role, file_hash) DO NOTHING;
      INSERT INTO assets (id, owner_id, role, object_key, file_hash, inspection_status, media_type, mime_type, media_metadata, size_bytes)
      VALUES (gen_random_uuid(), 'live-contract-actor', 'input', 'live-contract/last.png', 'bbe001f704b684e176736ece7542c7e3edb76b3c3e5b0ed4c14f9f89c2365587', 'verified', 'image', 'image/png', json_build_object('kind', 'image', 'width', 1280, 'height', 720), 38)
      ON CONFLICT (owner_id, role, file_hash) DO NOTHING;
      INSERT INTO assets (id, owner_id, role, object_key, file_hash, inspection_status, media_type, mime_type, media_metadata, size_bytes)
      VALUES (gen_random_uuid(), 'live-contract-actor', 'input', 'live-contract/audio.wav', '80e4320275831d70a161ed0c0b35a1d92d61ed537a29c772e06d9129c3509883', 'verified', 'audio', 'audio/wav', json_build_object('kind', 'audio', 'durationSeconds', 10, 'audioCodec', 'pcm_s16le'), 39)
      ON CONFLICT (owner_id, role, file_hash) DO NOTHING;
      INSERT INTO assets (id, owner_id, role, object_key, file_hash, inspection_status, media_type, mime_type, media_metadata, size_bytes)
      VALUES (gen_random_uuid(), 'live-contract-actor', 'input', 'live-contract/video.mp4', '5df585981ac0b823eedcf3580e24ad2db223b7829bbaa593e2d3c2d835557f85', 'verified', 'video', 'video/mp4', json_build_object('kind', 'video', 'width', 1280, 'height', 720, 'durationSeconds', 6, 'frameRate', 24, 'videoCodec', 'h264', 'audioCodec', 'aac'), 39)
      ON CONFLICT (owner_id, role, file_hash) DO NOTHING;
    " >/dev/null

  LIVE_ASSET_ID="$(docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" exec -T postgres \
    psql -At -U video_contract -d video_flow_contract -c "
      SELECT id FROM assets
      WHERE owner_id = 'live-contract-actor' AND object_key = 'live-contract/reference.png';" | tr -d '\r')"
  if test -z "$LIVE_ASSET_ID"; then
    echo '未能准备跨包合同的输入素材' >&2
    exit 1
  fi
  LIVE_LAST_ASSET_ID="$(docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" exec -T postgres \
    psql -At -U video_contract -d video_flow_contract -c "
      SELECT id FROM assets
      WHERE owner_id = 'live-contract-actor' AND object_key = 'live-contract/last.png';" | tr -d '\r')"
  if test -z "$LIVE_LAST_ASSET_ID"; then
    echo '未能准备跨包合同的尾帧输入素材' >&2
    exit 1
  fi
  LIVE_AUDIO_ASSET_ID="$(docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" exec -T postgres \
    psql -At -U video_contract -d video_flow_contract -c "
      SELECT id FROM assets
      WHERE owner_id = 'live-contract-actor' AND object_key = 'live-contract/audio.wav';" | tr -d '\r')"
  LIVE_VIDEO_ASSET_ID="$(docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" exec -T postgres \
    psql -At -U video_contract -d video_flow_contract -c "
      SELECT id FROM assets
      WHERE owner_id = 'live-contract-actor' AND object_key = 'live-contract/video.mp4';" | tr -d '\r')"
  if test -z "$LIVE_AUDIO_ASSET_ID" || test -z "$LIVE_VIDEO_ASSET_ID"; then
    echo '未能准备跨包合同的音频或视频输入素材' >&2
    exit 1
  fi

  cd "$REPO_ROOT/packages/backend"
  VIDEO_FLOW_TEST_MODE=1 \
  DATABASE_URL="$DATABASE_URL" \
  VIDEO_FLOW_PROVIDER_BASE_URL="http://127.0.0.1:${CONTRACT_PROVIDER_PORT}/api/v3" \
  VIDEO_FLOW_ADMIN_TOKEN="$LIVE_ADMIN_TOKEN" \
  VIDEO_FLOW_WORKER_TOKEN="$LIVE_WORKER_TOKEN" \
  VIDEO_FLOW_PRODUCTION_ACTORS="live-contract-actor" \
  VIDEO_FLOW_CONTRACT_READY_WORKFLOWS="$CONTRACT_READY_WORKFLOWS" \
  VIDEO_FLOW_DAILY_TASK_LIMIT="1000" \
  OSS_ACCESS_KEY_ID="live-contract-oss" \
  OSS_ACCESS_KEY_SECRET="live-contract-oss-secret" \
  OSS_BUCKET="live-contract-bucket" \
  OSS_REGION="oss-cn-beijing" \
  PORT=$LIVE_PORT \
  node test/contract-backend.cjs >"$LIVE_LOG" 2>&1 &
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
  LIVE_PYTEST_TARGET="${VIDEO_FLOW_LIVE_PYTEST_TARGET:-tests/test_mvp_live_contract.py}"
  VIDEO_FLOW_TEST_MODE=1 \
  DATABASE_URL="$DATABASE_URL" \
  VIDEO_FLOW_PROVIDER_BASE_URL="http://127.0.0.1:${CONTRACT_PROVIDER_PORT}/api/v3" \
  BACKEND_URL="http://127.0.0.1:$LIVE_PORT" \
  WORKER_SERVICE_TOKEN="$LIVE_WORKER_TOKEN" \
  VIDEO_FLOW_WORKER_TOKEN="$LIVE_WORKER_TOKEN" \
  VIDEO_FLOW_ADMIN_TOKEN="$LIVE_ADMIN_TOKEN" \
  VIDEO_FLOW_LIVE_BASE_URL="http://127.0.0.1:$LIVE_PORT" \
  VIDEO_FLOW_LIVE_PROVIDER_URL="http://127.0.0.1:${CONTRACT_PROVIDER_PORT}" \
  VIDEO_FLOW_LIVE_ACTOR_TOKEN="$LIVE_ACTOR_TOKEN" \
  VIDEO_FLOW_LIVE_ASSET_ID="$LIVE_ASSET_ID" \
  VIDEO_FLOW_LIVE_LAST_ASSET_ID="$LIVE_LAST_ASSET_ID" \
  VIDEO_FLOW_LIVE_AUDIO_ASSET_ID="$LIVE_AUDIO_ASSET_ID" \
  VIDEO_FLOW_LIVE_VIDEO_ASSET_ID="$LIVE_VIDEO_ASSET_ID" \
  VIDEO_FLOW_AUDIT_DIR="$(mktemp -d -t video-flow-live-audit.XXXXXX)" \
  COMFYUI_OUTPUT_DIR="$(mktemp -d -t video-flow-live-output.XXXXXX)" \
OSS_ENDPOINT="http://127.0.0.1:${CONTRACT_PROVIDER_PORT}/oss" \
OSS_CNAME=1 \
OSS_ACCESS_KEY_ID="live-contract-oss" \
OSS_ACCESS_KEY_SECRET="live-contract-oss-secret" \
  OSS_BUCKET="live-contract-bucket" \
  OSS_REGION="oss-cn-beijing" \
  ALL_PROXY="" \
  all_proxy="" \
  HTTP_PROXY="" \
  http_proxy="" \
  HTTPS_PROXY="" \
  https_proxy="" \
  NO_PROXY="127.0.0.1,localhost" \
  no_proxy="127.0.0.1,localhost" \
    "$CONTRACT_WORKER_PYTHON" -m pytest "$LIVE_PYTEST_TARGET" -m live_contract -p no:cacheprovider || {
    echo '跨包合同失败；后端日志：' >&2
    tail -60 "$LIVE_LOG" >&2
    exit 1
  }

  # 漏跑必须失败：跨包用例被静默排除等于没跑。
  live_collect_output="$("$CONTRACT_WORKER_PYTHON" -m pytest "$LIVE_PYTEST_TARGET" -m live_contract \
    --collect-only -q -p no:cacheprovider 2>/dev/null)"
  live_collected="$(echo "$live_collect_output" | awk '{ for (i = 1; i <= NF; i++) if ($i == "collected" && i >= 3) print $(i - 2) }')"
  if test -z "$live_collected"; then
    echo "跨包合同用例收集失败: $live_collect_output" >&2
    exit 1
  fi
  minimum_live_tests="${VIDEO_FLOW_LIVE_MIN_TESTS:-5}"
  if test "$live_collected" -lt "$minimum_live_tests"; then
    echo "跨包合同用例数异常（过少）: $live_collect_output" >&2
    exit 1
  fi
fi
