#!/bin/bash

# 账单分配 MVP 集成测试运行脚本
#
# 使用方法:
#   ./run-integration-test.sh [月份]
#
# 示例:
#   ./run-integration-test.sh 2026-09
#
# 环境变量要求:
#   VOLCENGINE_ACCESS_KEY_ID - 火山引擎 Access Key ID
#   VOLCENGINE_SECRET_ACCESS_KEY - 火山引擎 Secret Access Key
#   TEST_MONTH_KEY - 测试月份 (可选，默认 2026-09)
#   ALLOW_CONFIRM - 是否允许确认分配 (可选，默认 false)

set -e

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== 账单分配 MVP 集成测试 ===${NC}\n"

# 检查环境变量
if [ -z "$VOLCENGINE_ACCESS_KEY_ID" ] || [ -z "$VOLCENGINE_SECRET_ACCESS_KEY" ]; then
  echo -e "${RED}❌ 错误: 缺少火山引擎凭证环境变量${NC}"
  echo ""
  echo "请设置以下环境变量:"
  echo "  export VOLCENGINE_ACCESS_KEY_ID=your_access_key"
  echo "  export VOLCENGINE_SECRET_ACCESS_KEY=your_secret_key"
  echo ""
  exit 1
fi

# 设置测试月份
if [ -n "$1" ]; then
  export TEST_MONTH_KEY="$1"
else
  export TEST_MONTH_KEY="${TEST_MONTH_KEY:-2026-09}"
fi

echo -e "${YELLOW}测试配置:${NC}"
echo "  月份: $TEST_MONTH_KEY"
echo "  允许确认: ${ALLOW_CONFIRM:-false}"
echo ""

# 编译 TypeScript
echo -e "${YELLOW}编译测试代码...${NC}"
npx ts-node test/integration/billing-allocation.integration.ts
