"""跨包合同：真实 Worker 代码 + 真实 Backend/DB + Fake Provider。

不 mock 掉任何一段：Worker 真的去 Backend 认领任务、真的向 Fake Provider 提交、
真的把终态与产物交回。断言的核心是"同一个意图只创建一次 Provider 任务"，
以及状态与证据在数据库里确实落到了该落的地方。

这些用例需要外部服务，由 scripts/run_mvp_contract.sh 显式运行；默认单元测试
通过 pytest.ini 的 marker 排除，避免"没有环境"被当成"测试通过"。

覆盖范围说明：这里验证的是"一个意图只创建一次 Provider 任务、重跑沿用原 ID"
这条跨包不变量。**完整的产物交付链路（上传 OSS、HEAD 校验、登记 Asset）依赖
真实对象存储**，合同环境没有可用的 OSS 替身，因此那一段仍由各包的单元与合同
用例覆盖，端到端留到 T12 的真实环境验收。
"""

from __future__ import annotations

import asyncio
import importlib
import os
import sys
import time
import unittest
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

pytestmark = pytest.mark.live_contract


def required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        # 缺环境就失败，不 skip：跨包合同没跑起来，比跑失败更危险。
        raise AssertionError(f"{name} is required for the live cross-package contract")
    return value


def provider_stats(base_url: str) -> dict:
    response = httpx.get(f"{base_url.rstrip('/')}/api/v3/__test__/stats", timeout=10.0)
    response.raise_for_status()
    return response.json()


class LiveMVPContractTests(unittest.TestCase):
    """E01/E06/E09 的跨包版本：真实 Worker 跑完整条链路。"""

    @classmethod
    def setUpClass(cls):
        cls.base_url = required_env("VIDEO_FLOW_LIVE_BASE_URL")
        cls.provider_url = required_env("VIDEO_FLOW_LIVE_PROVIDER_URL")
        cls.admin_token = required_env("VIDEO_FLOW_ADMIN_TOKEN")
        cls.actor_token = required_env("VIDEO_FLOW_LIVE_ACTOR_TOKEN")
        cls.worker_token = required_env("VIDEO_FLOW_WORKER_TOKEN")

        import config

        config.get_settings.cache_clear()
        importlib.reload(config)

        import executor as executor_module

        importlib.reload(executor_module)
        cls.executor_module = executor_module

    def _api(self) -> httpx.Client:
        return httpx.Client(base_url=self.base_url, timeout=30.0)

    def _create_production_task(self, prompt: str, asset_id: str) -> dict:
        with self._api() as client:
            created = client.post(
                "/api/v1/tasks",
                headers={
                    "Authorization": f"Bearer {self.actor_token}",
                    "Idempotency-Key": f"live-{prompt}",
                },
                json={
                    "mode": "production",
                    "capability": "IMAGE_TO_VIDEO",
                    "profile": "seedance",
                    "params": {
                        "prompt": prompt,
                        "image_asset_id": asset_id,
                        "duration": 5,
                        "ratio": "16:9",
                    },
                },
            )
            created.raise_for_status()
            return created.json()

    def _run_one_cycle(self) -> None:
        """跑一轮真实的认领 + 执行，不进入常驻循环。"""
        executor = self.executor_module.JobExecutor()

        async def cycle():
            # 连接与事件循环必须同生共死：拆成两次 asyncio.run 会让 httpx
            # 客户端在已关闭的循环上收尾，直接抛 "Event loop is closed"。
            try:
                jobs = await executor.fetch_inflight_jobs()
                jobs.extend(await executor.fetch_pending_jobs())
                for job in {job.id: job for job in jobs}.values():
                    await executor.execute_job(job)
            finally:
                await executor.close()

        asyncio.run(cycle())

    def test_preview_never_creates_a_provider_task(self):
        """E01：Preview 不产生 Attempt、不预占、也不调用 Provider。"""
        before = provider_stats(self.provider_url)["createCount"]

        with self._api() as client:
            response = client.post(
                "/api/v1/tasks",
                headers={
                    "Authorization": f"Bearer {self.actor_token}",
                    "Idempotency-Key": "live-preview-e01",
                },
                json={
                    # 文本生成预览：不需要输入素材，正好隔离出"预览本身不花钱"这一点。
                    "mode": "preview",
                    "capability": "TEXT_TO_VIDEO",
                    "profile": "seedance",
                    "params": {"prompt": "live preview e01"},
                },
            )
        response.raise_for_status()
        task = response.json()
        self.assertTrue(task.get("preview"), "preview plan missing")

        self._run_one_cycle()

        self.assertEqual(provider_stats(self.provider_url)["createCount"], before)

    def test_single_intent_creates_the_provider_task_exactly_once(self):
        """E06 的核心不变量：一个意图只 create 一次，重跑沿用原任务。"""
        prompt = "live single intent e06"
        # 输入素材由合同脚本直接写入（合同环境没有真实 OSS 可上传）。
        asset_id = required_env("VIDEO_FLOW_LIVE_ASSET_ID")
        task = self._create_production_task(prompt, asset_id)

        before = provider_stats(self.provider_url)["createCountsByKey"].get(prompt, 0)

        # 第一轮：认领 → 提交 → 终态 → 归档。
        self._run_one_cycle()
        after_first = provider_stats(self.provider_url)["createCountsByKey"].get(prompt, 0)
        self.assertEqual(after_first, before + 1, "provider was not created exactly once")

        with self._api() as client:
            first_summary = client.get(
                f"/api/v1/tasks/{task['id']}",
                headers={"Authorization": f"Bearer {self.actor_token}"},
            )
        first_summary.raise_for_status()
        self._first_provider_task_id = first_summary.json()["execution"]["providerTaskId"]
        self.assertIsNotNone(self._first_provider_task_id)

        # 第二轮：同一条任务再跑一遍（模拟 Worker 重启后的恢复），
        # 必须复用原 providerTaskId，不允许再 create 一次。
        self._run_one_cycle()
        after_second = provider_stats(self.provider_url)["createCountsByKey"].get(prompt, 0)

        self.assertEqual(after_second, after_first, "recovery created a second provider task")

        # 产物身份在整个过程中保持不变：这是"重跑不会变成新任务"的持久证据。
        with self._api() as client:
            summary = client.get(
                f"/api/v1/tasks/{task['id']}",
                headers={"Authorization": f"Bearer {self.actor_token}"},
            )
        summary.raise_for_status()
        payload = summary.json()
        self.assertIsNotNone(payload["execution"]["providerTaskId"])
        self.assertEqual(payload["execution"]["providerTaskId"], self._first_provider_task_id)

        # 产物交付本身依赖真实对象存储；合同环境按规约不允许使用真实凭证，
        # 也没有可用的 OSS 替身，所以这里只断言任务走到了确定的终态，
        # 且**没有**因为重跑而多创建一次 Provider 任务。
        # 完整的下载→上传→HEAD→登记链路由 Worker 的 artifact_delivery 单测与
        # Backend 的 artifact-delivery 合同用例覆盖，端到端留到 T12 真实环境验收。
        self.assertIn(payload["delivery"]["status"], {"ready", "failed"})
        self.assertEqual(payload["execution"]["status"], "completed")


if __name__ == "__main__":
    unittest.main()
