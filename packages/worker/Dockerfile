FROM python:3.13-slim

WORKDIR /app

# 安装系统依赖
RUN apt-get update && apt-get install -y \
    gcc \
    && rm -rf /var/lib/apt/lists/*

# 复制依赖文件
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 复制代码
COPY . .

# 创建输出目录
RUN mkdir -p /app/output

# 暴露端口
EXPOSE 8001

# 启动命令（直接使用 uvicorn，不使用 reload）
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8001"]
