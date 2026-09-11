from dataclasses import dataclass
import os
from pathlib import Path

# Token 来源优先级：进程环境变量 > token 文件。
#
# 环境变量是 README 里的原生方式，但 ComfyUI Desktop 是 GUI 应用，普通同事
# 无法方便地给它注入环境变量（macOS 的 launchctl setenv 需要 GUI 会话权限）。
# 因此提供文件回退：把 token 写进本机文件即可，不需要改启动方式，
# 也不会进入 Workflow JSON 或节点输出。
TOKEN_FILE_ENV = "VIDEO_FLOW_TOKEN_FILE"
DEFAULT_TOKEN_FILE = Path("~/.video-flow/token")


def _read_token_file() -> str:
    path = Path(os.getenv(TOKEN_FILE_ENV) or DEFAULT_TOKEN_FILE).expanduser()
    try:
        # 只接受普通文件，避免把目录或设备文件当成凭证来源。
        if not path.is_file():
            return ""
        return path.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


@dataclass(frozen=True)
class VideoFlowConfig:
    backend_url: str
    token: str
    protocol_version: str = "1"

    @classmethod
    def from_env(cls) -> "VideoFlowConfig":
        return cls(
            backend_url=os.getenv("VIDEO_FLOW_BACKEND_URL", "http://localhost:3100").rstrip("/"),
            token=os.getenv("VIDEO_FLOW_TOKEN", "").strip() or _read_token_file(),
            protocol_version=os.getenv("VIDEO_FLOW_PROTOCOL_VERSION", "1"),
        )
