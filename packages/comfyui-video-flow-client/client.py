from typing import Any, BinaryIO
import hashlib
import json
import re
from pathlib import Path
import httpx

try:
    from .config import VideoFlowConfig
    from .receipts import ReceiptStore, credential_namespace
except ImportError:  # ComfyUI loads custom node modules directly from the folder.
    from config import VideoFlowConfig
    from receipts import ReceiptStore, credential_namespace


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
                    "idempotencyKey": scoped_key,
                    "mode": mode,
                    "body": request_body,
                    "taskId": None,
                },
            )

        result = self._post_task(scoped_key, request_body)
        task_id = result.get("id")

        try:
            receipt_store.save(
                intent_key,
                {
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

    def get_task(self, task_id: str) -> dict[str, Any]:
        response = self.client.get(
            f"{self.config.backend_url}/api/v1/tasks/{task_id}",
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
        temporary = destination.with_suffix(destination.suffix + ".part")

        # OSS 签名 URL 是独立下载地址，不携带 Video Flow actor token。
        try:
            with self.client.stream("GET", str(result["downloadUrl"])) as response:
                response.raise_for_status()
                with temporary.open("wb") as output:
                    for chunk in response.iter_bytes():
                        output.write(chunk)
            temporary.replace(destination)
        finally:
            if temporary.exists():
                temporary.unlink()

        return {**result, "localPath": str(destination)}

    @staticmethod
    def stable_idempotency_key(
        prompt: str,
        image_bytes: bytes,
        *,
        profile: str = "seedance",
        duration: int | None = None,
        ratio: str | None = None,
        generation_version: int = 1,
        spec_version: str = "",
    ) -> str:
        generation = json.dumps(
            {
                "duration": duration,
                "profile": profile,
                "ratio": ratio,
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
