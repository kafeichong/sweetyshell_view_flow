from typing import Any, BinaryIO
import hashlib
import json
import os
import re
import secrets
import time
from pathlib import Path
from urllib.parse import quote
import httpx

try:
    from .config import VideoFlowConfig
    from .receipts import ReceiptStore, credential_namespace
except ImportError:  # ComfyUI loads custom node modules directly from the folder.
    from config import VideoFlowConfig
    from receipts import ReceiptStore, credential_namespace


class ArtifactDownloadError(RuntimeError):
    """产物下载失败：空文件或与声明大小不符。"""

    def __init__(self, task_id: str, code: str, message: str):
        super().__init__(f"[{code}] task {task_id}: {message}")
        self.task_id = task_id
        self.code = code


class TaskWaitError(RuntimeError):
    """等待任务时遇到的终态或不可继续的错误。

    一定带上 taskId 与可分类的 code：用户需要拿 taskId 去查、去核对、去人工恢复，
    而不是重新提交一次付费任务。
    """

    def __init__(self, task_id: str, code: str, message: str):
        super().__init__(f"[{code}] task {task_id}: {message}")
        self.task_id = task_id
        self.code = code


class TaskWaitTimeout(TaskWaitError):
    def __init__(self, task_id: str, timeout_seconds: float):
        super().__init__(
            task_id,
            "WAIT_TIMEOUT",
            f"still not delivered after {timeout_seconds:g}s; "
            "the task is still tracked, query it again instead of resubmitting",
        )
        self.timeout_seconds = timeout_seconds


class TaskRequiresReview(TaskWaitError):
    def __init__(self, task_id: str, message: str):
        super().__init__(task_id, "REQUIRES_REVIEW", message)


# 平台侧拒绝的原因码 → 可操作的中文说明。识别不出来也要把原文带出来（里面有 request id），
# 不猜、不吞。命中这里的两条都是**不可重试**的：同一份素材再提交多少次都一样。
PROVIDER_FAILURE_HINTS = {
    "InputVideoSensitiveContentDetected": (
        "输入视频被平台判定可能含真人：官方不支持直接上传含真人人脸的参考图/视频。"
        "换一段不含真人的素材再试——重试同一段不会成功。"
    ),
    "InputImageSensitiveContentDetected": (
        "输入图片被平台判定可能含真人：官方不支持直接上传含真人人脸的参考图/视频。"
        "换一张不含真人的素材再试——重试同一张不会成功。"
    ),
}


def provider_failure_message(summary: dict[str, Any]) -> str:
    """把 Provider 的失败原因拼成用户看得懂、能照着做的一句话。

    细节在 attempt 上（`failureCode` / `failureMessage`），而 `task.errorMsg` 可能是空的：
    只读 errorMsg 会退化成"provider reported a failure"——用户既不知道原因，也不知道该不该重试。
    """
    attempt = (summary.get("executionAttempts") or [{}])[0]
    detail = str(summary.get("errorMsg") or attempt.get("failureMessage") or "")
    code = attempt.get("failureCode")
    hint = next((text for key, text in PROVIDER_FAILURE_HINTS.items() if key in detail), "")
    parts = [hint]
    if code:
        parts.append(f"失败码 {code}。")
    if detail:
        parts.append(f"平台原始信息：{detail[:400]}")
    return "".join(parts) or "provider reported a failure"


class TaskProviderFailed(TaskWaitError):
    def __init__(self, task_id: str, message: str):
        super().__init__(task_id, "PROVIDER_FAILED", message)


class TaskDeliveryFailed(TaskWaitError):
    def __init__(self, task_id: str, error_code: str):
        super().__init__(
            task_id,
            "DELIVERY_FAILED",
            f"generation succeeded but the artifact could not be delivered ({error_code})",
        )
        self.error_code = error_code


class TaskCredentialsRejected(TaskWaitError):
    def __init__(self, task_id: str, status_code: int):
        super().__init__(
            task_id,
            "CREDENTIALS_REJECTED",
            f"backend rejected the credential (HTTP {status_code}); check VIDEO_FLOW_TOKEN",
        )
        self.status_code = status_code


