import asyncio
import httpx
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

from comfyui_client import ComfyUIClient
from comfyui_executor import (
    ComfyUIDryRunExecutor,
    ComfyUIExecutionError,
    ComfyUIExecutionResult,
)
from config import get_settings
from models import FailureType, Job, JobStatus
from providers.seedance_adapter import ProviderSubmissionUncertainError, SeedanceAdapter
from recovery import build_cost_audit, cost_status, format_cost, is_stale_job, should_resume_job
from oss_uploader import OssUploader

settings = get_settings()


def _normalize_cost_status(cost_status: Optional[str]) -> str:
    """Map runtime cost status to backend accepted enum values."""
    if not cost_status or not isinstance(cost_status, str):
        return "unavailable"

    normalized = cost_status.lower().strip()
    if normalized == "confirmed":
        return "usage_calculated"

    if normalized in {"estimated", "usage_calculated", "billed", "unavailable"}:
        return normalized

    return "unavailable"


class JobExecutor:
    """任务执行器 - 负责从 Backend 拉取任务并执行"""

    def __init__(self):
        # 缓存配置实例，减少重复解析环境变量带来的重复开销。
        self.backend_url = settings.backend_url
        # 重用异步 HTTP client，降低轮询任务执行时的连接建立成本。
        # claim / recover / PATCH 已加 WorkerServiceGuard，统一在默认头上带服务令牌。
        self.client = httpx.AsyncClient(
            timeout=30.0, headers=self._worker_headers()
        )
        # provider 适配器按能力名映射，新增供应商时只需扩展此字典。
        self.adapters = {
            "seedance": SeedanceAdapter()
        }
        # 所有任务统一落在输出目录，便于回收和排障。
        self.output_dir = Path(settings.comfyui_output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.oss_uploader = OssUploader()
        # 记录已经在提交后落库失败的 ComfyUI 任务，防止重复重跑造成脏状态。
        self._comfyui_quarantined_job_ids: set[str] = set()
        # 记录缺少持久化状态更新的任务，需要人工介入。
        self._comfyui_manual_intervention_job_ids: set[str] = set()
        self.comfyui_client = None
        self.comfyui_executor = None
        if settings.comfyui_enabled is True:
            self.comfyui_client = ComfyUIClient(settings.comfyui_url)
            self.comfyui_executor = ComfyUIDryRunExecutor(
                self.comfyui_client,
                settings.comfyui_workflow_path,
                settings.comfyui_output_dir,
                poll_interval=settings.task_status_check_interval,
                client_id=settings.comfyui_client_id,
                on_submitted=self._record_comfyui_submission,
            )

    @staticmethod
    def _worker_headers() -> Dict[str, str]:
        """Backend 的 Worker 私有接口要求 X-Worker-Token。"""
        token = getattr(settings, "worker_service_token", "")
        return {"X-Worker-Token": token} if token else {}

    async def fetch_pending_jobs(self, limit: int = 10) -> list[Job]:
        """通过原子 claim 拿 pending 任务，支持并发 worker 不重复领取。"""
        claimed_jobs: list[Job] = []

        for _ in range(limit):
            try:
                response = await self.client.post(
                    f"{self.backend_url}/api/tasks/claim",
                    json={},
                )
                response.raise_for_status()

                payload = response.json()
                if not payload:
                    break

                claimed_jobs.append(Job(**payload))
            except Exception as e:
                # 网络波动时直接中断该轮，等待下一轮轮询。
                print(f"Failed to claim jobs: {e}")
                break

        return claimed_jobs

    async def fetch_inflight_jobs(self) -> list[Job]:
        """Fetch submitted/running jobs so polling survives worker restarts."""
        jobs: list[Job] = []

        try:
            response = await self.client.get(
                f"{self.backend_url}/api/tasks/recover"
            )
            response.raise_for_status()

            data = response.json()
            if isinstance(data, list):
                jobs.extend(Job(**job) for job in data)
        except Exception as e:
            print(f"Failed to fetch inflight jobs: {e}")
            return []

        resumable: list[Job] = []
        for job in jobs:
            job_state = {
                "status": job.status,
                "provider_task_id": job.providerTaskId,
                "submitted_at": job.attemptSubmittedAt or job.submittedAt,
            }

            if should_resume_job(job_state):
                resumable.append(job)
                continue

            if job.status in {JobStatus.SUBMITTED.value, JobStatus.RUNNING.value}:
                if (
                    job.attemptId
                    and job.attemptStatus == "submitted"
                    and not job.providerTaskId
                ):
                    persisted = await self.update_job_status(
                        job.id,
                        JobStatus.FAILED,
                        attempt_id=job.attemptId,
                        attempt_status="requires_review",
                        failure_type=FailureType.UNKNOWN,
                        failure_code="PERSISTENCE_UNKNOWN",
                        failure_message="Provider submission may have happened, need review",
                        task_status='requires_review',
                    )
                    if persisted:
                        print(
                            f"[{job.id}] In-flight job moved to requires_review: "
                            "provider submission state is uncertain"
                        )
                    else:
                        print(
                            f"[{job.id}] In-flight job requires_review update failed "
                            "and may be replayed"
                        )
                    continue

                if (
                    job.attemptId
                    and job.attemptStatus == "pending"
                    and not job.providerTaskId
                ):
                    # Worker 领取后、提交 Provider 前中断：尚未产生付费任务，
                    # 安全做法是放回 pending，由下一轮以新 attempt 重新领取。
                    requeued = await self.update_job_status(
                        job.id,
                        JobStatus.PENDING,
                        attempt_id=job.attemptId,
                        attempt_status="failed",
                        failure_type=FailureType.UNKNOWN,
                        failure_code="ABANDONED_BEFORE_SUBMIT",
                        failure_message="Released before provider submission",
                        task_status="pending",
                    )
                    if requeued:
                        print(
                            f"[{job.id}] Abandoned before provider submission; "
                            "requeued for a new attempt"
                        )
                    else:
                        self._comfyui_manual_intervention_job_ids.add(job.id)
                        print(
                            f"[{job.id}] Requeue failed; requires manual intervention"
                        )
                    continue

                failed_persisted = await self.update_job_status(
                    job.id,
                    JobStatus.FAILED,
                    failure_type=FailureType.UNKNOWN,
                    task_status='failed',
                )
                if failed_persisted:
                    print(
                        f"[{job.id}] In-flight job has no provider task ID; "
                        "marked failed and will not be queued"
                    )
                else:
                    # 无法写回 failed 时先隔离，避免重启后又被误入执行队列。
                    self._comfyui_manual_intervention_job_ids.add(job.id)
                    print(
                        f"[{job.id}] In-flight job has no provider task ID; "
                        "failed status could not be persisted, requires manual "
                        "intervention and remains quarantined"
                    )

        return resumable

    async def update_job_status(
        self,
        job_id: str,
        status: JobStatus,
        *,
        attempt_id: Optional[str] = None,
        attempt_status: Optional[str] = None,
        attempt_model: Optional[str] = None,
        provider_task_id: Optional[str] = None,
        failure_type: Optional[FailureType] = None,
        failure_code: Optional[str] = None,
        failure_message: Optional[str] = None,
        actual_cost: Optional[float] = None,
        cost_status_value: Optional[str] = None,
        provider_usage: Optional[Dict[str, Any]] = None,
        pricing_version: Optional[str] = None,
        task_status: Optional[str] = None,
        video_url: Optional[str] = None,
        started_at: Optional[datetime] = None,
        submitted_at: Optional[datetime] = None,
        finished_at: Optional[datetime] = None,
    ):
        """更新 Backend 中的任务状态。"""
        payload = {"status": status.value}

        if task_status is not None:
            payload["taskStatus"] = task_status

        # 产物地址必须回写，否则 Task.video_url 永远为空。
        if video_url is not None:
            payload["videoUrl"] = video_url

        # 映射到 MVP 字段
        if actual_cost is not None:
            payload["cost"] = actual_cost

        # 完成或失败时，设置完成时间
        if status in [JobStatus.COMPLETED, JobStatus.FAILED]:
            payload["completedAt"] = datetime.now(timezone.utc).isoformat()

        if attempt_id:
            payload["attemptId"] = attempt_id

            if attempt_status:
                payload["attemptStatus"] = attempt_status
            elif status == JobStatus.SUBMITTED:
                payload["attemptStatus"] = "submitted"
            elif status == JobStatus.RUNNING:
                payload["attemptStatus"] = "running"
            elif status == JobStatus.COMPLETED:
                payload["attemptStatus"] = "completed"
            elif status == JobStatus.FAILED:
                payload["attemptStatus"] = "failed"

            if attempt_model is not None:
                payload["attemptModel"] = attempt_model

            if started_at is not None:
                payload["startedAt"] = started_at.isoformat()

            if submitted_at is not None:
                payload["submittedAt"] = submitted_at.isoformat()

            if finished_at is None and status in {
                JobStatus.COMPLETED,
                JobStatus.FAILED,
            }:
                finished_at = datetime.now(timezone.utc)

            if finished_at is not None:
                payload["finishedAt"] = finished_at.isoformat()

            if provider_task_id is not None:
                payload["providerTaskId"] = provider_task_id

            if provider_usage is not None:
                payload["providerUsage"] = provider_usage

            if cost_status_value is not None:
                payload["costStatus"] = _normalize_cost_status(cost_status_value)

            if pricing_version is not None:
                payload["pricingVersion"] = pricing_version

            if actual_cost is not None:
                payload["actualCostCny"] = actual_cost

            if failure_code is not None:
                payload["failureCode"] = failure_code

            if failure_message is not None:
                payload["failureMessage"] = failure_message

            if failure_type is not None:
                payload["failureType"] = failure_type.value

        try:
            worker_token = getattr(settings, "worker_service_token", "")
            update_url = (
                f"{self.backend_url}/api/v1/internal/attempts/tasks/{job_id}/status"
                if worker_token
                else f"{self.backend_url}/api/tasks/{job_id}"
            )
            response = await self.client.patch(
                update_url,
                json=payload,
                headers={"X-Worker-Token": worker_token} if worker_token else None,
            )
            response.raise_for_status()
            return True
        except Exception as e:
            print(f"Failed to update job {job_id}: {e}")
            return False

    async def resolve_asset_url(self, asset_id: str) -> str:
        token = getattr(settings, "worker_service_token", "")
        if not token:
            raise RuntimeError("WORKER_SERVICE_TOKEN is required to resolve an Asset")
        response = await self.client.get(
            f"{self.backend_url}/api/v1/internal/attempts/assets/{asset_id}/download",
            headers={"X-Worker-Token": token},
        )
        response.raise_for_status()
        return response.json()["downloadUrl"]

    async def create_asset(
        self,
        job_id: str,
        object_key: str,
        local_path: str,
        attempt_id: Optional[str] = None,
        file_type: str = "video",
    ) -> bool:
        """登记产物 Asset；失败只记录日志，不阻断任务完成。"""
        # asset size 是回放/成本核算和排障的关键信息，先算好文件体积。
        file_size = os.path.getsize(local_path)

        payload = {
            "taskId": job_id,
            "objectKey": object_key,
            "bucket": self.oss_uploader.bucket_name,
            "mediaType": file_type,
            "mimeType": "video/mp4" if file_type == "video" else None,
            "sizeBytes": file_size,
        }
        if attempt_id:
            payload["attemptId"] = attempt_id

        try:
            response = await self.client.post(
                f"{self.backend_url}/api/v1/internal/attempts/assets",
                json=payload,
                headers={"X-Worker-Token": getattr(settings, "worker_service_token", "")},
            )
            response.raise_for_status()
            return True
        except Exception as e:
            print(f"Failed to create asset for job {job_id}: {e}")
            return False

    async def execute_job(self, job: Job):
        """执行单个任务"""
        print(f"[{job.id}] Starting execution")

        if settings.comfyui_enabled is True:
            quarantined_ids = (
                getattr(self, "_comfyui_quarantined_job_ids", set())
                | getattr(self, "_comfyui_manual_intervention_job_ids", set())
            )
            if job.id in quarantined_ids:
                await self.update_job_status(
                    job.id,
                    JobStatus.FAILED,
                    failure_type=FailureType.UNKNOWN,
                )
                print(f"[{job.id}] ComfyUI job is quarantined after submission persistence failure")
                return

            # 开启 ComfyUI 时走本地 dry-run，不经过 provider 计费/重试链路。
            await self._execute_comfyui_job(job)
            return

        # 1. 根据 provider_profile 选择适配器
        provider = job.providerProfile.split("-")[0]  # seedance-main -> seedance
        adapter = self.adapters.get(provider)

        if not adapter:
            await self.update_job_status(
                job.id,
                JobStatus.FAILED,
                failure_type=FailureType.UNKNOWN,
                task_status='failed',
            )
            print(f"[{job.id}] Unknown provider: {provider}")
            return

        attempt_id = job.attemptId

        if job.status in {JobStatus.PENDING.value, JobStatus.SUBMITTED.value} and not attempt_id:
            # 没有 attempt 信息时，先保底失败避免重复计费。
            await self.update_job_status(
                job.id,
                JobStatus.FAILED,
                failure_type=FailureType.UNKNOWN,
                failure_code='MISSING_ATTEMPT',
                failure_message='No attempt_id present for job claim',
                task_status='requires_review',
            )
            print(f"[{job.id}] Missing attempt context, abort for safety")
            return

        try:
            uploaded_video_url: Optional[str] = None
            job_state = {
                "status": job.status,
                "provider_task_id": job.providerTaskId,
                "submitted_at": job.attemptSubmittedAt or job.submittedAt,
            }

            if should_resume_job(job_state):
                if is_stale_job(
                    job_state,
                    timeout_minutes=settings.running_job_timeout_minutes,
                ):
                    await self.update_job_status(
                        job.id,
                        JobStatus.FAILED,
                        attempt_id=attempt_id,
                        failure_type=FailureType.TIMEOUT,
                        task_status='failed',
                    )
                    print(f"[{job.id}] Timed out while recovering provider task")
                    return

                provider_task_id = job.providerTaskId
                print(f"[{job.id}] Resuming provider task: {provider_task_id}")
            else:
                provider_params = job.get_params()
                effective_model = str(
                    provider_params.get("model")
                    or getattr(adapter, "default_model", "")
                ).strip()

                if attempt_id:
                    # 先把 attempt 写成已提交，避免网络抖动时重复提交造成二次计费。
                    submitted_recorded = await self.update_job_status(
                        job.id,
                        JobStatus.SUBMITTED,
                        attempt_id=attempt_id,
                        attempt_status="submitted",
                        attempt_model=effective_model or None,
                        started_at=datetime.now(timezone.utc),
                    )

                    if not submitted_recorded:
                        await self.update_job_status(
                            job.id,
                            JobStatus.FAILED,
                            attempt_id=attempt_id,
                            attempt_status="requires_review",
                            failure_type=FailureType.UNKNOWN,
                            failure_code="REQUIRES_REVIEW",
                            failure_message="provider submission state could not be persisted",
                            task_status="requires_review",
                        )
                        return

                # 2. 无可恢复上下文时，创建新任务并持久化 provider 端 task id。
                asset_id = provider_params.get("image_asset_id")
                if asset_id:
                    provider_params["image_url"] = await self.resolve_asset_url(str(asset_id))
                result = await adapter.create_task(provider_params)
                provider_task_id = result["task_id"]

                persisted = await self.update_job_status(
                    job.id,
                    JobStatus.SUBMITTED,
                    attempt_id=attempt_id,
                    attempt_status="submitted",
                    provider_task_id=provider_task_id,
                    submitted_at=datetime.now(timezone.utc),
                )
                if not persisted:
                    await self.update_job_status(
                        job.id,
                        JobStatus.FAILED,
                        attempt_id=attempt_id,
                        attempt_status="requires_review",
                        failure_type=FailureType.UNKNOWN,
                        failure_code="PAYLOAD_TIMEOUT",
                        failure_message="provider accepted task but submission trace failed to persist",
                        task_status="requires_review",
                    )
                    return

                print(f"[{job.id}] Submitted to provider, task_id: {provider_task_id}")

                # 4. 更新状态为 running
                await self.update_job_status(
                    job.id,
                    JobStatus.RUNNING,
                    attempt_id=attempt_id,
                    attempt_status="running",
                )

            # 5. 轮询直到完成
            task_status = await adapter.poll_until_complete(
                provider_task_id,
                interval=settings.task_status_check_interval,
            )
            print(f"[{job.id}] Task completed: {task_status.result_url}")

            # 6. 下载视频
            if task_status.result_url:
                # 使用秒级时间戳命名，降低并发下文件名冲突风险。
                timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
                filename = f"{job.capability.lower()}-{timestamp}.mp4"
                local_path = self.output_dir / filename

                await adapter.download_video(task_status.result_url, str(local_path))
                print(f"[{job.id}] Downloaded to: {local_path}")

                # 7. 上传到 OSS
                object_key = f"videos/{datetime.now().strftime('%Y/%m/%d')}/{filename}"
                oss_url = self.oss_uploader.upload(str(local_path), object_key)
                uploaded_video_url = oss_url
                print(f"[{job.id}] Uploaded to OSS: {oss_url}")

                # 8. 创建 Asset 记录（用 objectKey，不用会过期的签名 URL）
                await self.create_asset(
                    job.id,
                    object_key,
                    str(local_path),
                    attempt_id=attempt_id,
                    file_type="video",
                )

            # 9. 只有 Provider 返回 usage 且确认可计费时，才输出实际费用；否则标记 unavailable。
            actual_cost = (
                adapter.calculate_actual_cost(task_status.usage)
                if cost_status(task_status.usage) == "confirmed"
                else None
            )
            cost_audit = build_cost_audit(
                task_status.usage,
                actual_cost,
                adapter.pricing_version,
            )

            await self.update_job_status(
                job.id,
                JobStatus.COMPLETED,
                attempt_id=attempt_id,
                attempt_status="completed",
                actual_cost=cost_audit["actual_cost"],
                cost_status_value=cost_audit["cost_status"],
                provider_usage=cost_audit["provider_usage"],
                pricing_version=cost_audit["pricing_version"],
                video_url=uploaded_video_url,
                task_status="completed",
                finished_at=datetime.now(timezone.utc),
            )
            print(
                f"[{job.id}] Completed successfully "
                f"(cost: {format_cost(cost_audit['actual_cost'])}, "
                f"status: {cost_audit['cost_status']})"
            )

        except Exception as e:
            error_msg = str(e)
            failure_type = adapter.classify_failure(error_msg)

            if isinstance(e, ProviderSubmissionUncertainError):
                await self.update_job_status(
                    job.id,
                    JobStatus.FAILED,
                    attempt_id=attempt_id,
                    attempt_status="requires_review",
                    failure_type=FailureType.UNKNOWN,
                    failure_code="SUBMISSION_UNCERTAIN",
                    failure_message=error_msg,
                    task_status="requires_review",
                )
                print(f"[{job.id}] Provider submission outcome is uncertain; manual review required")
                return

            # 自动重试已移除：当前 Backend 与 schema 都没有 retry_count /
            # next_retry_at 字段，原实现发送的 snake_case 载荷会被 Prisma 拒绝，
            # 重试请求实际全部 500。在补齐可持久化的重试计数前，统一落 failed，
            # 避免"看似重试、实际永久失败"的误导状态。
            retryable_failures = [
                FailureType.RATE_LIMIT,
                FailureType.NETWORK_ERROR,
                FailureType.TIMEOUT,
            ]

            await self.update_job_status(
                job.id,
                JobStatus.FAILED,
                attempt_id=attempt_id,
                attempt_status="failed",
                failure_type=failure_type,
                failure_code=(
                    "RETRY_NOT_PERSISTED"
                    if failure_type in retryable_failures
                    else "UNRETRYABLE_FAILURE"
                ),
                failure_message=error_msg,
                task_status='failed',
            )
            print(f"[{job.id}] Failed: {error_msg} (type: {failure_type})")

    async def _execute_comfyui_job(self, job: Job):
        """Execute the explicitly enabled local ComfyUI dry-run path.

        This path intentionally does not enter the direct Ark retry/upload
        flow. ComfyUI prompt IDs are local execution IDs, not Ark task IDs.
        """
        # ComfyUI 的 prompt_id 语义是本地执行上下文，不能和 Ark 的 provider_task_id 混淆。
        if self.comfyui_executor is None:
            await self.update_job_status(
                job.id,
                JobStatus.FAILED,
                failure_type=FailureType.UNKNOWN,
            )
            print(f"[{job.id}] ComfyUI path is enabled but not initialized")
            return

        try:
            result: ComfyUIExecutionResult = await self.comfyui_executor.execute(job)
            if result.status == "completed":
                await self.update_job_status(
                    job.id,
                    JobStatus.COMPLETED,
                    attempt_id=job.attemptId,
                    provider_task_id=result.prompt_id,
                    actual_cost=result.actual_cost,
                    cost_status_value=result.cost_status,
                    provider_usage=result.provider_usage,
                    pricing_version=result.pricing_version,
                    task_status="completed",
                )
                print(
                    f"[{job.id}] ComfyUI dry-run completed "
                    f"(prompt_id: {result.prompt_id}, cost: unavailable)"
                )
                return

            await self.update_job_status(
                job.id,
                JobStatus.FAILED,
                attempt_id=job.attemptId,
                provider_task_id=result.prompt_id,
                failure_type=FailureType.UNKNOWN,
                cost_status_value=result.cost_status,
            )
            print(f"[{job.id}] ComfyUI dry-run failed: {result.error or 'unknown error'}")
        except Exception as error:
            await self.update_job_status(
                job.id,
                JobStatus.FAILED,
                attempt_id=job.attemptId,
                failure_type=FailureType.UNKNOWN,
                cost_status_value="unavailable",
            )
            print(f"[{job.id}] ComfyUI dry-run failed: {error}")

    async def _record_comfyui_submission(self, job: Job, prompt_id: str):
        """Persist a local prompt ID before polling so recovery cannot requeue."""
        # 先写入数据库再开始轮询，确保进程重启后有稳定恢复锚点。
        persisted = await self.update_job_status(
            job.id,
            JobStatus.SUBMITTED,
            attempt_id=job.attemptId,
            attempt_status="submitted",
            provider_task_id=prompt_id,
        )
        if not persisted:
            self._comfyui_quarantined_job_ids.add(job.id)
            raise ComfyUIExecutionError(
                "ComfyUI prompt was accepted but submission state could not be persisted"
            )

    async def poll_loop(self):
        """主轮询循环"""
        import sys
        sys.stdout.flush()
        print(f"🚀 Worker poll_loop started, polling every {settings.job_poll_interval}s")
        sys.stdout.flush()

        while True:
            try:
                # 先处理 in-flight 恢复任务，再 claim 新任务。顺序反了会把本轮
                # 刚 claim、尚未生成 provider_task_id 的任务误判成"在途异常任务"。
                jobs = await self.fetch_inflight_jobs()
                jobs.extend(await self.fetch_pending_jobs())

                # 同一 task 可能同时来自两个来源，按 id 去重，避免并发重复提交。
                unique_jobs = list({job.id: job for job in jobs}.values())

                if unique_jobs:
                    print(f"Found {len(unique_jobs)} jobs to execute")
                    # 使用 gather 并发执行，单任务失败不应阻塞队列中的其他任务。
                    await asyncio.gather(*[self.execute_job(job) for job in unique_jobs])

                await asyncio.sleep(settings.job_poll_interval)

            except Exception as e:
                print(f"Poll loop error: {e}")
                await asyncio.sleep(settings.job_poll_interval)

    async def close(self):
        await self.client.aclose()
        for adapter in self.adapters.values():
            await adapter.close()
        if self.comfyui_client is not None:
            await self.comfyui_client.close()
