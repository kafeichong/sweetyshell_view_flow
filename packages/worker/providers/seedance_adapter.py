import httpx
import asyncio
import json
from typing import Optional, Dict, Any
from config import get_settings
from models import ProviderTaskStatus, FailureType

settings = get_settings()


class ProviderSubmissionUncertainError(Exception):
    """Provider submission outcome is unknown and must not be retried automatically."""


class ProviderTaskFailedError(Exception):
    """Provider 明确以失败/取消结束任务。

    必须携带 ProviderTaskStatus：失败任务也可能已经消耗 tokens，usage 是判断
    "是否被计费"的唯一证据，不能只抛一句错误消息把它丢掉。
    """

    def __init__(self, status: ProviderTaskStatus):
        super().__init__(f"Task failed: {status.error_message}")
        self.status = status


def is_submission_uncertain(status_code: Optional[int], has_task_id: bool) -> bool:
    """提交结果是否不可判定（因此禁止自动重提）。

    只有 4xx 才算"Provider 明确拒绝、确定没有创建任务"。其余情况都必须按
    不确定处理：连接中断（无状态码）时请求可能已到达；5xx 时服务端可能已
    创建任务只是响应没回来；2xx 但没有任务 ID、或响应无法解析，同理。
    已经拿到任务 ID 说明提交确定成功，与状态码无关。
    """
    if has_task_id:
        return False
    if status_code is None:
        return True
    return not (400 <= status_code < 500)


