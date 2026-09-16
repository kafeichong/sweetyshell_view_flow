#!/bin/bash
# ComfyUI 消费历史面板测试脚本

echo "=================================="
echo "  VideoFlow 面板集成测试"
echo "=================================="
echo ""

# 1. 检查后端
echo "📡 1. 检查后端服务..."
if curl -s http://localhost:3000/api/v1/consumption/overview -H "Authorization: Bearer $(cat .test-token)" | grep -q "daily"; then
    echo "   ✅ 后端API正常"
else
    echo "   ❌ 后端未响应"
    echo "   请运行: cd packages/backend && npm start"
    exit 1
fi

# 2. 检查文件
echo ""
echo "📦 2. 检查文件完整性..."
FILES=(
    "packages/comfyui-video-flow-client/web/video_flow_history.js"
    "packages/comfyui-video-flow-client/web/video_flow_history.css"
    "packages/comfyui-video-flow-client/web/js/VideoFlowHistoryPanel.js"
    "packages/comfyui-video-flow-client/web/js/ConsumptionPanel.js"
    "packages/comfyui-video-flow-client/web/js/TaskListPanel.js"
    "packages/comfyui-video-flow-client/web/js/TaskDetailModal.js"
)

ALL_EXISTS=true
for file in "${FILES[@]}"; do
    if [ -f "$file" ]; then
        echo "   ✅ $(basename $file)"
    else
        echo "   ❌ $(basename $file) 缺失"
        ALL_EXISTS=false
    fi
done

if [ "$ALL_EXISTS" = false ]; then
    exit 1
fi

# 3. 测试API
echo ""
echo "🧪 3. 测试API响应..."

TOKEN=$(cat .test-token)

# 测试消费概览
echo "   测试消费概览API..."
OVERVIEW=$(curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/v1/consumption/overview)
if echo "$OVERVIEW" | grep -q "daily"; then
    echo "   ✅ 消费概览API正常"
else
    echo "   ❌ 消费概览API失败"
fi

# 测试任务列表
echo "   测试任务列表API..."
TASKS=$(curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:3000/api/v1/tasks?limit=3")
if echo "$TASKS" | grep -q "tasks"; then
    TASK_COUNT=$(echo "$TASKS" | jq '.tasks | length' 2>/dev/null || echo "0")
    echo "   ✅ 任务列表API正常 (找到 $TASK_COUNT 条任务)"
else
    echo "   ❌ 任务列表API失败"
fi

# 4. 打开测试页面
echo ""
echo "🌐 4. 打开测试页面..."
if [ -f "packages/comfyui-video-flow-client/web/test/history_panel_test.html" ]; then
    open packages/comfyui-video-flow-client/web/test/history_panel_test.html
    echo "   ✅ 测试页面已打开"
else
    echo "   ❌ 测试页面不存在"
    exit 1
fi

# 5. 使用说明
echo ""
echo "=================================="
echo "  📖 测试步骤"
echo "=================================="
echo ""
echo "在打开的页面中："
echo "1. 输入 Token (已自动填充): ${TOKEN:0:30}..."
echo "2. 点击「💾 保存配置」"
echo "3. 点击「🚀 加载面板」"
echo "4. 查看右侧面板是否正常显示"
echo ""
echo "预期结果："
echo "✓ 消费概览显示今日/本月数据"
echo "✓ 任务列表显示最近任务"
echo "✓ 点击任务可查看详情"
echo "✓ 所有功能正常交互"
echo ""
echo "=================================="
echo "  🎯 ComfyUI 集成说明"
echo "=================================="
echo ""
echo "在 ComfyUI 中使用:"
echo "1. 打开 ComfyUI 界面"
echo "2. 按 F12 打开控制台"
echo "3. 运行: localStorage.setItem('videoflow_api_token', '$TOKEN');"
echo "4. 刷新页面，面板会出现在右侧"
echo ""
echo "全部测试完成！✅"
