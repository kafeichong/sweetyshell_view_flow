from dataclasses import dataclass
import os


@dataclass(frozen=True)
class VideoFlowConfig:
    backend_url: str
    token: str
    protocol_version: str = "1"

    @classmethod
    def from_env(cls) -> "VideoFlowConfig":
        return cls(
            backend_url=os.getenv("VIDEO_FLOW_BACKEND_URL", "http://localhost:3100").rstrip("/"),
            token=os.getenv("VIDEO_FLOW_TOKEN", ""),
            protocol_version=os.getenv("VIDEO_FLOW_PROTOCOL_VERSION", "1"),
        )
