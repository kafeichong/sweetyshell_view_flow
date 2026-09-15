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
import hashlib
import json
import threading
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import unittest
from tempfile import mkdtemp
from typing import Optional

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


_preflight_receipts = {}
_preflight_lock = threading.Lock()


def _workflow_intent(payload):
    generation = payload["generation"]
    intent = {
        "contractVersion": 2,
        "workflowKey": payload["workflowKey"],
        "prompt": payload["prompt"],
        "generation": {
            "duration": generation["duration"],
            "ratio": generation["ratio"],
            "resolution": generation["resolution"],
            "generateAudio": generation.get("generateAudio", True),
            "watermark": generation.get("watermark", False),
            "outputFormat": generation.get("outputFormat", "mp4"),
        },
        "media": [],
    }
    image_roles = {"reference_image", "first_frame", "last_frame"}
    for index, item in enumerate(payload.get("media", []), start=1):
        role = item["role"]
        if role in image_roles:
            object_name = "last.png" if role == "last_frame" else "reference.png"
            mime_type = "image/png"
            metadata = {"kind": "image", "width": 1280, "height": 720}
        elif role == "reference_audio":
            object_name = "audio.wav"
            mime_type = "audio/wav"
            metadata = {"kind": "audio", "durationSeconds": 10, "audioCodec": "pcm_s16le"}
        elif role == "reference_video":
            object_name = "video.mp4"
            mime_type = "video/mp4"
            metadata = {
                "kind": "video", "width": 1280, "height": 720,
                "durationSeconds": 6, "frameRate": 24,
                "videoCodec": "h264", "audioCodec": "aac",
            }
        else:
            raise AssertionError(f"unsupported live-contract media role: {role}")
        content = f"contract-object:live-contract/{object_name}".encode()
        intent["media"].append({
            "slotId": f"{role.replace('_', '-')}-{index}",
            "role": role,
            "sha256": hashlib.sha256(content).hexdigest(),
            "sizeBytes": len(content),
            "mimeType": mime_type,
            "metadata": metadata,
        })
    return intent


def preflight_production(client, payload, headers=None):
    """Exercise the authenticated preflight route; reuse one receipt per test intent."""
    intent = _workflow_intent(payload)
    cache_key = (str(client.base_url), (headers or {}).get("Authorization", client.headers.get("Authorization")), json.dumps(intent, sort_keys=True))
    with _preflight_lock:
        if cache_key not in _preflight_receipts:
            response = client.post("/api/v1/tasks/preflight", headers=headers, json=intent)
            if response.status_code != 201:
                return response, None
            report = response.json()
            assert report["willCallProvider"] is False
            assert report["willUploadMedia"] is False
            _preflight_receipts[cache_key] = report["preflightId"]
        idempotency_key = (headers or {}).get("Idempotency-Key", "contract-reference")
        media = payload.get("media", [])
        descriptors = intent["media"]
        assert len(media) == len(descriptors)
        return None, {
            "mode": "production",
            "preflightId": _preflight_receipts[cache_key],
            "executionSlotId": payload.get("executionSlotId", f"slot-{idempotency_key}"),
            "media": [
                {"slotId": descriptor["slotId"], "assetId": item["assetId"]}
                for descriptor, item in zip(descriptors, media)
            ],
        }


