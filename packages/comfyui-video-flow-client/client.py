from typing import Any, BinaryIO
import hashlib
import httpx

from .config import VideoFlowConfig


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

    def create_upload_ticket(self, *, filename: str, mime_type: str, size_bytes: int) -> dict[str, Any]:
        response = self.client.post(
            f"{self.config.backend_url}/api/v1/assets/upload-ticket",
            headers=self._headers(),
            json={"filename": filename, "mimeType": mime_type, "sizeBytes": size_bytes},
        )
        response.raise_for_status()
        return response.json()

    def upload_media(self, media: bytes | BinaryIO, *, filename: str, mime_type: str) -> dict[str, Any]:
        data = media if isinstance(media, bytes) else media.read()
        ticket = self.create_upload_ticket(filename=filename, mime_type=mime_type, size_bytes=len(data))
        response = self.client.put(ticket["uploadUrl"], headers=ticket.get("uploadHeaders", {}), content=data)
        response.raise_for_status()
        return ticket

    def create_task(self, *, idempotency_key: str, payload: dict[str, Any]) -> dict[str, Any]:
        response = self.client.post(
            f"{self.config.backend_url}/api/v1/tasks",
            headers=self._headers(idempotency_key),
            json={**payload, "mode": "preview"},
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
