import httpx
import asyncio
import os
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional, Dict, Any
from config import get_settings
from models import Job, JobStatus, FailureType
from providers.seedance_adapter import SeedanceAdapter
from oss_uploader import OssUploader
from recovery import build_cost_audit, cost_status, format_cost, is_stale_job, should_resume_job
from comfyui_client import ComfyUIClient
from comfyui_executor import (
    ComfyUIExecutionError,
    ComfyUIDryRunExecutor,
    ComfyUIExecutionResult,
)

settings = get_settings()


class JobExecutor:
    """任务执行器 - 负责从 Backend 拉取任务并执行"""

    def __init__(self):
        # 缓存配置实例，减少重复解析环境变量带来的重复开销。
        self.backend_url = settings.backend_url
        # 重用异步 HTTP client，降低轮询任务执行时的连接建立成本。
        self.client = httpx.AsyncClient(timeout=30.0)
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

    async def fetch_pending_jobs(self) -> list[Job]:
        """从 Backend 拉取 pending 状态的任务"""
        try:
            response = await self.client.get(
                f"{self.backend_url}/api/tasks",
                params={"status": "pending", "limit": 10}
            )
            response.raise_for_status()
            data = response.json()

            # Backend 直接返回数组，不是 {"jobs": [...]} 格式
            if isinstance(data, list):
                return [Job(**job) for job in data]
            # 兼容旧格式
            return [Job(**job) for job in data.get("jobs", [])]
        except Exception as e:
            print(f"Failed to fetch jobs: {e}")
            return []

    async def fetch_inflight_jobs(self) -> list[Job]:
        """Fetch submitted/running jobs so polling survives worker restarts."""
        jobs: list[Job] = []
        for status in (JobStatus.SUBMITTED.value, JobStatus.RUNNING.value):
            try:
                response = await self.client.get(
                    f"{self.backend_url}/api/tasks",
                    params={"status": status, "limit": 10},
                )
                response.raise_for_status()
                data = response.json()
                # Backend 直接返回数组
                if isinstance(data, list):
                    jobs.extend(Job(**job) for job in data)
                else:
                    # 兼容旧格式
                    jobs.extend(Job(**job) for job in data.get("jobs", []))
            except Exception as e:
                print(f"Failed to fetch {status} jobs: {e}")
        resumable: list[Job] = []
        for job in jobs:
            job_state = {
                "status": job.status,
                "provider_task_id": job.providerTaskId,
            }
            # 只有有提交 ID 的 running/submitted 任务才可安全恢复；否则标记失败并隔离。
            if should_resume_job(job_state):
                resumable.append(job)
                continue

            if job.status in {JobStatus.SUBMITTED.value, JobStatus.RUNNING.value}:
                failed_persisted = await self.update_job_status(
                    job.id,
                    JobStatus.FAILED,
                    failure_type=FailureType.UNKNOWN,
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
        provider_task_id: Optional[str] = None,
        failure_type: Optional[FailureType] = None,
        actual_cost: Optional[float] = None,
        cost_status_value: Optional[str] = None,
        provider_usage: Optional[Dict[str, Any]] = None,
        pricing_version: Optional[str] = None,
        result: Optional[Dict[str, Any]] = None
    ):
        """更新 Backend 中的任务状态 - 适配 MVP Task 表"""
        # MVP Task 表只支持：status, videoUrl, errorMsg, cost, completedAt
        payload = {"status": status.value}

        # 映射到 MVP 字段
        if actual_cost is not None:
            payload["cost"] = actual_cost

        # 如果有结果 URL，映射到 videoUrl
        if result and result.get("video_url"):
            payload["videoUrl"] = result["video_url"]

        # 失败时，设置错误信息
        if failure_type and status == JobStatus.FAILED:
            payload["errorMsg"] = f"{failure_type.value}: task failed"

        # 完成或失败时，设置完成时间
        if status in [JobStatus.COMPLETED, JobStatus.FAILED]:
            payload["completedAt"] = datetime.utcnow().isoformat()

        try:
            response = await self.client.patch(
                f"{self.backend_url}/api/tasks/{job_id}",
                json=payload
            )
            response.raise_for_status()
            return True
        except Exception as e:
            print(f"Failed to update job {job_id}: {e}")
            return False

    async def create_asset(
        self,
        job_id: str,
        file_path: str,
        local_path: str,
        file_type: str = "video"
    ):
        """创建 Asset 记录"""
        # asset size 是回放/成本核算和排障的关键信息，先算好文件体积。
        file_size = os.path.getsize(local_path)

        payload = {
            "job_id": job_id,
            "file_path": file_path,
            "local_path": local_path,
            "file_size_bytes": file_size,
            "file_type": file_type
        }

        try:
            response = await self.client.post(
                f"{self.backend_url}/api/assets",
                json=payload
            )
            response.raise_for_status()
        except Exception as e:
            print(f"Failed to create asset for job {job_id}: {e}")

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
            )
            print(f"[{job.id}] Unknown provider: {provider}")
            return

        try:
            job_state = {
                "status": job.status,
                "provider_task_id": job.providerTaskId,
                "submitted_at": job.submittedAt,
            }
            if should_resume_job(job_state):
                if is_stale_job(
                    job_state,
                    timeout_minutes=settings.running_job_timeout_minutes,
                ):
                    await self.update_job_status(
                        job.id,
                        JobStatus.FAILED,
                        failure_type=FailureType.TIMEOUT,
                    )
                    print(f"[{job.id}] Timed out while recovering provider task")
                    return
                provider_task_id = job.providerTaskId
                print(f"[{job.id}] Resuming provider task: {provider_task_id}")
            else:
                # 2. 无可恢复上下文时，创建新任务并持久化 provider 端 task id。
                result = await adapter.create_task(job.params)
                provider_task_id = result["task_id"]

                # 3. 更新状态为 submitted
                await self.update_job_status(
                    job.id,
                    JobStatus.SUBMITTED,
                    provider_task_id=provider_task_id
                )
                print(f"[{job.id}] Submitted to provider, task_id: {provider_task_id}")

                # 4. 更新状态为 running
                await self.update_job_status(job.id, JobStatus.RUNNING)

            # 5. 轮询直到完成
            task_status = await adapter.poll_until_complete(
                provider_task_id,
                interval=settings.task_status_check_interval
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
                print(f"[{job.id}] Uploaded to OSS: {oss_url}")

                # 8. 创建 Asset 记录
                await self.create_asset(
                    job.id,
                    oss_url,  # file_path: OSS 公网访问 URL
                    str(local_path),  # local_path: 本地下载路径
                    file_type="video"
                )

            # 8. 只有 Provider 返回 usage 且确认可计费时，才输出实际费用；否则标记 unavailable。
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
                actual_cost=cost_audit["actual_cost"],
                cost_status_value=cost_audit["cost_status"],
                provider_usage=cost_audit["provider_usage"],
                pricing_version=cost_audit["pricing_version"],
            )
            print(
                f"[{job.id}] Completed successfully "
                f"(cost: {format_cost(cost_audit['actual_cost'])}, "
                f"status: {cost_audit['cost_status']})"
            )

        except Exception as e:
            error_msg = str(e)
            failure_type = adapter.classify_failure(error_msg)

            # 判断是否可重试
            retryable_failures = [
                FailureType.RATE_LIMIT,
                FailureType.NETWORK_ERROR,
                FailureType.TIMEOUT
            ]

            if failure_type in retryable_failures and job.retryCount < job.maxRetries:
                # 可重试：指数退避（2^(retryCount+1) 分钟）减少雪崩风险。
                retry_delay_minutes = 2 ** (job.retryCount + 1)
                next_retry_at = datetime.utcnow() + timedelta(minutes=retry_delay_minutes)

                # 回写 pending + retry 次数 + next_retry_at，由轮询器重新拾取。
                payload = {
                    "status": JobStatus.PENDING.value,
                    "failure_type": failure_type.value,
                    "retry_count": job.retryCount + 1,
                    "next_retry_at": next_retry_at.isoformat()
                }

                try:
                    response = await self.client.patch(
                        f"{self.backend_url}/api/tasks/{job.id}",
                        json=payload
                    )
                    response.raise_for_status()
                    print(f"[{job.id}] Scheduled retry #{job.retryCount + 1} at {next_retry_at} (delay: {retry_delay_minutes}min, reason: {failure_type.value})")
                except Exception as update_error:
                    print(f"Failed to schedule retry for job {job.id}: {update_error}")
            else:
                # 不可重试或已达最大重试次数：标记为 failed
                await self.update_job_status(
                    job.id,
                    JobStatus.FAILED,
                    failure_type=failure_type
                )
                reason = "max retries exceeded" if job.retryCount >= job.maxRetries else "non-retryable failure"
                print(f"[{job.id}] Failed: {error_msg} (type: {failure_type}, reason: {reason})")

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
                    provider_task_id=result.prompt_id,
                    actual_cost=result.actual_cost,
                    cost_status_value=result.cost_status,
                    provider_usage=result.provider_usage,
                    pricing_version=result.pricing_version,
                )
                print(
                    f"[{job.id}] ComfyUI dry-run completed "
                    f"(prompt_id: {result.prompt_id}, cost: unavailable)"
                )
                return

            await self.update_job_status(
                job.id,
                JobStatus.FAILED,
                provider_task_id=result.prompt_id,
                failure_type=FailureType.UNKNOWN,
                cost_status_value=result.cost_status,
            )
            print(f"[{job.id}] ComfyUI dry-run failed: {result.error or 'unknown error'}")
        except Exception as error:
            await self.update_job_status(
                job.id,
                JobStatus.FAILED,
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
                jobs = await self.fetch_pending_jobs()
                jobs.extend(await self.fetch_inflight_jobs())

                if jobs:
                    print(f"Found {len(jobs)} pending jobs")
                    # 使用 gather 并发执行，单任务失败不应阻塞队列中的其他任务。
                    await asyncio.gather(*[self.execute_job(job) for job in jobs])

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
