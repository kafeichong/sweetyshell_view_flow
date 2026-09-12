#!/usr/bin/env bash
# T11：Worker 与 Fake Provider 都跑在 Docker 里时，验证服务名寻址。
#
# 宿主机合同脚本用 127.0.0.1:19091；容器内的 127.0.0.1 只指向容器自身，
# 必须改用服务名 http://fake-provider:19091/api/v3。这条不用真跑一次容器
# 是验证不了的——配置写对了不代表连得通。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/compose.contract.yml"
PROJECT_NAME="video-flow-contract-addressing"

cleanup() {
  docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" down -v >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" up -d --wait fake-provider

# 在容器里用真实适配器打服务名，并让同一个容器读回统计做断言。
output="$(
  docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" run --rm --no-deps -T worker-contract \
    python -c '
import asyncio, json, os
import httpx
from providers.seedance_adapter import SeedanceAdapter

async def main():
    adapter = SeedanceAdapter(api_key="")
    base = os.environ["VIDEO_FLOW_PROVIDER_BASE_URL"]
    print("provider_base_url=" + base)
    result = await adapter.create_task({"prompt": "docker addressing probe", "model": "m"})
    print("created=" + result["task_id"])
    await adapter.client.aclose()
    stats = httpx.get(base + "/__test__/stats", timeout=10).json()
    print("stats=" + json.dumps(stats, sort_keys=True))

asyncio.run(main())
'
)"

echo "$output"

grep -q "provider_base_url=http://fake-provider:19091/api/v3" <<<"$output" || {
  echo '容器内使用的不是服务名地址' >&2
  exit 1
}
grep -q '"createCountsByKey": {"docker addressing probe": 1}' <<<"$output" || {
  echo '服务名寻址没有真正创建任务' >&2
  exit 1
}

echo 'T11 Docker 服务名寻址验证通过'
