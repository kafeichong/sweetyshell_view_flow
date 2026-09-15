FROM python:3.13-slim

WORKDIR /app

# 复制依赖文件
COPY requirements.txt .
RUN pip install --no-cache-dir \
    -i https://mirrors.aliyun.com/pypi/simple/ \
    -r requirements.txt

# 复制代码
COPY . .

# 创建输出目录
RUN mkdir -p /app/output

# 暴露端口
EXPOSE 8001

# Worker 的运行日志走 print()；Python 的 stdout 在容器里是管道，默认块缓冲，
# 不设这个变量会让 `docker logs video-flow-worker` 滞后于实际状态（尾部输出留在
# 进程缓冲区里没落盘）。2026-09-15 的 ComfyUI 验收实测到该现象。
ENV PYTHONUNBUFFERED=1

# 启动命令（直接使用 uvicorn，不使用 reload）
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8001"]
