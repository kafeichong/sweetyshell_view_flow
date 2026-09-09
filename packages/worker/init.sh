#!/bin/bash

# AI Studio Worker 初始化脚本

set -e

echo "🚀 Initializing AI Studio Worker..."

# 检查 Python 版本
if ! command -v python3 &> /dev/null; then
    echo "❌ Python 3 is not installed"
    exit 1
fi

PYTHON_VERSION=$(python3 --version | cut -d' ' -f2 | cut -d'.' -f1,2)
echo "✅ Found Python $PYTHON_VERSION"

# 创建虚拟环境
if [ ! -d "venv" ]; then
    echo "📦 Creating virtual environment..."
    python3 -m venv venv
fi

# 激活虚拟环境
source venv/bin/activate

# 安装依赖
echo "📦 Installing dependencies..."
pip install --upgrade pip
pip install -r requirements.txt

# 检查 .env 文件
if [ ! -f ".env" ]; then
    echo "📝 Creating .env from .env.example..."
    cp .env.example .env
    echo "⚠️  Please edit .env and fill in your API keys"
fi

echo "✅ Worker initialized successfully!"
echo ""
echo "Next steps:"
echo "  1. Edit .env and configure your API keys"
echo "  2. Make sure Backend API is running (http://localhost:3000)"
echo "  3. Run: source venv/bin/activate && python main.py"
