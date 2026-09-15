"""Loopback-only fake Ark provider for isolated contract tests."""

import os
from dataclasses import dataclass, field
from copy import deepcopy
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request, Response

# Worker 从 Provider 取片子，所以返回的地址必须是 Worker 能访问到的主机：
# 宿主脚本用 127.0.0.1，Docker 里的 Worker 必须用服务名 fake-provider。
FAKE_PROVIDER_PORT = int(os.getenv("VIDEO_FLOW_FAKE_PROVIDER_PORT", "19091"))
PUBLIC_BASE_URL = os.getenv(
    "VIDEO_FLOW_FAKE_PROVIDER_PUBLIC_URL",
    f"http://127.0.0.1:{FAKE_PROVIDER_PORT}",
)
CLIP_PATH = Path(__file__).resolve().parent / "tests" / "fixtures" / "contract-clip.mp4"


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
    create_mode: str = "normal"
    usage_mode: str = "valid"
    task_status: str = "succeeded"
    create_count: int = 0
    create_counts_by_key: dict[str, int] = field(default_factory=dict)
    last_create_payload: dict[str, Any] | None = None
    objects: dict[str, bytes] = field(default_factory=dict)
    tasks: dict[str, dict[str, Any]] = field(default_factory=dict)

    def _next_usage(self) -> dict[str, Any] | None:
        if self.usage_mode == "valid":
            return {"completion_tokens": 1000}
        if self.usage_mode == "missing":
            return {}
        if self.usage_mode == "invalid":
            return {"completion_tokens": "bad"}
        if self.usage_mode == "negative":
            return {"completion_tokens": -10}
        return {"completion_tokens": 1000}

    def create_task(self, payload: dict[str, Any]) -> dict[str, str]:
        if self.create_status != 200:
            raise HTTPException(
                status_code=self.create_status,
                detail="fake provider create fault",
            )

        task_id = f"fake-{uuid4()}"
        self.create_count += 1
        self.last_create_payload = deepcopy(payload)
        key = correlation_key(payload)
        self.create_counts_by_key[key] = self.create_counts_by_key.get(key, 0) + 1

        if self.create_mode == "missing_id":
            self.tasks[task_id] = {
                "id": task_id,
                "status": self.task_status,
                "model": payload.get("model"),
                "content": {
                    "video_url": f"{PUBLIC_BASE_URL}/__test__/videos/{task_id}.mp4"
                },
                "usage": self._next_usage(),
            }
            return {}

        self.tasks[task_id] = {
            "id": task_id,
            "status": self.task_status,
            "model": payload.get("model"),
            "content": {"video_url": f"{PUBLIC_BASE_URL}/__test__/videos/{task_id}.mp4"},
            "usage": self._next_usage(),
        }
        return {"id": task_id}

    def get_task(self, task_id: str) -> dict[str, Any]:
        task = self.tasks.get(task_id)
        if not task:
            raise HTTPException(status_code=404, detail="fake task not found")
        return task

    def reset(self) -> None:
        self.create_count = 0
        self.create_counts_by_key = {}
        self.last_create_payload = None
        self.objects.clear()
        self.tasks.clear()
        self.create_status = 200
        self.create_mode = "normal"
        self.usage_mode = "valid"
        self.task_status = "succeeded"


def create_app(state: FakeProviderState | None = None) -> FastAPI:
    provider = state or FakeProviderState()
    app = FastAPI(title="Video Flow Contract Fake Provider")

    @app.post("/api/v3/contents/generations/tasks")
    async def create_task(payload: dict[str, Any]):
        return provider.create_task(payload)

    @app.get("/api/v3/contents/generations/tasks/{task_id}")
    async def get_task(task_id: str):
        return provider.get_task(task_id)

    @app.get("/api/v3/contents/generations/model/versions")
    async def model_versions():
        return {"versions": ["doubao-seedance-2-5-260628"]}

    @app.get("/api/v3/__test__/stats")
    @app.get("/__test__/stats")
    async def stats():
        return {
            "createCount": provider.create_count,
            "createCountsByKey": dict(provider.create_counts_by_key),
            "taskIds": list(provider.tasks),
            "lastCreatePayload": provider.last_create_payload,
        }

    @app.get("/__test__/task-status")
    async def set_task_status(value: str = "succeeded"):
        """把已创建任务的状态切到 running/succeeded，供"重启恢复"用例制造中断点。"""
        provider.task_status = value
        for task in provider.tasks.values():
            task["status"] = value
        return {"taskStatus": provider.task_status}

    @app.get("/__test__/create-mode")
    async def set_create_mode(mode: str = "normal"):
        if mode not in {"normal", "missing_id"}:
            raise HTTPException(status_code=400, detail="invalid create mode")
        provider.create_mode = mode
        return {"createMode": provider.create_mode}

    @app.get("/__test__/usage-mode")
    async def set_usage_mode(mode: str = "valid"):
        if mode not in {"valid", "missing", "invalid", "negative"}:
            raise HTTPException(status_code=400, detail="invalid usage mode")
        provider.usage_mode = mode
        return {"usageMode": provider.usage_mode}

    @app.get("/__test__/create-status")
    async def create_status():
        return {
            "createMode": provider.create_mode,
            "usageMode": provider.usage_mode,
            "createStatus": provider.create_status,
            "taskStatus": provider.task_status,
        }

    @app.post("/__test__/reset")
    async def reset_state():
        provider.reset()
        return {"ok": True}

    @app.get("/__test__/videos/{name}")
    async def download_video(name: str):
        """返回一份本地生成的短视频，供归档链路真实下载。

        它只验证"文件流程能跑通"，不代表任何真实模型能力；素材由测试生成，
        不涉及生产素材。
        """
        if not CLIP_PATH.is_file():
            raise HTTPException(status_code=404, detail="contract clip fixture missing")
        return Response(content=CLIP_PATH.read_bytes(), media_type="video/mp4")

    @app.put("/{key:path}")
    async def put_object(key: str, request: Request):
        """对象存储替身（兜底路由）：合同环境没有真实 OSS，归档链路需要能真的存取。

        oss2 会丢弃 endpoint 里的路径部分，请求落在根路径上，所以这些路由必须
        放在所有具体路由之后，只兜住没人认领的 PUT/HEAD/GET。
        """
        provider.objects[key] = await request.body()
        return Response(status_code=200)

    @app.head("/{key:path}")
    async def head_object(key: str):
        body = provider.objects.get(key)
        if body is None:
            raise HTTPException(status_code=404, detail="object not found")
        return Response(
            status_code=200,
            headers={"Content-Length": str(len(body)), "Content-Type": "video/mp4"},
        )

    @app.get("/{key:path}")
    async def get_object(key: str):
        body = provider.objects.get(key)
        if body is None:
            raise HTTPException(status_code=404, detail="object not found")
        return Response(content=body, media_type="video/mp4")

    return app


app = create_app()


if __name__ == "__main__":
    import uvicorn

    # 宿主机跑合同脚本时绑回环即可；容器里必须绑 0.0.0.0，否则另一个容器
    # 只能解析到服务名却连不上（容器内的 127.0.0.1 只指向它自己）。
    host = os.getenv("VIDEO_FLOW_FAKE_PROVIDER_HOST", "127.0.0.1")
    uvicorn.run(app, host=host, port=FAKE_PROVIDER_PORT)
