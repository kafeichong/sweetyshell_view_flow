from fastapi import FastAPI, HTTPException
from contextlib import asynccontextmanager
import asyncio
from config import get_settings
from executor import JobExecutor
from models import TaskCreateRequest, TaskStatusResponse

# Worker 入口说明：
# - 应用常驻，真正的任务处理在 lifespan 生命周期启动的后台循环里完成。
# - HTTP 接口主要用于健康检查和兼容性预留，不是主触发链路。
settings = get_settings()
executor = JobExecutor()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 启动时：开始后台轮询，持续抓取 pending / in-flight 任务并执行。
    task = asyncio.create_task(executor.poll_loop())
    yield
    # 停止时：取消后台任务，关闭与 Backend/Provider 的持久连接。
    task.cancel()
    await executor.close()


app = FastAPI(
    title="AI Studio Worker",
    description="Python Worker for ComfyUI and Provider API interaction",
    version="0.1.0",
    lifespan=lifespan
)


@app.get("/")
async def root():
    """服务存活探针：返回版本和运行状态。"""
    return {
        "service": "AI Studio Worker",
        "version": "0.1.0",
        "status": "running"
    }


@app.get("/health")
async def health_check():
    """健康检查接口：返回依赖配置的关键链路参数。"""
    return {
        "status": "healthy",
        "backend_url": settings.backend_url,
        "poll_interval": settings.job_poll_interval
    }


@app.post("/tasks/execute")
async def execute_task(request: TaskCreateRequest):
    """
    直接执行任务接口（可选，用于测试）
    正常流程是 Worker 主动轮询 Backend
    """
    # 当前为占位实现：只回显入参，便于手工联调。
    return {
        "message": "Task execution started",
        "capability": request.capability,
        "profile": request.profile
    }


if __name__ == "__main__":
    import uvicorn
    # 本地开发直接运行入口：使用 settings 中配置的监听地址。
    uvicorn.run(
        "main:app",
        host=settings.worker_host,
        port=settings.worker_port,
        reload=True
    )