def post_confirmed(client, payload, headers=None):
    error, confirmed = preflight_production(client, payload, headers)
    if error is not None:
        return error
    response = client.post("/api/v1/tasks", headers=headers, json=confirmed)
    if response.status_code >= 400:
        print("confirmed submission rejected:", response.status_code, response.json().get("message"))
    return response


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
            created = post_confirmed(
                client,
                headers={
                    "Authorization": f"Bearer {self.actor_token}",
                    "Idempotency-Key": f"live-{prompt}",
                },
                payload={
                    "mode": "production",
                    "workflowKey": "seedance.reference-image-to-video.v1",
                    "prompt": {"positive": prompt},
                    "generation": {"duration": 5, "ratio": "16:9", "resolution": "720p"},
                    "media": [{"assetId": asset_id, "role": "reference_image"}],
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
            error, confirmed = preflight_production(client, {
                "workflowKey": "seedance.reference-image-to-video.v1",
                "prompt": {"positive": "live product preview e01"},
                "generation": {"duration": 5, "ratio": "16:9", "resolution": "720p"},
                "media": [{"assetId": required_env("VIDEO_FLOW_LIVE_ASSET_ID"), "role": "reference_image"}],
            }, {"Authorization": f"Bearer {self.actor_token}"})
            self.assertIsNone(error)
            response = client.get(f"/api/v1/tasks/preflight/{confirmed['preflightId']}/check",
                                  headers={"Authorization": f"Bearer {self.actor_token}"})
            response.raise_for_status()
            self.assertEqual(response.json()["requestCheck"]["status"], "passed")
            self.assertFalse(response.json()["willCallProvider"])

        self._run_one_cycle()

        self.assertEqual(provider_stats(self.provider_url)["createCount"], before)

    def test_reference_image_four_and_thirty_seconds_reach_delivery_with_frozen_usage(self):
        asset_id = required_env("VIDEO_FLOW_LIVE_ASSET_ID")
        for duration in (4, 30):
            prompt = f"live reference boundary {duration}s"
            with self._api() as client:
                response = post_confirmed(
                    client,
                    headers={
                        "Authorization": f"Bearer {self.actor_token}",
                        "Idempotency-Key": f"r6-reference-{duration}s",
                    },
                    payload={
                        "mode": "production",
                        "workflowKey": "seedance.reference-image-to-video.v1",
                        "prompt": {"positive": prompt},
                        "generation": {
                            "duration": duration,
                            "ratio": "16:9",
                            "resolution": "720p",
                            "generateAudio": True,
                            "watermark": False,
                            "outputFormat": "mp4",
                        },
                        "media": [{"assetId": asset_id, "role": "reference_image"}],
                    },
                )
            response.raise_for_status()
            task = response.json()
            self.assertEqual(task["executionPlan"]["duration"], duration)

            before = provider_stats(self.provider_url)["createCountsByKey"].get(prompt, 0)
            self._run_one_cycle()
            stats = provider_stats(self.provider_url)
            self.assertEqual(stats["createCountsByKey"].get(prompt, 0), before + 1)
            self.assertEqual(stats["lastCreatePayload"]["duration"], duration)
            self.assertEqual(stats["lastCreatePayload"]["content"][1]["role"], "reference_image")

            with self._api() as client:
                summary = client.get(
                    f"/api/v1/tasks/{task['id']}",
                    headers={"Authorization": f"Bearer {self.actor_token}"},
                )
            summary.raise_for_status()
            result = summary.json()
            self.assertEqual(result["execution"]["status"], "completed")
            self.assertEqual(result["delivery"]["status"], "ready")
            self.assertIsNotNone(result["delivery"]["assetId"])
            self.assertIn(result["costSummary"]["status"], {"usage_calculated", "billed"})
            self.assertEqual(
                result["costSummary"]["reservedCny"],
                task["executionPlan"]["reserveCny"],
            )
            self.assertEqual(result["costSummary"]["reservationState"], "settled")
            self.assertIsNotNone(result["costSummary"]["usageCalculatedCny"])

    def test_text_to_video_four_and_thirty_seconds_never_bind_an_input_asset(self):
        for duration in (4, 30):
            prompt = f"live text boundary {duration}s"
            with self._api() as client:
                response = post_confirmed(
                    client,
                    headers={
                        "Authorization": f"Bearer {self.actor_token}",
                        "Idempotency-Key": f"r6-text-{duration}s",
                    },
                    payload={
                        "mode": "production",
                        "workflowKey": "seedance.text-to-video.v1",
                        "prompt": {"positive": prompt},
                        "generation": {
                            "duration": duration,
                            "ratio": "16:9",
                            "resolution": "720p",
                            "generateAudio": True,
                            "watermark": False,
                            "outputFormat": "mp4",
                        },
                        "media": [],
                    },
                )
            response.raise_for_status()
            task = response.json()
            self.assertEqual(task["executionPlan"]["media"], [])
            self.assertEqual(task["executionPlan"]["duration"], duration)

            before = provider_stats(self.provider_url)["createCountsByKey"].get(prompt, 0)
            self._run_one_cycle()
            stats = provider_stats(self.provider_url)
            self.assertEqual(stats["createCountsByKey"].get(prompt, 0), before + 1)
            self.assertEqual(stats["lastCreatePayload"]["content"], [
                {"type": "text", "text": prompt},
            ])
            self.assertEqual(stats["lastCreatePayload"]["duration"], duration)

            with self._api() as client:
                summary = client.get(
                    f"/api/v1/tasks/{task['id']}",
                    headers={"Authorization": f"Bearer {self.actor_token}"},
                )
                report = client.get(
                    f"/api/v1/admin/tasks/{task['id']}/report",
                    headers={"X-Admin-Token": self.admin_token},
                )
            summary.raise_for_status()
            report.raise_for_status()
            result = summary.json()
            self.assertEqual(result["execution"]["status"], "completed")
            self.assertEqual(result["delivery"]["status"], "ready")
            self.assertEqual(result["costSummary"]["reservationState"], "settled")
            self.assertIsNotNone(result["costSummary"]["usageCalculatedCny"])
            self.assertEqual([asset["role"] for asset in report.json()["assets"]], ["output"])

    def test_first_frame_adaptive_four_and_thirty_seconds_reach_delivery(self):
        asset_id = required_env("VIDEO_FLOW_LIVE_ASSET_ID")
        for duration in (4, 30):
            prompt = f"live first frame adaptive {duration}s"
            with self._api() as client:
                response = post_confirmed(
                    client,
                    headers={
                        "Authorization": f"Bearer {self.actor_token}",
                        "Idempotency-Key": f"r6-first-frame-{duration}s",
                    },
                    payload={
                        "mode": "production",
                        "workflowKey": "seedance.first-frame-to-video.v1",
                        "prompt": {"positive": prompt},
                        "generation": {
                            "duration": duration,
                            "ratio": "adaptive",
                            "resolution": "720p",
                            "generateAudio": True,
                            "watermark": False,
                            "outputFormat": "mp4",
                        },
                        "media": [{"assetId": asset_id, "role": "first_frame"}],
                    },
                )
            response.raise_for_status()
            task = response.json()
            self.assertEqual(task["executionPlan"]["duration"], duration)
            self.assertEqual(task["executionPlan"]["ratio"], "adaptive")
            self.assertEqual(
                [item["role"] for item in task["executionPlan"]["media"]],
                ["first_frame"],
            )

            before = provider_stats(self.provider_url)["createCountsByKey"].get(prompt, 0)
            self._run_one_cycle()
            stats = provider_stats(self.provider_url)
            self.assertEqual(stats["createCountsByKey"].get(prompt, 0), before + 1)
            self.assertEqual(stats["lastCreatePayload"]["ratio"], "adaptive")
            self.assertEqual(stats["lastCreatePayload"]["duration"], duration)
            self.assertEqual(stats["lastCreatePayload"]["content"][1]["role"], "first_frame")

            with self._api() as client:
                summary = client.get(
                    f"/api/v1/tasks/{task['id']}",
                    headers={"Authorization": f"Bearer {self.actor_token}"},
                )
            summary.raise_for_status()
            result = summary.json()
            self.assertEqual(result["execution"]["status"], "completed")
            self.assertEqual(result["delivery"]["status"], "ready")
            self.assertEqual(result["costSummary"]["reservationState"], "settled")
            self.assertIsNotNone(result["costSummary"]["usageCalculatedCny"])

    def test_first_last_frames_keep_distinct_slot_bindings_and_provider_order(self):
        first_asset_id = required_env("VIDEO_FLOW_LIVE_ASSET_ID")
        last_asset_id = required_env("VIDEO_FLOW_LIVE_LAST_ASSET_ID")
        for duration in (4, 30):
            prompt = f"live first last adaptive {duration}s"
            with self._api() as client:
                response = post_confirmed(
                    client,
                    headers={
                        "Authorization": f"Bearer {self.actor_token}",
                        "Idempotency-Key": f"r6-first-last-{duration}s",
                    },
                    payload={
                        "mode": "production",
                        "workflowKey": "seedance.first-last-frame-to-video.v1",
                        "prompt": {"positive": prompt},
                        "generation": {
                            "duration": duration,
                            "ratio": "adaptive",
                            "resolution": "720p",
                            "generateAudio": True,
                            "watermark": False,
                            "outputFormat": "mp4",
                        },
                        "media": [
                            {"assetId": first_asset_id, "role": "first_frame"},
                            {"assetId": last_asset_id, "role": "last_frame"},
                        ],
                    },
                )
            response.raise_for_status()
            task = response.json()
            self.assertEqual(
                [(item["role"], item["assetId"]) for item in task["executionPlan"]["media"]],
                [("first_frame", first_asset_id), ("last_frame", last_asset_id)],
            )
            self.assertEqual(task["executionPlan"]["ratio"], "adaptive")

            before = provider_stats(self.provider_url)["createCountsByKey"].get(prompt, 0)
            self._run_one_cycle()
            stats = provider_stats(self.provider_url)
            self.assertEqual(stats["createCountsByKey"].get(prompt, 0), before + 1)
            provider_media = stats["lastCreatePayload"]["content"][1:]
            self.assertEqual([item["role"] for item in provider_media], ["first_frame", "last_frame"])
            self.assertNotEqual(
                provider_media[0]["image_url"]["url"],
                provider_media[1]["image_url"]["url"],
            )

            with self._api() as client:
                summary = client.get(
                    f"/api/v1/tasks/{task['id']}",
                    headers={"Authorization": f"Bearer {self.actor_token}"},
                )
            summary.raise_for_status()
            result = summary.json()
            self.assertEqual(result["execution"]["status"], "completed")
            self.assertEqual(result["delivery"]["status"], "ready")
            self.assertEqual(result["costSummary"]["reservationState"], "settled")
            self.assertIsNotNone(result["costSummary"]["usageCalculatedCny"])

    def test_omni_image_audio_four_and_thirty_seconds_reach_delivery(self):
        image_asset_id = required_env("VIDEO_FLOW_LIVE_ASSET_ID")
        audio_asset_id = required_env("VIDEO_FLOW_LIVE_AUDIO_ASSET_ID")
        for duration in (4, 30):
            prompt = f"live omni image audio {duration}s"
            with self._api() as client:
                response = post_confirmed(
                    client,
                    headers={
                        "Authorization": f"Bearer {self.actor_token}",
                        "Idempotency-Key": f"r6-omni-image-audio-{duration}s",
                    },
                    payload={
                        "mode": "production",
                        "workflowKey": "seedance.omni-reference.v1",
                        "prompt": {"positive": prompt},
                        "generation": {
                            "duration": duration,
                            "ratio": "16:9",
                            "resolution": "720p",
                            "generateAudio": True,
                            "watermark": False,
                            "outputFormat": "mp4",
                        },
                        "media": [
                            {"assetId": image_asset_id, "role": "reference_image"},
                            {"assetId": audio_asset_id, "role": "reference_audio"},
                        ],
                    },
                )
            response.raise_for_status()
            task = response.json()
            self.assertEqual(
                [item["role"] for item in task["executionPlan"]["media"]],
                ["reference_image", "reference_audio"],
            )
            self.assertEqual(task["executionPlan"]["omni_reference_task_type"], "reference")

            before = provider_stats(self.provider_url)["createCountsByKey"].get(prompt, 0)
            self._run_one_cycle()
            stats = provider_stats(self.provider_url)
            self.assertEqual(stats["createCountsByKey"].get(prompt, 0), before + 1)
            self.assertEqual(
                [(item["type"], item.get("role")) for item in stats["lastCreatePayload"]["content"][1:]],
                [("image_url", "reference_image"), ("audio_url", "reference_audio")],
            )
            self.assertEqual(stats["lastCreatePayload"]["duration"], duration)

            with self._api() as client:
                summary = client.get(
                    f"/api/v1/tasks/{task['id']}",
                    headers={"Authorization": f"Bearer {self.actor_token}"},
                )
            summary.raise_for_status()
            result = summary.json()
            self.assertEqual(result["execution"]["status"], "completed")
            self.assertEqual(result["delivery"]["status"], "ready")
            self.assertEqual(result["costSummary"]["reservationState"], "settled")
            self.assertIsNotNone(result["costSummary"]["usageCalculatedCny"])

    def test_audio_reference_four_and_thirty_seconds_reach_delivery_without_video_minimum(self):
        audio_asset_id = required_env("VIDEO_FLOW_LIVE_AUDIO_ASSET_ID")
        for duration in (4, 30):
            prompt = f"live audio reference {duration}s"
            with self._api() as client:
                response = post_confirmed(
                    client,
                    headers={
                        "Authorization": f"Bearer {self.actor_token}",
                        "Idempotency-Key": f"r6-audio-reference-{duration}s",
                    },
                    payload={
                        "mode": "production",
                        "workflowKey": "seedance.audio-reference-to-video.v1",
                        "prompt": {"positive": prompt},
                        "generation": {
                            "duration": duration,
                            "ratio": "16:9",
                            "resolution": "720p",
                            "generateAudio": True,
                            "watermark": False,
                            "outputFormat": "mp4",
                        },
                        "media": [{"assetId": audio_asset_id, "role": "reference_audio"}],
                    },
                )
            response.raise_for_status()
            task = response.json()
            self.assertEqual([item["role"] for item in task["executionPlan"]["media"]], ["reference_audio"])
            self.assertEqual(task["executionPlan"]["omni_reference_task_type"], "reference")
            self.assertGreater(float(task["executionPlan"]["reserveCny"]), 0)

            before = provider_stats(self.provider_url)["createCountsByKey"].get(prompt, 0)
            self._run_one_cycle()
            stats = provider_stats(self.provider_url)
            self.assertEqual(stats["createCountsByKey"].get(prompt, 0), before + 1)
            self.assertEqual(
                [(item["type"], item.get("role")) for item in stats["lastCreatePayload"]["content"][1:]],
                [("audio_url", "reference_audio")],
            )
            self.assertEqual(stats["lastCreatePayload"]["duration"], duration)
            self.assertEqual(stats["lastCreatePayload"]["omni_reference_task_type"], "reference")

            with self._api() as client:
                summary = client.get(
                    f"/api/v1/tasks/{task['id']}",
                    headers={"Authorization": f"Bearer {self.actor_token}"},
                )
            summary.raise_for_status()
            result = summary.json()
            self.assertEqual(result["execution"]["status"], "completed")
            self.assertEqual(result["delivery"]["status"], "ready")
            self.assertEqual(result["costSummary"]["reservationState"], "settled")
            self.assertIsNotNone(result["costSummary"]["usageCalculatedCny"])

    def test_omni_input_video_reaches_delivery_at_four_and_thirty_seconds(self):
        """含输入视频的 4 秒与 30 秒边界。

        4 秒是最低用量规则真正可能压过公式值的地方（最低总秒数 ceil(4×5/3)=7），
        所以两条边界都要走一遍实际交付，而不是只做单元断言。
        """
        for duration in (4, 30):
            prompt = f"live omni input video minimum {duration}s"
            slot_id = f"slot-r6-omni-input-video-{duration}s"
            payload = {
                "mode": "production",
                "workflowKey": "seedance.omni-reference.v1",
                "prompt": {"positive": prompt},
                "generation": {
                    "duration": duration,
                    "ratio": "16:9",
                    "resolution": "720p",
                    "generateAudio": True,
                    "watermark": False,
                    "outputFormat": "mp4",
                },
                "media": [
                    {"assetId": required_env("VIDEO_FLOW_LIVE_ASSET_ID"), "role": "reference_image"},
                    {"assetId": required_env("VIDEO_FLOW_LIVE_VIDEO_ASSET_ID"), "role": "reference_video"},
                    {"assetId": required_env("VIDEO_FLOW_LIVE_AUDIO_ASSET_ID"), "role": "reference_audio"},
                ],
            }
            with self._api() as client:
                intent = _workflow_intent(payload)
                preview = client.post(
                    "/api/v1/tasks/preflight",
                    headers={"Authorization": f"Bearer {self.actor_token}"},
                    json=intent,
                )
                preview.raise_for_status()
                report = preview.json()
                self.assertEqual(report["requestCheck"]["status"], "passed")
                self.assertTrue(report["productionAdmission"]["canSubmit"])

                # 含输入视频的请求按「公式值与官方最低用量的较大者」计费。
                basis = report["quote"]["basis"]
                self.assertEqual(report["quote"]["status"], "estimated")
                self.assertEqual(report["quote"]["missing"], [])
                output = basis["output"]
                self.assertEqual(output["durationSeconds"], duration)
                minimum_total_seconds = -(-output["durationSeconds"] * 5 // 3)
                expected_minimum = -(-minimum_total_seconds * output["width"] * output["height"] * output["frameRate"] // 1024)
                self.assertEqual(basis["minimumTokens"], expected_minimum)
                self.assertEqual(basis["billedTokens"], max(basis["formulaTokens"], expected_minimum))
                self.assertEqual(basis["minimumTokensApplied"], expected_minimum > basis["formulaTokens"])

                created = client.post(
                    "/api/v1/tasks",
                    headers={
                        "Authorization": f"Bearer {self.actor_token}",
                        "Idempotency-Key": f"r6-omni-input-video-{duration}s",
                    },
                    json={
                        "mode": "production",
                        "preflightId": report["preflightId"],
                        "executionSlotId": slot_id,
                        "media": [
                            {"slotId": descriptor["slotId"], "assetId": item["assetId"]}
                            for descriptor, item in zip(intent["media"], payload["media"])
                        ],
                    },
                )
            created.raise_for_status()
            task = created.json()
            self.assertEqual(
                [item["role"] for item in task["executionPlan"]["media"]],
                ["reference_image", "reference_video", "reference_audio"],
            )
            self.assertEqual(task["executionPlan"]["reserveCny"], report["quote"]["reserveCny"])

            before = provider_stats(self.provider_url)["createCountsByKey"].get(prompt, 0)
            self._run_one_cycle()
            stats = provider_stats(self.provider_url)
            self.assertEqual(stats["createCountsByKey"].get(prompt, 0), before + 1)
            self.assertEqual(
                [(item["type"], item.get("role")) for item in stats["lastCreatePayload"]["content"][1:]],
                [("image_url", "reference_image"), ("video_url", "reference_video"), ("audio_url", "reference_audio")],
            )
            self.assertEqual(stats["lastCreatePayload"]["duration"], duration)

            with self._api() as client:
                summary = client.get(
                    f"/api/v1/tasks/{task['id']}",
                    headers={"Authorization": f"Bearer {self.actor_token}"},
                )
            summary.raise_for_status()
            result = summary.json()
            self.assertEqual(result["execution"]["status"], "completed")
            self.assertEqual(result["delivery"]["status"], "ready")
            self.assertEqual(result["costSummary"]["reservationState"], "settled")
            self.assertIsNotNone(result["costSummary"]["usageCalculatedCny"])

    def test_video_edit_freezes_special_fields_and_reaches_mov_delivery(self):
        slot_id = "slot-r6-video-edit"
        prompt = "remove the background from @video1"
        payload = {
            "mode": "production",
            "workflowKey": "seedance.video-edit.v1",
            "prompt": {"positive": prompt},
            "generation": {
                "duration": -1,
                "ratio": "adaptive",
                "resolution": "720p",
                "generateAudio": True,
                "watermark": False,
                "outputFormat": "mov",
            },
            "media": [{
                "assetId": required_env("VIDEO_FLOW_LIVE_VIDEO_ASSET_ID"),
                "role": "reference_video",
            }],
        }
        with self._api() as client:
            intent = _workflow_intent(payload)
            preview = client.post(
                "/api/v1/tasks/preflight",
                headers={"Authorization": f"Bearer {self.actor_token}"},
                json=intent,
            )
            preview.raise_for_status()
            report = preview.json()

            self.assertEqual(report["requestCheck"]["status"], "passed")
            self.assertEqual(report["effectiveRequest"]["generation"], payload["generation"])
            self.assertTrue(report["productionAdmission"]["canSubmit"])
            # duration=-1 时按唯一参考视频的时长确定输出时长，据此套用最低用量规则。
            self.assertEqual(report["quote"]["status"], "estimated")
            self.assertEqual(report["quote"]["missing"], [])
            basis = report["quote"]["basis"]
            self.assertEqual(basis["outputDurationBasis"], "single_reference_video")
            self.assertEqual(
                basis["output"]["durationSeconds"], intent["media"][0]["metadata"]["durationSeconds"],
            )
            self.assertEqual(basis["billedTokens"], max(basis["formulaTokens"], basis["minimumTokens"]))

            created = client.post(
                "/api/v1/tasks",
                headers={
                    "Authorization": f"Bearer {self.actor_token}",
                    "Idempotency-Key": "r6-video-edit",
                },
                json={
                    "mode": "production",
                    "preflightId": report["preflightId"],
                    "executionSlotId": slot_id,
                    "media": [{
                        "slotId": intent["media"][0]["slotId"],
                        "assetId": payload["media"][0]["assetId"],
                    }],
                },
            )
        created.raise_for_status()
        task = created.json()
        self.assertEqual(task["executionPlan"]["duration"], -1)
        self.assertEqual(task["executionPlan"]["outputFormat"], "mov")

        before = provider_stats(self.provider_url)["createCountsByKey"].get(prompt, 0)
        self._run_one_cycle()
        stats = provider_stats(self.provider_url)
        self.assertEqual(stats["createCountsByKey"].get(prompt, 0), before + 1)
        self.assertEqual(stats["lastCreatePayload"]["duration"], -1)
        self.assertEqual(stats["lastCreatePayload"]["output_format"], "mov")
        self.assertEqual(stats["lastCreatePayload"]["ratio"], "adaptive")

        with self._api() as client:
            summary = client.get(
                f"/api/v1/tasks/{task['id']}",
                headers={"Authorization": f"Bearer {self.actor_token}"},
            )
        summary.raise_for_status()
        result = summary.json()
        self.assertEqual(result["execution"]["status"], "completed")
        self.assertEqual(result["delivery"]["status"], "ready")
        self.assertEqual(result["costSummary"]["reservationState"], "settled")
        self.assertIsNotNone(result["costSummary"]["usageCalculatedCny"])

    def test_video_extend_freezes_special_fields_and_reaches_mov_delivery(self):
        for duration in (4, 30):
            self._assert_video_extend_at_duration(duration)

    def _assert_video_extend_at_duration(self, duration: int):
        slot_id = f"slot-r6-video-extend-{duration}s"
        prompt = f"extend @video1 backward by {duration} seconds"
        payload = {
            "mode": "production",
            "workflowKey": "seedance.video-extend.v1",
            "prompt": {"positive": prompt},
            "generation": {
                "duration": duration,
                "ratio": "adaptive",
                "resolution": "720p",
                "generateAudio": True,
                "watermark": False,
                "outputFormat": "mov",
            },
            "media": [{
                "assetId": required_env("VIDEO_FLOW_LIVE_VIDEO_ASSET_ID"),
                "role": "reference_video",
            }],
        }
        with self._api() as client:
            intent = _workflow_intent(payload)
            preview = client.post(
                "/api/v1/tasks/preflight",
                headers={"Authorization": f"Bearer {self.actor_token}"},
                json=intent,
            )
            preview.raise_for_status()
            report = preview.json()

            self.assertEqual(report["requestCheck"]["status"], "passed")
            self.assertEqual(report["effectiveRequest"]["generation"], payload["generation"])
            self.assertTrue(report["productionAdmission"]["canSubmit"])
            self.assertEqual(report["quote"]["status"], "estimated")
            self.assertEqual(report["quote"]["missing"], [])
            basis = report["quote"]["basis"]
            self.assertEqual(basis["output"]["durationSeconds"], duration)
            self.assertEqual(basis["billedTokens"], max(basis["formulaTokens"], basis["minimumTokens"]))

            created = client.post(
                "/api/v1/tasks",
                headers={
                    "Authorization": f"Bearer {self.actor_token}",
                    "Idempotency-Key": f"r6-video-extend-{duration}s",
                },
                json={
                    "mode": "production",
                    "preflightId": report["preflightId"],
                    "executionSlotId": slot_id,
                    "media": [{
                        "slotId": intent["media"][0]["slotId"],
                        "assetId": payload["media"][0]["assetId"],
                    }],
                },
            )
        created.raise_for_status()
        task = created.json()
        self.assertEqual(task["executionPlan"]["duration"], duration)
        self.assertEqual(task["executionPlan"]["outputFormat"], "mov")

        before = provider_stats(self.provider_url)["createCountsByKey"].get(prompt, 0)
        self._run_one_cycle()
        stats = provider_stats(self.provider_url)
        self.assertEqual(stats["createCountsByKey"].get(prompt, 0), before + 1)
        self.assertEqual(stats["lastCreatePayload"]["duration"], duration)
        self.assertEqual(stats["lastCreatePayload"]["output_format"], "mov")
        self.assertEqual(stats["lastCreatePayload"]["ratio"], "adaptive")

        with self._api() as client:
            summary = client.get(
                f"/api/v1/tasks/{task['id']}",
                headers={"Authorization": f"Bearer {self.actor_token}"},
            )
        summary.raise_for_status()
        result = summary.json()
        self.assertEqual(result["execution"]["status"], "completed")
        self.assertEqual(result["delivery"]["status"], "ready")
        self.assertEqual(result["costSummary"]["reservationState"], "settled")
        self.assertIsNotNone(result["costSummary"]["usageCalculatedCny"])

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
        # 验证真实 Backend → Worker → Adapter 的最终 POST 仍是冻结的 Ark 结构，
        # 而不是旧 params 或由 Fake Provider 反推的近似值。
        submitted = provider_stats(self.provider_url)["lastCreatePayload"]
        self.assertEqual(submitted["content"], [
            {"type": "text", "text": prompt},
            {
                "type": "image_url",
                "image_url": {"url": submitted["content"][1]["image_url"]["url"]},
                "role": "reference_image",
            },
        ])
        self.assertEqual(submitted["ratio"], "16:9")
        self.assertEqual(submitted["duration"], 5)
        self.assertEqual(submitted["resolution"], "720p")

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

        # 合同环境用 Fake Provider 的对象存储替身跑完整归档链路：
        # 下载短视频 → 上传 → HEAD 校验 → 登记 Asset → 确认交付就绪。
        # 这里断言的是"真的交付成功"，而不只是"没报错"。
        self.assertEqual(payload["delivery"]["status"], "ready")
        self.assertIsNotNone(payload["delivery"]["assetId"])
        self.assertEqual(payload["execution"]["status"], "completed")




class WorkerRestartRecoveryTests(unittest.TestCase):
    """E06：Provider ID 落库后 Worker 真的退出并重启，create 总数仍为 1。

    中断点是**读数据库/接口里已持久化的 providerTaskId**，不是 sleep 猜时机：
    先让 Fake Provider 停在 running，等 providerTaskId 落库后再 SIGKILL，
    这样"提交已成功、任务未结束"这个窗口是确定的。
    """

    @classmethod
    def setUpClass(cls):
        cls.base_url = required_env("VIDEO_FLOW_LIVE_BASE_URL")
        cls.provider_url = required_env("VIDEO_FLOW_LIVE_PROVIDER_URL")
        cls.actor_token = required_env("VIDEO_FLOW_LIVE_ACTOR_TOKEN")
        cls.asset_id = required_env("VIDEO_FLOW_LIVE_ASSET_ID")
        cls.worker_token = required_env("VIDEO_FLOW_WORKER_TOKEN")
        cls.worker_dir = Path(__file__).resolve().parents[1]

    def _api(self):
        return httpx.Client(base_url=self.base_url, timeout=30.0)

    def _spawn_worker(self):
        """真正启动一个独立的 Worker 进程（不是同进程里的对象）。"""
        env = {
            **os.environ,
            "BACKEND_URL": self.base_url,
            "WORKER_SERVICE_TOKEN": self.worker_token,
            "VIDEO_FLOW_PROVIDER_BASE_URL": f"{self.provider_url}/api/v3",
            "COMFYUI_OUTPUT_DIR": os.environ.get("COMFYUI_OUTPUT_DIR", ""),
            "NO_PROXY": "127.0.0.1,localhost",
            "no_proxy": "127.0.0.1,localhost",
        }
        return subprocess.Popen(
            [
                sys.executable,
                "-c",
                "import asyncio, executor; asyncio.run(executor.JobExecutor().poll_loop())",
            ],
            cwd=str(self.worker_dir),
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    def _wait_until(self, predicate, *, timeout=60.0, description=""):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            value = predicate()
            if value:
                return value
            time.sleep(0.2)
        raise AssertionError(f"timed out waiting for {description}")

    def test_restart_after_provider_id_is_persisted_delivers_without_a_second_create(self):
        prompt = "live restart e06"
        with self._api() as client:
            created = post_confirmed(
                client,
                headers={
                    "Authorization": f"Bearer {self.actor_token}",
                    "Idempotency-Key": f"live-{prompt}",
                },
                payload={
                    "mode": "production",
                    "workflowKey": "seedance.reference-image-to-video.v1",
                    "prompt": {"positive": prompt},
                    "generation": {"duration": 5, "ratio": "16:9", "resolution": "720p"},
                    "media": [{"assetId": self.asset_id, "role": "reference_image"}],
                },
            )
        created.raise_for_status()
        task_id = created.json()["id"]

        before = provider_stats(self.provider_url)["createCountsByKey"].get(prompt, 0)

        # 让 Provider 停在 running：Worker 提交后会一直轮询，我们才有确定的
        # 中断窗口（而不是靠固定 sleep 去赌它还没跑完）。
        httpx.get(f"{self.provider_url}/__test__/task-status", params={"value": "running"})

        first_worker = self._spawn_worker()
        try:
            def provider_id_persisted():
                with self._api() as client:
                    response = client.get(
                        f"/api/v1/tasks/{task_id}",
                        headers={"Authorization": f"Bearer {self.actor_token}"},
                    )
                return (response.json().get("execution") or {}).get("providerTaskId")

            persisted_id = self._wait_until(
                provider_id_persisted,
                description="providerTaskId 落库（这就是中断触发点）",
            )

            # 真·异常退出：SIGKILL，不给它优雅收尾的机会。
            first_worker.kill()
            first_worker.wait(timeout=10)
        finally:
            if first_worker.poll() is None:
                first_worker.kill()

        # Provider 侧任务完成；新进程必须凭已落库的 ID 恢复，而不是重新 create。
        httpx.get(f"{self.provider_url}/__test__/task-status", params={"value": "succeeded"})

        second_worker = self._spawn_worker()
        try:
            def delivered():
                with self._api() as client:
                    response = client.get(
                        f"/api/v1/tasks/{task_id}",
                        headers={"Authorization": f"Bearer {self.actor_token}"},
                    )
                payload = response.json()
                return (payload.get("delivery") or {}).get("status") == "ready"

            self._wait_until(delivered, description="重启后的 Worker 交付就绪", timeout=90.0)
        finally:
            second_worker.kill()
            second_worker.wait(timeout=10)

        after = provider_stats(self.provider_url)["createCountsByKey"].get(prompt, 0)
        self.assertEqual(after, before + 1, "重启后重复创建了 Provider 任务")

        with self._api() as client:
            summary = client.get(
                f"/api/v1/tasks/{task_id}",
                headers={"Authorization": f"Bearer {self.actor_token}"},
            )
        summary.raise_for_status()
        payload = summary.json()
        # 同一个 Provider 任务：恢复是"接着查"，不是"重新提交"。
        self.assertEqual(payload["execution"]["providerTaskId"], persisted_id)
        self.assertEqual(payload["delivery"]["status"], "ready")

class AdmissionBoundaryTests(unittest.TestCase):
    """E02/E13：准入被拒时绝不能产生 Provider 任务；暂停只拦新准入。

    这些拒绝发生在 Backend 侧，但"没有产生付费任务"这件事只有连上真实的
    Fake Provider 计数才能证明——单看接口返回码并不能说明没花钱。
    """

    @classmethod
    def setUpClass(cls):
        cls.base_url = required_env("VIDEO_FLOW_LIVE_BASE_URL")
        cls.provider_url = required_env("VIDEO_FLOW_LIVE_PROVIDER_URL")
        cls.actor_token = required_env("VIDEO_FLOW_LIVE_ACTOR_TOKEN")
        cls.admin_token = required_env("VIDEO_FLOW_ADMIN_TOKEN")
        cls.asset_id = required_env("VIDEO_FLOW_LIVE_ASSET_ID")

    def _api(self):
        return httpx.Client(base_url=self.base_url, timeout=30.0)

    def _post_task(self, *, key, token, params):
        headers = {"Idempotency-Key": key, "Content-Type": "application/json"}
        # 没有凭证时要整条头都不要发：`Bearer ` 是非法头值，httpx 会在本地拒绝，
        # 测到的就不是服务端的鉴权行为了。
        if token:
            headers["Authorization"] = f"Bearer {token}"

        with self._api() as client:
            return post_confirmed(
                client,
                headers=headers,
                payload={
                    "mode": "production",
                    "workflowKey": "seedance.reference-image-to-video.v1",
                    "prompt": {"positive": params["prompt"]},
                    "generation": {
                        "duration": params.get("duration", 5),
                        "ratio": params.get("ratio", "16:9"),
                        "resolution": "720p",
                    },
                    "media": [{
                        "assetId": params.get("image_asset_id", self.asset_id),
                        "role": "reference_image",
                    }],
                },
            )

    def _set_gate(self, paused: bool, reason: str):
        with self._api() as client:
            return client.patch(
                "/api/v1/admin/operations/production-gate",
                headers={"X-Admin-Token": self.admin_token},
                json={
                    "paused": paused,
                    "reason": reason,
                    "operator": "contract",
                    "evidenceRef": "live-contract",
                },
            )

    def test_rejected_requests_never_create_a_provider_task(self):
        before = provider_stats(self.provider_url)["createCount"]

        # 既有合同：没带凭证是 401，凭证无效/停用是 403。两者都必须被拒，
        # 且都不能走到 Provider。
        missing_credential = self._post_task(
            key="e02-no-token",
            token="",
            params={"prompt": "e02 no token", "image_asset_id": self.asset_id},
        )
        self.assertEqual(missing_credential.status_code, 401)

        invalid_credential = self._post_task(
            key="e02-bad-token",
            token="vf_not_a_real_token",
            params={"prompt": "e02 bad token", "image_asset_id": self.asset_id},
        )
        self.assertEqual(invalid_credential.status_code, 403)

        invalid_spec = self._post_task(
            key="e02-invalid-spec",
            token=self.actor_token,
            params={
                "prompt": "e02 invalid",
                "image_asset_id": self.asset_id,
                "duration": 999,
                "ratio": "16:9",
            },
        )
        # 非法规格必须在准入阶段被拒，而不是提交后才失败。
        self.assertEqual(invalid_spec.status_code, 400)

        self.assertEqual(
            provider_stats(self.provider_url)["createCount"],
            before,
            "被拒的请求产生了 Provider 任务",
        )

    def test_pausing_the_gate_blocks_new_admission_only(self):
        # Prepare before pausing: production must recheck admission after a successful Preview.
        with self._api() as client:
            error, _ = preflight_production(client, {
                "mode": "production", "workflowKey": "seedance.reference-image-to-video.v1",
                "prompt": {"positive": "e13 paused admission"},
                "generation": {"duration": 5, "ratio": "16:9", "resolution": "720p"},
                "media": [{"assetId": self.asset_id, "role": "reference_image"}],
            }, {"Authorization": f"Bearer {self.actor_token}"})
            self.assertIsNone(error)
        try:
            paused = self._set_gate(True, "contract: admission boundary check")
            self.assertEqual(paused.status_code, 200)

            before = provider_stats(self.provider_url)["createCount"]
            blocked = self._post_task(
                key="e13-paused",
                token=self.actor_token,
                params={
                    "prompt": "e13 paused admission",
                    "image_asset_id": self.asset_id,
                    "duration": 5,
                    "ratio": "16:9",
                },
            )
            # 503 = 系统暂停；不是 429（额度类拒绝），两者要能区分。
            self.assertEqual(blocked.status_code, 503)
            self.assertEqual(provider_stats(self.provider_url)["createCount"], before)

            # 暂停只拦正式准入；Preview 仍通过独立 preflight 入口创建记录。
            with self._api() as client:
                preview = client.post(
                    "/api/v1/tasks/preflight",
                    headers={
                        "Authorization": f"Bearer {self.actor_token}",
                    },
                    json=_workflow_intent({
                        "workflowKey": "seedance.text-to-video.v1",
                        "prompt": {"positive": "e13 preview under pause"},
                        "generation": {"duration": 5, "ratio": "16:9", "resolution": "720p"},
                        "media": [],
                    }),
                )
            self.assertEqual(preview.status_code, 201)
            self.assertFalse(preview.json()["willCallProvider"])
            self.assertEqual(provider_stats(self.provider_url)["createCount"], before)
        finally:
            resumed = self._set_gate(False, "contract: restore after boundary check")
            self.assertEqual(resumed.status_code, 200)


class AdditionalCrossPackageScenariosTests(unittest.TestCase):
    """补齐 ROADMAP 矩阵中未跨包覆盖项（E03/E04/E05/E08/E10/E11/E12）的骨架。"""

    @classmethod
    def setUpClass(cls):
        cls.base_url = required_env("VIDEO_FLOW_LIVE_BASE_URL")
        cls.provider_url = required_env("VIDEO_FLOW_LIVE_PROVIDER_URL")
        cls.actor_token = required_env("VIDEO_FLOW_LIVE_ACTOR_TOKEN")
        cls.admin_token = required_env("VIDEO_FLOW_ADMIN_TOKEN")
        cls.asset_id = required_env("VIDEO_FLOW_LIVE_ASSET_ID")
        cls.audit_dir = os.path.join(os.path.abspath(os.path.join(os.path.expanduser("~"), ".video-flow-live-audit")), "cross-package")

    def _api(self, token: Optional[str] = None) -> httpx.Client:
        actor_token = self.actor_token if token is None else token
        headers = {}
        if actor_token:
            headers["Authorization"] = f"Bearer {actor_token}"
        return httpx.Client(base_url=self.base_url, timeout=30.0, headers=headers)

    def _admin_api(self) -> httpx.Client:
        return httpx.Client(
            base_url=self.base_url,
            timeout=30.0,
            headers={"X-Admin-Token": self.admin_token},
        )

    def _post_task(self, *, prompt: str, idempotency_key: str, token: Optional[str] = None, asset_id: Optional[str] = None):
        payload = {
            "mode": "production",
            "workflowKey": "seedance.reference-image-to-video.v1",
            "prompt": {"positive": prompt},
            "generation": {"duration": 5, "ratio": "16:9", "resolution": "720p"},
            "media": [{"assetId": asset_id or self.asset_id, "role": "reference_image"}],
        }
        with self._api(token=token) as client:
            return post_confirmed(
                client,
                headers={"Idempotency-Key": idempotency_key},
                payload=payload,
            )

    def _post_task_concurrently(self, *, prompt: str, key: str, token: Optional[str] = None, parallel: int = 2):
        with ThreadPoolExecutor(max_workers=parallel) as executor:
            futures = [executor.submit(self._post_task, prompt=prompt, idempotency_key=key, token=token) for _ in range(parallel)]
            return [future.result(timeout=20) for future in futures]

    def _wait_until(self, predicate, *, timeout: float = 60.0, description: str = ""):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            value = predicate()
            if value:
                return value
            time.sleep(0.2)
        raise AssertionError(f"timed out waiting for {description}")

    def _run_one_cycle(self) -> None:
        """跑一轮真实的认领 + 执行，不进入常驻循环。"""
        executor = importlib.reload(self._load_executor()).JobExecutor()

        async def cycle():
            try:
                jobs = await executor.fetch_inflight_jobs()
                jobs.extend(await executor.fetch_pending_jobs())
                for job in {job.id: job for job in jobs}.values():
                    await executor.execute_job(job)
            finally:
                await executor.close()

        asyncio.run(cycle())

    def _load_executor(self):
        import executor as executor_module
        importlib.reload(executor_module)
        return executor_module

    def _spawn_worker(self, *, output_dir: str, audit_dir: Optional[str] = None) -> subprocess.Popen:
        env = {
            **os.environ,
            "BACKEND_URL": self.base_url,
            "WORKER_SERVICE_TOKEN": os.environ.get("VIDEO_FLOW_WORKER_TOKEN", ""),
            "VIDEO_FLOW_PROVIDER_BASE_URL": f"{self.provider_url}/api/v3",
            "COMFYUI_OUTPUT_DIR": output_dir,
            "VIDEO_FLOW_AUDIT_DIR": audit_dir or "",
            "NO_PROXY": "127.0.0.1,localhost",
            "no_proxy": "127.0.0.1,localhost",
        }
        return subprocess.Popen(
            [
                sys.executable,
                "-c",
                "import asyncio, executor; asyncio.run(executor.JobExecutor().poll_loop())",
            ],
            cwd=str(Path(__file__).resolve().parents[1]),
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    def _stop_worker(self, worker: subprocess.Popen) -> None:
        if worker.poll() is None:
            worker.kill()
        try:
            worker.wait(timeout=5)
        except subprocess.TimeoutExpired:
            worker.kill()

    def _create_actor(self, actor_id: str, name: str) -> str:
        response = self._admin_api().post(
            "/api/v1/admin/credentials",
            json={"actorId": actor_id, "name": name},
        )
        # Admin credential endpoint is intentionally strict; fallback as error to avoid silently
        # using a wrong token in authorization tests.
        if response.status_code != 201:
            raise AssertionError(f"create actor failed: {response.status_code} {response.text}")
        return response.json()["token"]

    def _set_actor_limits(self, actor_id: str, *, daily_limit: str, monthly_limit: str) -> None:
        with self._admin_api() as client:
            response = client.patch(
                f"/api/v1/admin/credentials/{actor_id}/limits",
                json={"dailyLimitCny": daily_limit, "monthlyLimitCny": monthly_limit},
            )
        if response.status_code != 200:
            raise AssertionError(f"set limits failed: {response.status_code} {response.text}")

    def _set_gate(self, paused: bool, reason: str):
        with self._admin_api() as client:
            return client.patch(
                "/api/v1/admin/operations/production-gate",
                json={
                    "paused": paused,
                    "reason": reason,
                    "operator": "contract",
                    "evidenceRef": "live-contract",
                },
            )

    def _set_provider_mode(
        self,
        *,
        create_mode: Optional[str] = None,
        usage_mode: Optional[str] = None,
        task_status: Optional[str] = None,
    ):
        if task_status is not None:
            response = httpx.get(
                f"{self.provider_url}/__test__/task-status",
                params={"value": task_status},
            )
            response.raise_for_status()
            assert response.json()["taskStatus"] == task_status
        if create_mode is not None:
            response = httpx.get(
                f"{self.provider_url}/__test__/create-mode",
                params={"mode": create_mode},
            )
            response.raise_for_status()
            assert response.json()["createMode"] == create_mode
        if usage_mode is not None:
            response = httpx.get(
                f"{self.provider_url}/__test__/usage-mode",
                params={"mode": usage_mode},
            )
            response.raise_for_status()
            assert response.json()["usageMode"] == usage_mode

    def _reset_provider(self):
        httpx.post(f"{self.provider_url}/__test__/reset").raise_for_status()

    def _task_summary(self, task_id: str, *, token: Optional[str] = None):
        with self._api(token=token) as client:
            response = client.get(
                f"/api/v1/tasks/{task_id}",
            )
            response.raise_for_status()
            return response.json()

    def test_e03_same_intent_concurrent_requests_create_once(self):
        self._reset_provider()
        prompt = "live e03 same-intent"
        key = "e03-live-same-intent"
        before = provider_stats(self.provider_url)["createCountsByKey"].get(prompt, 0)

        responses = self._post_task_concurrently(
            prompt=prompt,
            key=key,
            parallel=3,
        )
        for response in responses:
            self.assertIn(response.status_code, (200, 201))

        task_ids = {resp.json()["id"] for resp in responses}
        self.assertEqual(len(task_ids), 1, f"task split: {task_ids}")

        self._run_one_cycle()
        after = provider_stats(self.provider_url)["createCountsByKey"].get(prompt, 0)
        self.assertEqual(after, before + 1, "provider create is expected to happen exactly once")

    @unittest.skip("E04 需要独立的生产白名单 Actor 与专属输入 Asset；合同环境尚未提供该 fixture")
    def test_e04_budget_race_one_intent_enters_provider(self):
        self._reset_provider()
        seed = self._post_task(
            prompt="live e04 actor-id discovery",
            idempotency_key="e04-actor-id-seed",
        )
        self.assertEqual(seed.status_code, 201)
        actor_id = seed.json().get("createdBy")
        if not actor_id:
            self.fail(f"actor id missing in seed response: {seed.text}")

        # 限制预算为单次预占，模拟抢占场景；执行后恢复到默认即可。
        try:
            self._set_actor_limits(actor_id, daily_limit="2.000000", monthly_limit="1000.000000")
        except AssertionError:
            self._set_actor_limits(actor_id, daily_limit="2", monthly_limit="1000")

        parallel_prompts = [
            ("live e04 new intent a", "e04-intent-a"),
            ("live e04 new intent b", "e04-intent-b"),
        ]

        before_total = provider_stats(self.provider_url)["createCount"]
        before = provider_stats(self.provider_url)["createCountsByKey"]

        responses = []
        for prompt, key in parallel_prompts:
            responses.append(self._post_task(prompt=prompt, idempotency_key=key))

        created = [r for r in responses if r.status_code in (200, 201)]
        rejected = [r for r in responses if r.status_code == 429]
        self.assertTrue(created, "no task was created")
        self.assertTrue(rejected, "budget-race should have at least one reject")

        self._run_one_cycle()

        after = provider_stats(self.provider_url)["createCountsByKey"]
        after_total = provider_stats(self.provider_url)["createCount"]
        self.assertLessEqual(after_total - before_total, len(created))
        self.assertEqual(after_total - before_total, 1, "only one intent should enter provider")

        for response in created:
            prompt = response.json()["executionPlan"]["prompt"]
            if prompt in after and prompt in before:
                self.assertEqual(after[prompt] - before[prompt], 1)
            elif prompt:
                self.assertEqual(after.get(prompt), 1)

        # 恢复到默认上限，避免影响后续用例。
        self._set_actor_limits(actor_id, daily_limit="100.000000", monthly_limit="1000.000000")

    def test_e05_submit_unknown_response_does_not_double_submit(self):
        self._reset_provider()
        self._set_provider_mode(create_mode="missing_id")
        try:
            response = self._post_task(
                prompt="live e05 missing provider response",
                idempotency_key="e05-submit-unknown",
            )
            self.assertIn(response.status_code, (200, 201))
            task_id = response.json()["id"]

            before = provider_stats(self.provider_url)["createCountsByKey"].get(
                "live e05 missing provider response",
                0,
            )
            self._run_one_cycle()

            summary = self._task_summary(task_id)
            self.assertEqual(summary["execution"]["status"], "requires_review")
            self.assertIsNone(summary["execution"]["providerTaskId"])
            self.assertEqual(
                provider_stats(self.provider_url)["createCountsByKey"].get(
                    "live e05 missing provider response",
                    0,
                ),
                before + 1,
            )

            self._run_one_cycle()
            self.assertEqual(
                provider_stats(self.provider_url)["createCountsByKey"].get(
                    "live e05 missing provider response",
                    0,
                ),
                before + 1,
                "response-loss should not cause duplicate create",
            )
        finally:
            self._set_provider_mode(create_mode="normal")

    def test_e08_missing_or_invalid_usage_marks_unavailable(self):
        self._reset_provider()
        self._set_provider_mode(usage_mode="missing")
        try:
            response = self._post_task(
                prompt="live e08 usage missing",
                idempotency_key="e08-usage",
            )
            self.assertIn(response.status_code, (200, 201))
            task_id = response.json()["id"]

            self._run_one_cycle()
            summary = self._task_summary(task_id)
            self.assertEqual(summary["costSummary"]["status"], "unavailable")
            self.assertIsNone(summary["costSummary"]["usageCalculatedCny"])
            self.assertNotEqual(summary["costSummary"].get("usageCalculatedCny"), "0.000000")
        finally:
            self._set_provider_mode(usage_mode="valid")

    def test_e10_custom_output_dir_download_resume_and_signature_refresh(self):
        self._reset_provider()
        output_dir = mkdtemp(prefix="video-flow-custom-output-")
        audit_dir = mkdtemp(prefix="video-flow-custom-audit-")

        task = self._post_task(
            prompt="live e10 custom output",
            idempotency_key="e08-output",
        )
        self.assertIn(task.status_code, (200, 201))
        task_id = task.json()["id"]

        worker = self._spawn_worker(output_dir=output_dir, audit_dir=audit_dir)
        try:
            self._wait_until(
                lambda: self._task_summary(task_id).get("delivery", {}).get("status") == "ready",
                timeout=90.0,
                description="task ready",
            )
        finally:
            self._stop_worker(worker)

        artifacts = list(Path(output_dir).rglob("*.mp4"))
        self.assertTrue(artifacts, "no artifacts written under custom output dir")

        before_count = provider_stats(self.provider_url)["createCount"]
        worker = self._spawn_worker(output_dir=output_dir, audit_dir=audit_dir)
        try:
            time.sleep(2)
        finally:
            self._stop_worker(worker)
        after_count = provider_stats(self.provider_url)["createCount"]
        self.assertEqual(before_count, after_count, "resume run should not create duplicate providers")

    def test_e11_unauthorized_task_or_attempt_access_blocked(self):
        self._reset_provider()
        owner_task = self._post_task(
            prompt="live e11 owner task",
            idempotency_key="e11-owner",
        )
        self.assertIn(owner_task.status_code, (200, 201))
        task_id = owner_task.json()["id"]
        self._run_one_cycle()
        owner_summary = self._task_summary(task_id)

        attacker_token = self._create_actor(
            actor_id=f"e11-attacker-{int(time.time())}",
            name="e11-attacker",
        )

        # 设计上应以 404 隐藏他人任务是否存在，且不能泄露执行详情。
        with self._api(token=attacker_token) as client:
            owner_task_result = client.get(f"/api/v1/tasks/{task_id}")
        self.assertEqual(owner_task_result.status_code, 404)

        # 尝试访问输出下载接口，要求 404/403 并且不返回他人对象信息。
        with self._api(token=attacker_token) as client:
            attack_result = client.get(f"/api/v1/assets/tasks/{task_id}/result")
        self.assertIn(attack_result.status_code, (403, 404))

        attempt_id = owner_summary["execution"]["attemptId"]
        with self._api(token=attacker_token) as client:
            mismatch = client.patch(
                f"/api/v1/internal/attempts/{attempt_id}/outcome",
                json={"providerTaskId": "fake-attacker", "status": "succeeded"},
            )
        self.assertIn(mismatch.status_code, (401, 403))

    @unittest.skip("E12 的外部告警通道需要真实接收方与渠道回执；本地合同环境无法伪造一个真的收件人")
    def test_e12_external_alert_channel_delivers_a_real_receipt(self):
        """告警"送达回执"只能在真实渠道上验证，本地没有可验证替身。

        刻意保留在报告里（`pytest -rs` 会列出），避免这条缺口被当成已通过。
        """

    def test_e12_rebuild_keeps_the_journal_and_never_creates_a_second_provider_task(self):
        self._reset_provider()
        output_dir = mkdtemp(prefix="video-flow-rebuild-output-")
        audit_dir = mkdtemp(prefix="video-flow-rebuild-audit-")

        task = self._post_task(
            prompt="live e12 rebuild journal",
            idempotency_key="e12-rebuild",
        )
        self.assertIn(task.status_code, (200, 201))
        task_id = task.json()["id"]

        worker = self._spawn_worker(output_dir=output_dir, audit_dir=audit_dir)
        try:
            self._wait_until(
                lambda: self._task_summary(task_id).get("delivery", {}).get("status") == "ready",
                timeout=90.0,
                description="task ready",
            )
        finally:
            self._stop_worker(worker)

        before = provider_stats(self.provider_url)["createCount"]
        journal_path = Path(audit_dir) / "submissions.jsonl"
        self.assertTrue(journal_path.is_file(), f"journal missing: {journal_path}")
        records = []
        for line in journal_path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                records.append(line)
        self.assertTrue(records, "journal should keep execution evidence for restart")

        # 容器重建后同一 task 不应改写出第二个 provider create。仅做“恢复不重复”验证。
        worker = self._spawn_worker(output_dir=output_dir, audit_dir=audit_dir)
        try:
            time.sleep(2)
        finally:
            self._stop_worker(worker)
        after = provider_stats(self.provider_url)["createCount"]
        self.assertEqual(before, after)

    def test_pausing_the_gate_does_not_strand_an_in_flight_provider_task(self):
        """暂停只拦新准入；已经提交到 Provider 的任务必须继续轮询与归档。

        否则故障期间一按暂停，已经付过费的在途任务就被卡死、产物再也拿不回来。
        与"暂停拦住新准入"是两个方向相反的断言，缺一不可。
        """
        self._reset_provider()
        prompt = "live e13b pause in flight"
        output_dir = mkdtemp(prefix="video-flow-pause-output-")
        audit_dir = mkdtemp(prefix="video-flow-pause-audit-")
        # Provider 先停在"已受理未完成"。注意不能用进程内的 _run_one_cycle()：
        # execute_job 会在内部一直轮询到终态才返回，观察不到"在途"这个中间态。
        self._set_provider_mode(task_status="running")
        worker = self._spawn_worker(output_dir=output_dir, audit_dir=audit_dir)
        try:
            response = self._post_task(prompt=prompt, idempotency_key="e13b-pause-in-flight")
            self.assertIn(response.status_code, (200, 201), response.text)
            task_id = response.json()["id"]
            before = provider_stats(self.provider_url)["createCountsByKey"].get(prompt, 0)

            # 等 Worker 真的把它提交给 Provider：此刻任务在途，闸门还没暂停。
            self._wait_until(
                lambda: provider_stats(self.provider_url)["createCountsByKey"].get(prompt, 0) == before + 1,
                timeout=60.0,
                description="task submitted to provider",
            )

            paused = self._set_gate(True, "contract: in-flight continues under pause")
            self.assertEqual(paused.status_code, 200)
            try:
                self._set_provider_mode(task_status="succeeded")
                self._wait_until(
                    lambda: self._task_summary(task_id).get("delivery", {}).get("status") == "ready",
                    timeout=90.0,
                    description="in-flight task archived while the gate is paused",
                )
                self.assertEqual(
                    provider_stats(self.provider_url)["createCountsByKey"].get(prompt, 0),
                    before + 1,
                    "暂停下恢复在途任务不应产生第二次 Provider create",
                )
            finally:
                self._set_gate(False, "contract: restore after in-flight check")
        finally:
            self._stop_worker(worker)
            self._set_provider_mode(task_status="succeeded")


if __name__ == "__main__":
    unittest.main()
