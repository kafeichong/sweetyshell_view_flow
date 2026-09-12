"""Loopback-only fake Ark provider for isolated contract tests."""

from dataclasses import dataclass, field
from typing import Any
from uuid import uuid4

from fastapi import FastAPI, HTTPException


def correlation_key(payload: dict[str, Any]) -> str:
    """按提示词给本次 create 归组，供跨包用例断言"每个意图只创建一次"。

    真实 Provider 并不知道我们的 taskId，所以用请求体里唯一的文本做关联键；
    这是测试专用约定，不改变被测代码的请求内容。
    """
    for item in payload.get("content") or []:
        if item.get("type") == "text" and item.get("text"):
            return str(item["text"])
    return "<no-prompt>"


@dataclass
class FakeProviderState:
    create_status: int = 200
    task_status: str = "succeeded"
    create_count: int = 0
    create_counts_by_key: dict[str, int] = field(default_factory=dict)
    tasks: dict[str, dict[str, Any]] = field(default_factory=dict)

    def create_task(self, payload: dict[str, Any]) -> dict[str, str]:
        if self.create_status != 200:
            raise HTTPException(
                status_code=self.create_status,
                detail="fake provider create fault",
            )

        task_id = f"fake-{uuid4()}"
        self.create_count += 1
        key = correlation_key(payload)
        self.create_counts_by_key[key] = self.create_counts_by_key.get(key, 0) + 1
        self.tasks[task_id] = {
            "id": task_id,
            "status": self.task_status,
            "model": payload.get("model"),
            "content": {"video_url": f"http://127.0.0.1/__test__/videos/{task_id}.mp4"},
            "usage": {"total_tokens": 1000},
        }
        return {"id": task_id}


def create_app(state: FakeProviderState | None = None) -> FastAPI:
    provider = state or FakeProviderState()
    app = FastAPI(title="Video Flow Contract Fake Provider")

    @app.post("/api/v3/contents/generations/tasks")
    async def create_task(payload: dict[str, Any]):
        return provider.create_task(payload)

    @app.get("/api/v3/contents/generations/tasks/{task_id}")
    async def get_task(task_id: str):
        task = provider.tasks.get(task_id)
        if not task:
            raise HTTPException(status_code=404, detail="fake task not found")
        return task

    @app.get("/__test__/stats")
    @app.get("/api/v3/__test__/stats")
    async def stats():
        return {
            "createCount": provider.create_count,
            "createCountsByKey": dict(provider.create_counts_by_key),
            "taskIds": list(provider.tasks),
        }

    return app


app = create_app()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=19091)
