#!/usr/bin/env bash
# §6 运行准备：验证隔离数据库的备份与恢复。
#
# "备份命令跑成功了"不等于"能恢复"。这里把源库 pg_dump 出来，恢复到一个全新的
# 隔离库，再逐表比对**行数与内容指纹**——恢复之后金额被静默取整、jsonb 掉字段、
# 迁移历史丢失，都是真实发生过的事故类型，只有比对内容才看得出来。
#
# 默认源库是本机验收环境；发布前把 VIDEO_FLOW_BACKUP_SOURCE_URL 指向生产备份，
# 就能用同一套比对验证真实备份可用。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/compose.contract.yml"
PROJECT_NAME="video-flow-backup-restore"
TARGET_PORT="${VIDEO_FLOW_BACKUP_TARGET_PORT:-55437}"
SOURCE_URL="${VIDEO_FLOW_BACKUP_SOURCE_URL:-postgresql://video_contract:video_contract@127.0.0.1:55434/video_flow_contract}"
TARGET_URL="postgresql://video_contract:video_contract@127.0.0.1:${TARGET_PORT}/video_flow_contract"
WORK_DIR="$(mktemp -d -t video-flow-backup-restore)"
DUMP_FILE="$WORK_DIR/dump.sql"

for tool in pg_dump psql; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "缺少 ${tool}；本脚本需要与容器同版本的 PostgreSQL 客户端（16）" >&2
    exit 2
  }
done

compose() {
  VIDEO_FLOW_CONTRACT_DB_PORT="$TARGET_PORT" docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" "$@"
}

cleanup() {
  compose down -v >/dev/null 2>&1 || true
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

# 指纹覆盖行数 + 金额精度 + jsonb 内容 + 迁移历史。
# 金额用 ::text 精确比较，避免恢复后 Decimal(18,6) 被静默改精度却看不出来。
fingerprint() {
  psql "$1" -t -A -v ON_ERROR_STOP=1 <<'SQL'
SELECT string_agg(line, E'\n' ORDER BY line) FROM (
  SELECT 'tasks ' || count(*) || ' ' || coalesce(md5(string_agg(id::text || '|' || coalesce(cost::text,'-'), ',' ORDER BY id)), '-') AS line FROM tasks
  UNION ALL
  SELECT 'attempts ' || count(*) || ' ' || coalesce(md5(string_agg(
      id::text || '|' || coalesce(estimated_cost_cny::text,'-') || '|' ||
      coalesce(usage_calculated_cost_cny::text,'-') || '|' || coalesce(billed_cost_cny::text,'-') || '|' ||
      coalesce(provider_usage::text,'-'), ',' ORDER BY id)), '-') FROM execution_attempts
  UNION ALL
  SELECT 'reservations ' || count(*) || ' ' || coalesce(md5(string_agg(
      id::text || '|' || reserved_cny::text || '|' || coalesce(settled_cny::text,'-') || '|' ||
      state || '|' || coalesce(review_amount_cny::text,'-'), ',' ORDER BY id)), '-') FROM task_budget_reservations
  UNION ALL
  SELECT 'preflights ' || count(*) || ' ' || coalesce(md5(string_agg(
      id::text || '|' || md5(effective_request::text) || '|' || md5(quote_snapshot::text) || '|' || md5(report::text),
      ',' ORDER BY id)), '-') FROM preflight_records
  UNION ALL
  SELECT 'assets ' || count(*) || ' ' || coalesce(md5(string_agg(
      id::text || '|' || object_key || '|' || coalesce(size_bytes::text,'-') || '|' ||
      coalesce(file_hash,'-') || '|' || coalesce(media_metadata::text,'-'), ',' ORDER BY id)), '-') FROM assets
  UNION ALL
  SELECT 'migrations ' || count(*) || ' ' || coalesce(md5(string_agg(migration_name, ',' ORDER BY migration_name)), '-') FROM _prisma_migrations
) fingerprints;
SQL
}

echo "源库: ${SOURCE_URL}"
echo "目标: ${TARGET_URL}（全新隔离库，结束后销毁）"

echo "[1/5] 取源库指纹"
source_fp="$(fingerprint "$SOURCE_URL")"
echo "$source_fp" | sed 's/^/      /'
grep -qE '^tasks [1-9]' <<<"$source_fp" || {
  echo "源库没有任何任务；备份恢复验证需要真实数据才有意义" >&2
  exit 2
}

echo "[2/5] 导出备份"
pg_dump --no-owner --no-privileges "$SOURCE_URL" > "$DUMP_FILE"
echo "      已导出 $(wc -c < "$DUMP_FILE" | tr -d ' ') 字节"

echo "[3/5] 启动目标库"
compose up -d --wait postgres

echo "[4/5] 恢复备份"
psql "$TARGET_URL" -q -v ON_ERROR_STOP=1 -f "$DUMP_FILE" >/dev/null

echo "[5/5] 比对指纹"
target_fp="$(fingerprint "$TARGET_URL")"
echo "$target_fp" | sed 's/^/      /'

if [[ "$source_fp" != "$target_fp" ]]; then
  echo "恢复后的内容与源库不一致：" >&2
  diff <(echo "$source_fp") <(echo "$target_fp") >&2 || true
  exit 1
fi

echo "备份恢复验证通过：行数、金额精度、jsonb 内容与迁移历史均一致"
