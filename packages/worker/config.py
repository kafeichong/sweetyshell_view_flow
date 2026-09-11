from pydantic_settings import BaseSettings
from functools import lru_cache
import os
from urllib.parse import urlparse


ARK_PROVIDER_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3"


def validate_provider_environment(
    *,
    test_mode: bool,
    provider_base_url: str,
    provider_key: str,
) -> None:
    normalized_url = provider_base_url.rstrip("/")
    if test_mode and provider_key.strip():
        raise ValueError("REAL_PROVIDER_CREDENTIAL_FORBIDDEN")

    if normalized_url == ARK_PROVIDER_BASE_URL:
        return

    if not test_mode:
        raise ValueError("CONTRACT_PROVIDER_MODE_REQUIRED")

    parsed = urlparse(normalized_url)
    if parsed.scheme != "http" or parsed.hostname not in {
        "127.0.0.1",
        "localhost",
        "::1",
        "fake-provider",
    }:
        raise ValueError("CONTRACT_PROVIDER_REQUIRED")


class Settings(BaseSettings):
    # Worker
    # 对外提供 HTTP 服务时的监听地址，便于本地/容器环境分别配置。
    worker_port: int = 8001
    worker_host: str = "0.0.0.0"

    # Backend API
    # 指向视频任务主控服务（NestJS），全部执行状态都通过这个入口读写。
    backend_url: str = "http://localhost:3000"
    worker_service_token: str = ""

    # ComfyUI
    # 可选路径：开启后走本地 ComfyUI 的 dry-run 验证流程。
    comfyui_enabled: bool = False
    comfyui_url: str = "http://127.0.0.1:8188"
    comfyui_workflow_path: str = "workflows/seedance-text-to-video-dry-run.api.json"
    comfyui_client_id: str = "video-worker"
    comfyui_output_dir: str = os.getenv("COMFYUI_OUTPUT_DIR", "/app/output")

    # Volcengine Ark API (Seedance 视频生成) 的鉴权主密钥
    volcengine_access_key: str = ""  # Ark API Key
    video_flow_test_mode: bool = False
    video_flow_provider_base_url: str = ARK_PROVIDER_BASE_URL

    # OSS
    # oss region/bucket/credential 用于落库产物上传与签名回放。
    oss_region: str = "oss-cn-beijing"
    oss_bucket: str = "sweetyshell-ai-assets"
    oss_access_key_id: str = ""
    oss_access_key_secret: str = ""
    oss_endpoint: str = "https://oss-cn-beijing.aliyuncs.com"

    # Polling
    # 轮询间隔与超时阈值，决定系统吞吐和重跑策略的速度。
    job_poll_interval: int = 5
    task_status_check_interval: int = 2
    running_job_timeout_minutes: int = 10

    class Config:
        env_file = ".env"
        case_sensitive = False


@lru_cache()
def get_settings() -> Settings:
    settings = Settings()
    validate_provider_environment(
        test_mode=settings.video_flow_test_mode,
        provider_base_url=settings.video_flow_provider_base_url,
        provider_key=settings.volcengine_access_key,
    )
    return settings