class TaskNotFound(TaskWaitError):
    def __init__(self, task_id: str):
        super().__init__(
            task_id,
            "TASK_NOT_FOUND",
            "task does not exist or does not belong to this credential",
        )


class ReceiptUpdateError(RuntimeError):
    """任务已经创建，但回执补写失败。

    这种情况必须把 taskId 明确带给用户：把它报成"没提交成功"会诱导重跑，
    而重跑意味着第二次付费生成。
    """

    def __init__(self, task_id: str, cause: Exception):
        super().__init__(
            f"task {task_id} was created but its receipt could not be saved: {cause}. "
            "Do not resubmit with a new version; reuse this task id."
        )
        self.task_id = task_id
        self.cause = cause


class VideoFlowClient:
    def __init__(self, config: VideoFlowConfig, client: httpx.Client | None = None):
        self.config = config
        self.client = client or httpx.Client(timeout=60.0)

    def _headers(self, idempotency_key: str | None = None) -> dict[str, str]:
        headers = {
            "Authorization": f"Bearer {self.config.token}",
            "X-Video-Flow-Protocol": self.config.protocol_version,
        }
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        return headers

    def create_upload_ticket(
        self,
        *,
        filename: str,
        mime_type: str,
        size_bytes: int,
        sha256: str | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "filename": filename,
            "mimeType": mime_type,
            "sizeBytes": size_bytes,
        }
        # 带上内容哈希，服务端据此复用同内容的 Asset，使 asset_id 稳定，
        # 幂等键才能真正命中同一条任务而不是报 409。
        if sha256:
            body["sha256"] = sha256

        response = self.client.post(
            f"{self.config.backend_url}/api/v1/assets/upload-ticket",
            headers=self._headers(),
            json=body,
        )
        response.raise_for_status()
        return response.json()

    def upload_media(self, media: bytes | BinaryIO, *, filename: str, mime_type: str) -> dict[str, Any]:
        data = media if isinstance(media, bytes) else media.read()
        digest = hashlib.sha256(data).hexdigest()
        ticket = self.create_upload_ticket(
            filename=filename,
            mime_type=mime_type,
            size_bytes=len(data),
            sha256=digest,
        )
        if ticket.get("alreadyUploaded") is True:
            if ticket.get("requiresInspection") is True:
                return self.complete_upload(ticket["assetId"])
            return ticket
        response = self.client.put(ticket["uploadUrl"], headers=ticket.get("uploadHeaders", {}), content=data)
        response.raise_for_status()
        return self.complete_upload(ticket["assetId"])

    def complete_upload(self, asset_id: str) -> dict[str, Any]:
        response = self.client.post(
            f"{self.config.backend_url}/api/v1/assets/{asset_id}/complete",
            headers=self._headers(),
        )
        response.raise_for_status()
        return response.json()

    def create_task(
        self,
        *,
        idempotency_key: str,
        payload: dict[str, Any],
        mode: str = "preview",
    ) -> dict[str, Any]:
        """创建任务。

        mode 默认 preview：调用方必须显式传 production 才会请求付费执行，
        而且服务端还会再按 actor 白名单校验一次。
        """
        if mode not in ("preview", "production"):
            raise ValueError(f"unsupported mode: {mode!r}")

        scoped_idempotency_key = self.mode_scoped_idempotency_key(
            idempotency_key,
            mode,
        )
        return self._post_task(scoped_idempotency_key, {**payload, "mode": mode})

    def create_task_with_receipt(
        self,
        *,
        intent_key: str,
        idempotency_key: str,
        payload: dict[str, Any],
        mode: str = "preview",
        receipt_store: ReceiptStore,
    ) -> dict[str, Any]:
        """Create a task while preserving the exact retry intent on disk.

        重试语义：一旦某个 intent_key 形成了意图，后续重跑一律沿用回执里的
        原 key 与原请求体。软件升级后重建的 payload 可能多出或少掉几个字段
        （设备别名、版本等），如果拿它去重试，就会变成"同 key 不同请求"被
        服务端判 409，或者被误当成一次新的生成。
        """
        existing = receipt_store.load(intent_key)
        if existing and existing.get("taskId"):
            return self.get_task(str(existing["taskId"]))

        if existing:
            scoped_key = str(existing["idempotencyKey"])
            request_body = dict(existing["body"])
        else:
            scoped_key = self.mode_scoped_idempotency_key(idempotency_key, mode)
            request_body = {**payload, "mode": mode}
            # 先落盘意图，再发 POST：回执写不进去就不允许创建付费任务，
            # 否则一次超时就再也没有"当初到底提交了什么"的凭据。
            receipt_store.save(
                intent_key,
                {
                    **(existing or {}),
                    "idempotencyKey": scoped_key,
                    "mode": mode,
                    "body": request_body,
                    "taskId": None,
                },
            )

        result = self._post_task(scoped_key, request_body)
        task_id = result.get("id")

        try:
            latest = receipt_store.load(intent_key) or existing or {}
            receipt_store.save(
                intent_key,
                {
                    **latest,
                    "idempotencyKey": scoped_key,
                    "mode": request_body.get("mode", mode),
                    "body": request_body,
                    "taskId": task_id,
                },
            )
        except Exception as error:
            raise ReceiptUpdateError(str(task_id), error) from error

        return result

    def _post_task(self, scoped_idempotency_key: str, request_body: dict[str, Any]) -> dict[str, Any]:
        """按给定的 scoped key 与请求体创建任务，不做任何重写。"""
        response = self.client.post(
            f"{self.config.backend_url}/api/v1/tasks",
            headers=self._headers(scoped_idempotency_key),
            json=request_body,
        )
        response.raise_for_status()
        return response.json()

    def receipt_namespace(self) -> str:
        """当前后端地址与凭证对应的回执命名空间。"""
        return credential_namespace(self.config.backend_url, self.config.token)

    def receipt_store(self, root: str | Path) -> ReceiptStore:
        return ReceiptStore(root, namespace=self.receipt_namespace())

    # 查询失败时的退避上限：轮询可以等，但不允许把等待变成无限次重击后端。
    MAX_POLL_BACKOFF_SECONDS = 60.0

    def wait_for_task(
        self,
        task_id: str,
        *,
        timeout_seconds: float = 1200,
        poll_seconds: float = 5,
    ) -> dict[str, Any]:
        """阻塞等待任务交付就绪。

        成功条件是 delivery.status == ready——不是 Provider succeeded：
        生成成功但归档失败时，用户拿不到片，必须报错而不是当成功。
        查询失败（429/5xx/网络）只重查，绝不重建任务；401/403 立即停止并提示
        凭证问题；等不到就抛 TaskWaitTimeout，任务本身仍在服务端被跟踪。
        """
        deadline = time.monotonic() + max(0.0, float(timeout_seconds))
        transient_failures = 0

        while True:
            summary: dict[str, Any] | None = None
            try:
                summary = self.get_task(task_id)
            except httpx.HTTPStatusError as error:
                status_code = error.response.status_code
                if status_code in (401, 403):
                    raise TaskCredentialsRejected(task_id, status_code) from error
                if status_code == 404:
                    raise TaskNotFound(task_id) from error
                if status_code != 429 and status_code < 500:
                    raise
                transient_failures += 1
            except httpx.RequestError:
                # 网络抖动：任务可能一切正常，下一轮再查。
                transient_failures += 1
            else:
                transient_failures = 0
                terminal = self._terminal_wait_state(task_id, summary)
                if terminal is not None:
                    return terminal

            delay = min(
                max(0.0, float(poll_seconds)) * (2 ** min(transient_failures, 4)),
                self.MAX_POLL_BACKOFF_SECONDS,
            )
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TaskWaitTimeout(task_id, timeout_seconds)
            time.sleep(min(delay, remaining))

    def _terminal_wait_state(
        self,
        task_id: str,
        summary: dict[str, Any],
    ) -> dict[str, Any] | None:
        """就绪返回任务摘要；终态错误抛出；仍在进行返回 None。"""
        delivery = summary.get("delivery") or {}
        delivery_status = delivery.get("status")
        task_status = summary.get("taskStatus") or summary.get("status")

        if delivery_status == "ready":
            return summary

        if delivery_status == "failed":
            raise TaskDeliveryFailed(
                task_id,
                str(delivery.get("errorCode") or "UNKNOWN_DELIVERY_ERROR"),
            )

        if task_status == "requires_review":
            raise TaskRequiresReview(
                task_id,
                "provider submission needs manual verification",
            )

        if task_status == "failed":
            raise TaskProviderFailed(task_id, provider_failure_message(summary))

        return None

    def cost_is_unverified(self, summary: dict[str, Any]) -> bool:
        """费用是否仍未核实。

        usage 缺失时 Backend 会保留预占等人工核查；此时产物仍然可用，
        只是费用待核实，不能因为费用不确定就把已经生成的片扣住不给。
        """
        cost = summary.get("costSummary") or {}
        return (cost.get("status") or "unavailable") not in {
            "usage_calculated",
            "billed",
        }

    def cost_note(self, summary: dict[str, Any]) -> str:
        cost = summary.get("costSummary") or {}
        if self.cost_is_unverified(summary):
            return "费用待核实（Provider 未返回可核对的 usage，已保留预占待人工核查）"
        amount = cost.get("billedCny") or cost.get("usageCalculatedCny") or cost.get("settledCny")
        return f"费用已确认：{amount} CNY（{cost.get('status')}）"

    def get_task(self, task_id: str) -> dict[str, Any]:
        response = self.client.get(
            f"{self.config.backend_url}/api/v1/tasks/{task_id}",
            headers=self._headers(),
        )
        response.raise_for_status()
        return response.json()

    def preflight(self, intent: dict[str, Any]) -> dict[str, Any]:
        """提交预检：不建任务、不预占、不上传素材。"""
        response = self.client.post(
            f"{self.config.backend_url}/api/v1/tasks/preflight",
            headers=self._headers(),
            json=intent,
        )
        response.raise_for_status()
        return response.json()

    def check_preflight(self, preflight_id: str) -> dict[str, Any]:
        """复验已有预检，并返回当下的新任务准入。"""
        response = self.client.get(
            f"{self.config.backend_url}/api/v1/tasks/preflight/{preflight_id}/check",
            headers=self._headers(),
        )
        response.raise_for_status()
        return response.json()

    def get_current_task_for_slot(self, execution_slot_id: str) -> dict[str, Any]:
        encoded_slot_id = quote(execution_slot_id, safe="")
        response = self.client.get(
            f"{self.config.backend_url}/api/v1/tasks/slots/{encoded_slot_id}/current",
            headers=self._headers(),
        )
        response.raise_for_status()
        return response.json()

    def confirm_client_delivery(self, task_id: str) -> dict[str, Any]:
        encoded_task_id = quote(task_id, safe="")
        response = self.client.post(
            f"{self.config.backend_url}/api/v1/tasks/{encoded_task_id}/client-delivery",
            headers=self._headers(),
        )
        response.raise_for_status()
        return response.json()

    def get_download_url(self, asset_id: str) -> str:
        response = self.client.get(
            f"{self.config.backend_url}/api/v1/assets/{asset_id}/download",
            headers=self._headers(),
        )
        response.raise_for_status()
        return response.json()["downloadUrl"]

    def get_task_result(self, task_id: str) -> dict[str, Any]:
        response = self.client.get(
            f"{self.config.backend_url}/api/v1/assets/tasks/{task_id}/result",
            headers=self._headers(),
        )
        response.raise_for_status()
        return response.json()

    def download_task_result(
        self,
        task_id: str,
        output_dir: str | Path,
    ) -> dict[str, Any]:
        result = self.get_task_result(task_id)
        output_root = Path(output_dir).expanduser()
        output_root.mkdir(parents=True, exist_ok=True)

        source_name = Path(str(result.get("objectKey") or "result.mp4")).name
        safe_task_id = re.sub(r"[^a-zA-Z0-9._-]", "_", task_id)
        safe_name = re.sub(r"[^a-zA-Z0-9._-]", "_", source_name) or "result.mp4"
        destination = output_root / f"{safe_task_id}-{safe_name}"
        # 随机临时名：并发或重跑各写各的占位文件，失败时只清理本次的。
        temporary = output_root / (
            f".{destination.name}.{os.getpid()}.{secrets.token_hex(4)}.part"
        )

        declared_size = result.get("sizeBytes")
        digest = hashlib.sha256()
        written = 0

        download_url = result.get("downloadUrl")
        if not download_url:
            raise ArtifactDownloadError(
                task_id,
                "MISSING_DOWNLOAD_URL",
                "backend did not return a download url for this artifact",
            )

        # OSS 签名 URL 是独立下载地址，不携带 Video Flow actor token。
        try:
            with self.client.stream("GET", str(download_url)) as response:
                response.raise_for_status()
                with temporary.open("wb") as output:
                    for chunk in response.iter_bytes():
                        output.write(chunk)
                        digest.update(chunk)
                        written += len(chunk)
                    output.flush()
                    os.fsync(output.fileno())

            if written <= 0:
                raise ArtifactDownloadError(
                    task_id, "EMPTY_ARTIFACT", "downloaded artifact has no bytes"
                )
            if declared_size is not None and int(declared_size) != written:
                raise ArtifactDownloadError(
                    task_id,
                    "ARTIFACT_SIZE_MISMATCH",
                    f"downloaded {written} bytes but the asset declares {declared_size}",
                )

            # 校验通过才原子发布：失败时上一份成功的文件保持不变。
            temporary.replace(destination)
        finally:
            if temporary.exists():
                temporary.unlink()

        # 产物接口只有文件信息，费用与交付状态在任务摘要里。取摘要失败不能
        # 影响已经下载成功的文件，最多让费用显示退回"待核实"。
        try:
            summary = self.get_task(task_id)
        except Exception:
            summary = {}

        # 回执只留产物身份与校验信息，不带下载签名 URL——签名几小时后失效，
        # 把它当成产物标识存下来，日后必然指向一个打不开的地址。
        return {
            "taskId": task_id,
            "assetId": result.get("assetId"),
            "objectKey": result.get("objectKey"),
            "mimeType": result.get("mimeType"),
            "sizeBytes": written,
            "sha256": digest.hexdigest(),
            "localPath": str(destination),
            "delivery": summary.get("delivery"),
            "costSummary": summary.get("costSummary"),
        }

    @staticmethod
    def stable_idempotency_key(
        prompt: str,
        image_bytes: bytes = b"",
        *,
        profile: str = "seedance",
        workflow_key: str | None = None,
        duration: int | None = None,
        ratio: str | None = None,
        resolution: str | None = None,
        generation_version: int = 1,
        spec_version: str = "",
    ) -> str:
        generation = json.dumps(
            {
                "duration": duration,
                "profile": profile,
                "workflow_key": workflow_key,
                "ratio": ratio,
                "resolution": resolution,
                "generation_version": generation_version,
                "spec_version": spec_version,
            },
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode()
        return hashlib.sha256(
            generation + b"\0" + prompt.encode() + b"\0" + image_bytes
        ).hexdigest()

    @staticmethod
    def mode_scoped_idempotency_key(idempotency_key: str, mode: str) -> str:
        """将调用方的稳定基准键限定到执行模式，避免 Preview/Production 冲突。"""
        return hashlib.sha256(
            mode.encode() + b"\0" + idempotency_key.encode()
        ).hexdigest()
