from __future__ import annotations

from typing import Any

import httpx


class ComfyUIError(RuntimeError):
    """Raised when ComfyUI returns an unusable response."""


class ComfyUIClient:
    def __init__(self, base_url: str, client: httpx.AsyncClient | None = None):
        # 自动去除尾随 /，保证拼接 URL 时不会出现 //。
        self.base_url = base_url.rstrip("/")
        self._client = client or httpx.AsyncClient(base_url=self.base_url, trust_env=False)
        self._owns_client = client is None

    async def health(self) -> dict[str, Any]:
        return await self._get_json("/system_stats")

    async def object_info(self) -> dict[str, Any]:
        return await self._get_json("/object_info")

    async def queue_prompt(
        self, workflow: dict[str, Any], client_id: str | None = None
    ) -> str:
        # 提交给 ComfyUI 的 payload 固定使用 prompt + 可选 client_id，便于同机会话追踪。
        payload: dict[str, Any] = {"prompt": workflow}
        if client_id is not None:
            payload["client_id"] = client_id

        response = await self._request("POST", "/prompt", json=payload)
        data = self._parse_json(response)
        prompt_id = data.get("prompt_id")
        if not isinstance(prompt_id, str) or not prompt_id.strip():
            raise ComfyUIError("ComfyUI response is missing a valid prompt_id")
        return prompt_id

    async def history(self, prompt_id: str) -> dict[str, Any]:
        return await self._get_json(f"/history/{prompt_id}")

    async def close(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def _get_json(self, path: str) -> dict[str, Any]:
        response = await self._request("GET", path)
        return self._parse_json(response)

    async def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        try:
            response = await self._client.request(method, f"{self.base_url}{path}", **kwargs)
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise ComfyUIError(
                f"ComfyUI request failed with HTTP {exc.response.status_code}"
            ) from exc
        except httpx.HTTPError as exc:
            raise ComfyUIError(f"ComfyUI request failed: {exc}") from exc
        return response

    @staticmethod
    def _parse_json(response: httpx.Response) -> dict[str, Any]:
        try:
            data = response.json()
        except ValueError as exc:
            raise ComfyUIError("ComfyUI response contains malformed JSON") from exc
        if not isinstance(data, dict):
            raise ComfyUIError("ComfyUI response JSON must be an object")
        return data