class SeedanceAdapter:
    """火山方舟 Ark API 适配器 - 视频生成任务"""

    default_model = "doubao-seedance-2-5-260628"
    pricing_version = "seedance-token-v1"

    def __init__(self, api_key: Optional[str] = None):
        # 使用 Ark API Key (格式: ark-...)
        self.api_key = api_key or settings.volcengine_access_key
        self.base_url = settings.video_flow_provider_base_url.rstrip("/")
        self.client = httpx.AsyncClient(timeout=60.0)

    def _build_headers(self) -> dict:
        """构建请求头 - Bearer Token 鉴权。

        没有密钥时不要发出 `Authorization: Bearer `（空值）：这不是"匿名请求"，
        而是格式非法的头，httpx 会直接拒绝，提交会被误判成"结果不确定"，
        掩盖"密钥没配"这个真实原因。合同环境按规约不允许配置 Provider 密钥，
        因此这里必须容忍空密钥；真需要鉴权的 Provider 会返回 401，那是明确的拒绝。
        """
        headers = {"Content-Type": "application/json"}
        api_key = (self.api_key or "").strip()
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        return headers

    async def create_task(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """
        创建视频生成任务

        Args:
            params: 任务参数
                - prompt: 文本描述 (必需)
                - model: 模型名称 (默认: doubao-seedance-2-5-260628)
                - image_urls: 图片URL列表，用于图生视频/参考图 (可选)
                - video_urls: 参考视频URL列表 (可选)
                - audio_urls: 参考音频URL列表 (可选)
                - ratio: 比例 "16:9" | "9:16" | "1:1" | "4:3" | "3:4" | "21:9" (默认: 16:9)
                - duration: 时长秒数 (默认: 5)
                - generate_audio: 是否生成音频 (默认: False)
                - watermark: 是否加水印 (默认: False)
                - seed: 随机种子 (可选)

        Returns:
            {"task_id": "...", "status": "submitted"}
        """
        compiled_payload = params.get("_compiled_payload")
        if compiled_payload is not None:
            if not isinstance(compiled_payload, dict):
                raise ValueError("Seedance compiled payload must be an object")
            return await self.create_task_payload(compiled_payload)

        # 构建 content 数组
        content = []

        # 文本 prompt
        if params.get("prompt"):
            content.append({
                "type": "text",
                "text": params["prompt"]
            })

        # 新工作流执行计划按资产角色传入。角色决定 Ark 的 content type；
        # 后端尚未开放的角色不会到达这里，但保留编译能力便于后续受控启用。
        for media in params.get("media_urls", []):
            role = media.get("role")
            url = media.get("url")
            if not isinstance(url, str) or not url:
                raise ValueError("Seedance media_urls requires a URL")
            if role == "reference_image":
                content.append({"type": "image_url", "image_url": {"url": url}, "role": role})
            elif role == "reference_video":
                content.append({"type": "video_url", "video_url": {"url": url}, "role": role})
            elif role == "reference_audio":
                content.append({"type": "audio_url", "audio_url": {"url": url}, "role": role})
            else:
                raise ValueError(f"Unsupported Seedance media role: {role}")

        # 兼容早期适配器的图片列表。
        for image_url in params.get("image_urls", []):
            content.append({
                "type": "image_url",
                "image_url": {"url": image_url},
                "role": "reference_image"
            })

        # 兼容单图片参数
        if params.get("image_url"):
            content.append({
                "type": "image_url",
                "image_url": {"url": params["image_url"]},
                "role": "reference_image"
            })

        # 参考视频
        for video_url in params.get("video_urls", []):
            content.append({
                "type": "video_url",
                "video_url": {"url": video_url},
                "role": "reference_video"
            })

        # 参考音频
        for audio_url in params.get("audio_urls", []):
            content.append({
                "type": "audio_url",
                "audio_url": {"url": audio_url},
                "role": "reference_audio"
            })

        # 构建请求体
        payload = {
            "model": params.get("model", self.default_model),
            "content": content,
            "generate_audio": params.get("generate_audio", False),
            "ratio": params.get("ratio", "16:9"),
            "duration": params.get("duration", 5),
            "watermark": params.get("watermark", False)
        }

        if params.get("resolution"):
            payload["resolution"] = params["resolution"]

        # 可选参数
        if params.get("seed") is not None:
            payload["seed"] = params["seed"]

        url = f"{self.base_url}/contents/generations/tasks"
        headers = self._build_headers()

        try:
            response = await self.client.post(
                url,
                headers=headers,
                json=payload
            )
        except httpx.RequestError as e:
            # 请求可能已经到达 Provider：无法判定是否已创建任务。
            raise ProviderSubmissionUncertainError(
                f"Provider submission outcome unknown: {str(e)}"
            ) from e

        status_code = response.status_code

        if 400 <= status_code < 500:
            # Provider 明确拒绝：确定没有创建任务，保留原始拒绝原因供分类重试。
            error_text = response.text
            if status_code == 429:
                raise Exception(f"Rate limit exceeded: {error_text}")
            if status_code == 400:
                raise Exception(f"Invalid request: {error_text}")
            if status_code == 401 or status_code == 403:
                raise Exception(f"Authentication failed: {error_text}")
            raise Exception(f"HTTP {status_code}: {error_text}")

        if not (200 <= status_code < 300):
            # 5xx：服务端可能已经建好任务，只是响应没回来。
            raise ProviderSubmissionUncertainError(
                f"Provider returned HTTP {status_code}; submission outcome unknown"
            )

        try:
            data = response.json()
        except ValueError as e:
            raise ProviderSubmissionUncertainError(
                "Provider response could not be parsed; submission outcome unknown"
            ) from e

        # Ark API 返回格式: {"id": "task-xxx"}。响应体不写进异常消息，
        # 避免把完整响应带进 DB 的 failure_message。
        task_id = data.get("id") if isinstance(data, dict) else None
        if is_submission_uncertain(status_code, has_task_id=bool(task_id)):
            raise ProviderSubmissionUncertainError(
                "Provider response has no task id; submission outcome unknown"
            )

        return {
            "task_id": task_id,
            "status": "submitted"
        }

    async def create_task_payload(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """Submit an already compiled Ark payload without changing its semantics.

        Only the execution-policy compiler may construct this payload for a
        new approved execution plan.  `create_task` remains for legacy tasks
        while their old execution snapshots are drained safely.
        """
        if not isinstance(payload, dict) or not isinstance(payload.get("content"), list):
            raise ValueError("Seedance payload requires a content array")
        url = f"{self.base_url}/contents/generations/tasks"
        try:
            response = await self.client.post(url, headers=self._build_headers(), json=payload)
        except httpx.RequestError as e:
            raise ProviderSubmissionUncertainError(
                f"Provider submission outcome unknown: {str(e)}"
            ) from e

        status_code = response.status_code
        if 400 <= status_code < 500:
            error_text = response.text
            if status_code == 429:
                raise Exception(f"Rate limit exceeded: {error_text}")
            if status_code == 400:
                raise Exception(f"Invalid request: {error_text}")
            if status_code in (401, 403):
                raise Exception(f"Authentication failed: {error_text}")
            raise Exception(f"HTTP {status_code}: {error_text}")
        if not (200 <= status_code < 300):
            raise ProviderSubmissionUncertainError(
                f"Provider returned HTTP {status_code}; submission outcome unknown"
            )
        try:
            data = response.json()
        except ValueError as e:
            raise ProviderSubmissionUncertainError(
                "Provider response could not be parsed; submission outcome unknown"
            ) from e
        task_id = data.get("id") if isinstance(data, dict) else None
        if is_submission_uncertain(status_code, has_task_id=bool(task_id)):
            raise ProviderSubmissionUncertainError(
                "Provider response has no task id; submission outcome unknown"
            )
        return {"task_id": task_id, "status": "submitted"}

    async def get_task_status(self, task_id: str) -> ProviderTaskStatus:
        """
        查询任务状态

        真实 Ark API 响应格式（已通过实际调用确认）:
        {
          "id": "cgt-xxx",
          "status": "queued" | "running" | "succeeded" | "failed" | "cancelled",
          "content": {"video_url": "https://..."},
          "error": {"code": "...", "message": "..."}
        }

        Args:
            task_id: 任务ID

        Returns:
            ProviderTaskStatus
        """
        url = f"{self.base_url}/contents/generations/tasks/{task_id}"
        headers = self._build_headers()

        try:
            response = await self.client.get(url, headers=headers)
            response.raise_for_status()
            data = response.json()

            ark_status = data.get("status", "queued")
            video_url = None
            error_message = None
            usage = data.get("usage")  # Extract usage info from API response

            # Ark 状态映射为内部状态（completed/failed/running）
            if ark_status == "succeeded":
                status = "completed"
                video_url = data.get("content", {}).get("video_url")
            elif ark_status == "failed":
                status = "failed"
                error = data.get("error")
                error_message = error.get("message") if isinstance(error, dict) else str(error)
            elif ark_status == "cancelled":
                status = "failed"
                error_message = "Task cancelled"
            else:
                status = "running"

            return ProviderTaskStatus(
                id=task_id,
                status=status,
                result_url=video_url,
                error_message=error_message,
                progress=None,
                usage=usage
            )

        except httpx.HTTPStatusError as e:
            raise Exception(f"Failed to get task status: {e.response.text}")
        except httpx.RequestError as e:
            raise Exception(f"Network error: {str(e)}")

    async def poll_until_complete(
        self,
        task_id: str,
        max_attempts: int = 180,
        interval: int = 2
    ) -> ProviderTaskStatus:
        """
        轮询直到任务完成

        Args:
            task_id: 任务ID
            max_attempts: 最大尝试次数 (默认180次 = 6分钟)
            interval: 轮询间隔秒数 (默认2秒)

        Returns:
            最终任务状态
        """
        for attempt in range(max_attempts):
            status = await self.get_task_status(task_id)

            if status.status == "completed":
                return status
            elif status.status == "failed":
                # 带上完整终态：usage 是"是否被计费"的证据，不能在这里丢弃。
                raise ProviderTaskFailedError(status)

            # 仍在运行时 sleep 后重试，避免无限循环阻塞 worker。
            await asyncio.sleep(interval)

        raise Exception(f"Task timeout after {max_attempts * interval} seconds")

    async def download_video(self, url: str, save_path: str) -> str:
        """
        下载视频到本地

        Args:
            url: 视频URL
            save_path: 本地保存路径

        Returns:
            本地文件路径
        """
        async with self.client.stream("GET", url) as response:
            response.raise_for_status()

            with open(save_path, "wb") as f:
                async for chunk in response.aiter_bytes():
                    # 按块写入避免一次性占用内存。
                    f.write(chunk)

        return save_path

    def calculate_actual_cost(self, usage: dict) -> Optional[float]:
        """
        根据 API 返回的真实 token 消耗计算实际费用

        Args:
            usage: {"completion_tokens": int, "total_tokens": int}

        Returns:
            实际费用（CNY）

        定价（根据实际账单反推）:
        - Seedance 视频生成: ¥70 / 百万 tokens
        """
        if not usage or ("completion_tokens" not in usage and "total_tokens" not in usage):
            return None

        usage_key = "completion_tokens" if self.pricing_version == "seedance-2-5-official-v1" else "total_tokens"
        total_tokens = usage.get(usage_key)
        if total_tokens is None:
            return None
        if isinstance(total_tokens, bool) or not isinstance(total_tokens, (int, float)):
            return None
        if total_tokens < 0:
            return None
        # ¥70 per million tokens
        return (total_tokens / 1_000_000) * 70

    def classify_failure(self, error_message: str) -> FailureType:
        """
        失败分类

        Args:
            error_message: 错误消息

        Returns:
            FailureType
        """
        msg_lower = error_message.lower()

        if "rate limit" in msg_lower or "429" in msg_lower or "throttling" in msg_lower:
            return FailureType.RATE_LIMIT
        elif "content" in msg_lower or "policy" in msg_lower or "violation" in msg_lower:
            return FailureType.CONTENT_POLICY
        elif "invalid" in msg_lower or "400" in msg_lower or "parameter" in msg_lower:
            return FailureType.INVALID_INPUT
        elif "timeout" in msg_lower:
            return FailureType.TIMEOUT
        elif "network" in msg_lower or "connection" in msg_lower:
            return FailureType.NETWORK_ERROR
        elif "auth" in msg_lower or "401" in msg_lower or "403" in msg_lower:
            return FailureType.INVALID_INPUT  # 认证失败归为配置错误
        else:
            return FailureType.UNKNOWN

    async def close(self):
        """关闭HTTP客户端"""
        await self.client.aclose()
