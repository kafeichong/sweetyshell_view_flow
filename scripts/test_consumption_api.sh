#!/bin/bash
# API测试脚本 - 消费和任务历史接口

BASE_URL="http://localhost:3100/api"
TOKEN="${VIDEO_FLOW_TOKEN:-$(cat ~/.video-flow/token 2>/dev/null || cat .preview-actor-token 2>/dev/null)}"

if [ -z "$TOKEN" ]; then
  echo "❌ 错误: 未找到认证token"
  echo "请设置环境变量: export VIDEO_FLOW_TOKEN=your_token"
  echo "或确保存在: ~/.video-flow/token 或 .preview-actor-token"
  exit 1
fi

echo "🔍 测试消费和任务历史API"
echo "================================"
echo ""

# 1. 测试消费概览
echo "📊 1. 测试消费概览 API"
echo "GET ${BASE_URL}/v1/consumption/overview"
curl -s -w "\nHTTP Status: %{http_code}\n" \
  -H "Authorization: Bearer ${TOKEN}" \
  "${BASE_URL}/v1/consumption/overview" | jq '.' || echo "请求失败"
echo ""
echo "--------------------------------"
echo ""

# 2. 测试消费趋势
echo "📈 2. 测试消费趋势 API (最近7天)"
echo "GET ${BASE_URL}/v1/consumption/trends?days=7"
curl -s -w "\nHTTP Status: %{http_code}\n" \
  -H "Authorization: Bearer ${TOKEN}" \
  "${BASE_URL}/v1/consumption/trends?days=7" | jq '.' || echo "请求失败"
echo ""
echo "--------------------------------"
echo ""

# 3. 测试任务列表（第一页）
echo "📋 3. 测试任务列表 API (第1页, 5条)"
echo "GET ${BASE_URL}/v1/tasks?page=1&limit=5"
curl -s -w "\nHTTP Status: %{http_code}\n" \
  -H "Authorization: Bearer ${TOKEN}" \
  "${BASE_URL}/v1/tasks?page=1&limit=5" | jq '.' || echo "请求失败"
echo ""
echo "--------------------------------"
echo ""

# 4. 测试任务列表（按状态筛选）
echo "🔍 4. 测试任务列表 - 按状态筛选 (completed)"
echo "GET ${BASE_URL}/v1/tasks?status=completed&limit=3"
curl -s -w "\nHTTP Status: %{http_code}\n" \
  -H "Authorization: Bearer ${TOKEN}" \
  "${BASE_URL}/v1/tasks?status=completed&limit=3" | jq '.' || echo "请求失败"
echo ""
echo "--------------------------------"
echo ""

# 5. 获取第一个任务的详情
echo "📄 5. 测试任务详情 API"
TASK_ID=$(curl -s -H "Authorization: Bearer ${TOKEN}" \
  "${BASE_URL}/v1/tasks?page=1&limit=1" | jq -r '.tasks[0].id // empty')

if [ -n "$TASK_ID" ]; then
  echo "获取任务详情: ${TASK_ID}"
  echo "GET ${BASE_URL}/v1/tasks/${TASK_ID}/detail"
  curl -s -w "\nHTTP Status: %{http_code}\n" \
    -H "Authorization: Bearer ${TOKEN}" \
    "${BASE_URL}/v1/tasks/${TASK_ID}/detail" | jq '.' || echo "请求失败"
else
  echo "⚠️  没有找到任务，跳过详情测试"
fi
echo ""
echo "--------------------------------"
echo ""

# 6. 测试工作流类型筛选
echo "🎬 6. 测试按工作流类型筛选"
echo "GET ${BASE_URL}/v1/tasks?workflowKey=seedance.text-to-video.v1&limit=2"
curl -s -w "\nHTTP Status: %{http_code}\n" \
  -H "Authorization: Bearer ${TOKEN}" \
  "${BASE_URL}/v1/tasks?workflowKey=seedance.text-to-video.v1&limit=2" | jq '.' || echo "请求失败"
echo ""
echo "--------------------------------"
echo ""

echo "✅ 测试完成"
echo ""
echo "📝 测试摘要:"
echo "  - 消费概览: /v1/consumption/overview"
echo "  - 消费趋势: /v1/consumption/trends"
echo "  - 任务列表: /v1/tasks"
echo "  - 任务详情: /v1/tasks/:id/detail"
echo ""
echo "💡 提示: 如果看到 401 错误，请检查token是否有效"
echo "💡 提示: 如果看到 404 错误，请确认后端服务是否运行在 ${BASE_URL}"
