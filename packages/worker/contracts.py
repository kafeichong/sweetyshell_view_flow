"""Provider-agnostic contracts for AI video workflows.

These objects describe creative intent and execution metadata. Provider
adapters compile them into API-specific payloads.
"""

from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List


MEDIA_ROLES = {
    "first_frame",
    "last_frame",
    "reference_image",
    "subject_reference",
    "style_reference",
    "reference_video",
    "reference_audio",
}


@dataclass
class PromptSpec:
    # 文本提示信息：positive 为必填主提示，negative/constraints/camera/audio 补充约束。
    positive: str
    negative: str = ""
    shots: List[Dict[str, Any]] = field(default_factory=list)
    constraints: List[str] = field(default_factory=list)
    camera: Dict[str, Any] = field(default_factory=dict)
    audio: Dict[str, Any] = field(default_factory=dict)

    def __post_init__(self):
        if not self.positive.strip():
            raise ValueError("PromptSpec.positive cannot be empty")

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class MediaSpec:
    # 媒体资产统一抽象：media_type 区分 image/video/audio，role 区分用途。
    media_type: str
    role: str
    source: Dict[str, str]

    def __post_init__(self):
        if self.role not in MEDIA_ROLES:
            raise ValueError(f"Unknown media role: {self.role}")
        if not self.source.get("kind") or not self.source.get("value"):
            raise ValueError("MediaSpec.source requires kind and value")

    def to_dict(self) -> Dict[str, Any]:
        return {
            "type": self.media_type,
            "role": self.role,
            "source": dict(self.source),
        }


@dataclass
class GenerationSpec:
    # 生成参数：与 Provider 无关，仅表达用户意图层面的统一参数。
    ratio: str = "16:9"
    duration: int = 5
    resolution: str = "720p"
    seed: int = 0
    generate_audio: bool = False
    watermark: bool = False
    output_count: int = 1

    def __post_init__(self):
        if self.duration < 1:
            raise ValueError("GenerationSpec.duration must be positive")
        if self.output_count < 1:
            raise ValueError("GenerationSpec.output_count must be positive")

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class GenerationRequest:
    # 一次生成需求的完整契约；编译器将其转换为不同厂商请求格式。
    capability: str
    prompt: PromptSpec
    generation: GenerationSpec = field(default_factory=GenerationSpec)
    media: List[MediaSpec] = field(default_factory=list)
    provider: Dict[str, str] = field(default_factory=dict)
    execution: Dict[str, Any] = field(default_factory=lambda: {
        "dry_run": True,
        "confirm": False,
    })

    def to_dict(self) -> Dict[str, Any]:
        return {
            "capability": self.capability,
            "prompt": self.prompt.to_dict(),
            "generation": self.generation.to_dict(),
            "media": [item.to_dict() for item in self.media],
            "provider": dict(self.provider),
            "execution": dict(self.execution),
        }


@dataclass
class UnifiedResult:
    # 统一执行结果：用于跨执行路径打通后续记录与观察逻辑。
    provider_task_id: str
    status: str
    outputs: List[Dict[str, Any]] = field(default_factory=list)
    actual_cost: float | None = None
    provider_raw: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)
