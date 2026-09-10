#!/bin/bash

# Video Flow 一键部署脚本
# 使用方法：./deploy.sh

set -e

echo "🚀 Video Flow 部署开始..."

# 检查 .env 文件
if [ ! -f .env ]; then
    echo "❌ 错误：.env 文件不存在"
    echo "请先复制 .env.example 为 .env 并填写配置"
    echo "  cp .env.example .env"
    exit 1
fi

# 加载环境变量
source .env

# 检查必要的环境变量
if [ -z "$DB_PASSWORD" ]; then
    echo "❌ 错误：DB_PASSWORD 未设置"
    exit 1
fi

if [ -z "$VOLCENGINE_ACCESS_KEY" ]; then
    echo "❌ 错误：VOLCENGINE_ACCESS_KEY 未设置"
    exit 1
fi

echo "✅ 环境变量检查通过"

# 检查 Docker
if ! command -v docker &> /dev/null; then
    echo "❌ 错误：Docker 未安装"
    echo "请先安装 Docker: https://docs.docker.com/get-docker/"
    exit 1
fi

echo "✅ Docker 检查通过"

# 停止旧容器
echo "⏸️  停止旧容器..."
docker compose down || true

# 构建镜像
echo "🔨 构建 Docker 镜像..."
docker compose build --progress=plain

# 启动服务
echo "▶️  启动服务..."
docker compose up -d

# 等待数据库启动
echo "⏳ 等待数据库启动..."
sleep 10

# 运行数据库迁移
echo "📊 运行数据库迁移..."
docker compose exec -T video-backend npx prisma migrate deploy || {
    echo "⚠️  数据库迁移失败，尝试生成 Prisma Client..."
    docker compose exec -T video-backend npx prisma generate
    docker compose exec -T video-backend npx prisma migrate deploy
}

# 检查服务状态
echo "🔍 检查服务状态..."
docker compose ps

# 测试 Backend API
echo "🧪 测试 Backend API..."
sleep 5
if curl -sf http://localhost:3100/api/tasks/pending > /dev/null; then
    echo "✅ Backend API 正常"
else
    echo "⚠️  Backend API 可能未就绪，请检查日志"
fi

# 测试 Worker
echo "🧪 测试 Worker..."
if curl -sf http://localhost:8101/health > /dev/null; then
    echo "✅ Worker 正常"
else
    echo "⚠️  Worker 可能未就绪，请检查日志"
fi

echo ""
echo "========================================="
echo "✅ 部署完成！"
echo "========================================="
echo ""
echo "📡 服务地址："
echo "  Backend API:  http://localhost:3100/api"
echo "  Worker:       http://localhost:8101"
echo ""
echo "📋 常用命令："
echo "  查看日志:     docker compose logs -f"
echo "  停止服务:     docker compose down"
echo "  重启服务:     docker compose restart"
echo ""
echo "🧪 测试 API："
echo '  创建任务:     curl -X POST http://localhost:3100/api/tasks \\'
echo '                  -H "Content-Type: application/json" \\'
echo '                  -d '"'"'{"createdBy":"测试","prompt":"产品从水面浮现"}'"'"
echo ""
echo "  查询任务:     curl http://localhost:3100/api/tasks"
echo ""
