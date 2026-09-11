"""Loopback-only fake Ark provider for isolated contract tests."""

from dataclasses import dataclass, field
from typing import Any
from uuid import uuid4

from fastapi import FastAPI, HTTPException


@dataclass
class FakeProviderState:
    create_status: int = 200
    task_status: str = "succeeded"
    create_count: int = 0
    tasks: dict[str, dict[str, Any]] = field(default_factory=dict)

    def create_task(self, payload: dict[str, Any]) -> dict[str, str]:
        if self.create_status != 200:
            raise HTTPException(
                status_code=self.create_status,
                detail="fake provider create fault",
            )

        task_id = f"fake-{uuid4()}"
        self.create_count += 1
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
    async def stats():
        return {
            "createCount": provider.create_count,
            "taskIds": list(provider.tasks),
        }

    return app


app = create_app()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=19091)
