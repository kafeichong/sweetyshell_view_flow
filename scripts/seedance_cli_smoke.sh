#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-https://ai.sweetyshell.com/api/v1}"
ACTOR_ID="${ACTOR_ID:-creator-$(date +%s)}"
TOKEN_FILE="${VIDEO_FLOW_TOKEN_FILE:-$HOME/.video-flow/token}"
ACTOR_TOKEN="${VIDEO_FLOW_TOKEN:-}"
PROMPT="${PROMPT:-A premium product hero video, smooth motion, white background}"
DURATION="${DURATION:-5}"
PROFILE="${PROFILE:-seedance}"
IDEMPOTENCY_KEY="${IDEMPOTENCY_KEY:-seedance-${ACTOR_ID}-$(date +%s)}"
IMAGE_URL="${IMAGE_URL:-}"
# 缺省走 preview：不生成付费任务，只返回服务端请求摘要。
# 需要真实出片时必须显式 MODE=production，且该 actor 需在服务端被授权。
MODE="${MODE:-preview}"

# 有参考图时走图生视频；无参考图时明确走文生视频。调用者仍可显式覆盖。
if [ -n "$IMAGE_URL" ]; then
  DEFAULT_CAPABILITY="IMAGE_TO_VIDEO"
else
  DEFAULT_CAPABILITY="TEXT_TO_VIDEO"
fi
CAPABILITY="${CAPABILITY:-$DEFAULT_CAPABILITY}"

command -v curl >/dev/null || { echo "error: curl not found"; exit 1; }
command -v python3 >/dev/null || { echo "error: python3 not found"; exit 1; }

if [ -z "$ACTOR_TOKEN" ] && [ -f "$TOKEN_FILE" ]; then
  ACTOR_TOKEN=$(tr -d '\r\n' < "$TOKEN_FILE")
fi

if [ -z "$ACTOR_TOKEN" ]; then
  echo "error: 请设置 VIDEO_FLOW_TOKEN，或将个人 token 保存到 $TOKEN_FILE"
  exit 1
fi

echo "actor token loaded"

task_payload=$(PROMPTV="$PROMPT" DURATIONV="$DURATION" PROFILEV="$PROFILE" CAPABILITYV="$CAPABILITY" IMAGE_URL="$IMAGE_URL" MODEV="$MODE" python3 - <<'PY'
import json
import os
params = {
  "prompt": os.environ["PROMPTV"],
  "duration": int(os.environ.get("DURATIONV", "5")),
}
img = os.environ.get("IMAGE_URL", "")
if img:
  params["image_url"] = img
payload = {
  "capability": os.environ["CAPABILITYV"],
  "profile": os.environ["PROFILEV"],
  "params": params,
  "mode": os.environ["MODEV"],
}
print(json.dumps(payload))
PY)

task=$(curl -sS -X POST "$BASE_URL/tasks" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ACTOR_TOKEN" \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
  -d "$task_payload")

task_id=$(TASK_JSON="$task" python3 - <<'PY'
import json
import os
obj = json.loads(os.environ['TASK_JSON'])
print(obj.get('id',''))
PY)

if [ -z "$task_id" ]; then
  echo "create task failed: $task"
  exit 1
fi

echo "✅ task created: $task_id"

# Preview 任务不会进入执行队列，也没有可轮询的最终状态，直接打印摘要退出即可。
if TASK_JSON="$task" python3 -c 'import json,os,sys; sys.exit(0 if json.loads(os.environ["TASK_JSON"]).get("preview") else 1)'; then
  echo "ℹ️  mode=preview：未创建付费任务，无 Provider 调用。请求摘要："
  echo "$task"
  exit 0
fi

echo "➡️  polling status..."
for i in $(seq 1 60); do
  result=$(curl -sS -X GET "$BASE_URL/tasks/$task_id" -H "Authorization: Bearer $ACTOR_TOKEN")
  status=$(RESULT_JSON="$result" python3 - <<'PY'
import json
import os
obj = json.loads(os.environ['RESULT_JSON'])
print((obj.get('status') or obj.get('taskStatus') or '').lower())
PY)
  if [ "$status" = "completed" ] || [ "$status" = "failed" ] || [ "$status" = "cancelled" ]; then
    break
  fi
  sleep 10
  echo "poll $i: $status"
done

final=$(curl -sS -X GET "$BASE_URL/tasks/$task_id" -H "Authorization: Bearer $ACTOR_TOKEN")
echo "$final"
