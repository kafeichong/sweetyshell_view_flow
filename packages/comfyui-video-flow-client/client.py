from typing import Any, BinaryIO
import hashlib
import httpx

try:
    from .config import VideoFlowConfig
except ImportError:  # ComfyUI loads custom node modules directly from the folder.
    from config import VideoFlowConfig


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
        response = self.client.post(
            f"{self.config.backend_url}/api/v1/tasks",
            headers=self._headers(scoped_idempotency_key),
            json={**payload, "mode": mode},
        )
        response.raise_for_status()
        return response.json()

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

    @staticmethod
    def stable_idempotency_key(prompt: str, image_bytes: bytes) -> str:
        return hashlib.sha256(prompt.encode() + b"\0" + image_bytes).hexdigest()

    @staticmethod
    def mode_scoped_idempotency_key(idempotency_key: str, mode: str) -> str:
        """将调用方的稳定基准键限定到执行模式，避免 Preview/Production 冲突。"""
        return hashlib.sha256(
            mode.encode() + b"\0" + idempotency_key.encode()
        ).hexdigest()
