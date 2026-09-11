#!/bin/bash
# T02 验收测试：额度预占与原子准入

BASE_URL="http://localhost:3100/api"
ADMIN_TOKEN="${VIDEO_FLOW_ADMIN_TOKEN:-test-admin-token-2026}"

echo "=== T02 额度预占与原子准入测试 ==="
echo ""

# 1. 创建测试凭证（额度 100）
echo "1. 创建测试凭证（额度 100）"
CREATE_RESP=$(curl -s -X POST "$BASE_URL/v1/admin/credentials" \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"actorId":"test-quota-actor","name":"quota-test"}')

API_KEY=$(echo "$CREATE_RESP" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
echo "API Key: $API_KEY"
echo ""

# 2. 设置额度为 100
echo "2. 设置额度为 100"
curl -s -X PATCH "$BASE_URL/v1/admin/credentials/test-quota-actor/limits" \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"dailyLimitCny":"100.000000","monthlyLimitCny":"1000.000000"}' | jq '.'
echo ""

# 3. 提交任务1（消耗 60）
echo "3. 提交任务1（预期消耗 60）"
TASK1=$(curl -s -X POST "$BASE_URL/v1/tasks" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Idempotency-Key: quota-test-task-1" \
  -H "Content-Type: application/json" \
  -d '{
    "mode": "production",
    "capability": "TEXT_TO_VIDEO",
    "profile": "seedance-v1",
    "params": {
      "prompt": "test quota 1"
    }
  }' | jq -r '.id')
echo "Task1 ID: $TASK1"
echo ""

# 4. 检查余额（应该是 40）
echo "4. 检查余额（应该约为 40）"
# TODO: 实现获取剩余额度的 API
echo "剩余额度: (待实现查询接口)"
echo ""

# 5. 提交任务2（消耗 60，应该被拒绝）
echo "5. 提交任务2（预期消耗 60，应该被拒绝 - 余额不足）"
HTTP_CODE=$(curl -s -w "%{http_code}" -o /tmp/task2.json -X POST "$BASE_URL/v1/tasks" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Idempotency-Key: quota-test-task-2" \
  -H "Content-Type: application/json" \
  -d '{
    "mode": "production",
    "capability": "TEXT_TO_VIDEO",
    "profile": "seedance-v1",
    "params": {
      "prompt": "test quota 2"
    }
  }')
TASK2_BODY=$(cat /tmp/task2.json)

echo "HTTP Status: $HTTP_CODE"
echo "Response: $TASK2_BODY" | jq '.'
echo ""

if [ "$HTTP_CODE" = "402" ] || [ "$HTTP_CODE" = "403" ] || [ "$HTTP_CODE" = "429" ]; then
  echo "✅ 测试通过：任务被正确拒绝（额度不足）"
else
  echo "❌ 测试失败：任务应该被拒绝但状态码是 $HTTP_CODE"
fi
echo ""

echo "=== 测试完成 ==="
echo "预期结果："
echo "- 任务1 成功（100 - 60 = 40）"
echo "- 任务2 被拒绝（40 < 60）"
