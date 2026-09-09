"""Compile the common workflow contract into a Seedance 2.x Ark payload."""

from typing import Any, Dict

from contracts import GenerationRequest


SEEDANCE_2_DURATION_MIN = 4
SEEDANCE_2_DURATION_MAX = 15


def _compile_prompt(request: GenerationRequest) -> str:
    # 将正向、负向、约束、镜头与分镜信息拼成单段文本，统一给 Ark 入口。
    prompt = request.prompt
    parts = [prompt.positive.strip()]
    if prompt.negative.strip():
        # negative 在 Seedance 下用同名字段拼接时，保留“avoid”语义。
        parts.append(f"避免：{prompt.negative.strip()}")
    if prompt.constraints:
        # constraints 需要扁平化后写入，避免列表格式丢失语义顺序。
        parts.append("约束：" + "；".join(item.strip() for item in prompt.constraints if item.strip()))
    if prompt.camera:
        # camera 是结构化镜头参数，flatten 后附带，后续提供给模型统一解析。
        parts.append("镜头：" + "; ".join(f"{key}={value}" for key, value in prompt.camera.items()))
    if prompt.shots:
        # shots 按每个镜头字典拼接为“key=value”串，保留顺序便于排查。
        parts.append("分镜：" + "; ".join(
            ", ".join(f"{key}={value}" for key, value in shot.items())
            for shot in prompt.shots
        ))
    return "\n".join(parts)


def compile_seedance_request(request: GenerationRequest) -> Dict[str, Any]:
    # 统一从 provider 段读取模型与参数，避免调用方在外层注入无效配置。
    provider = request.provider
    # Seedance 2.x 要求 duration 在固定区间内，否则会被服务端拒绝。
    model = provider.get("model", "").strip()
    if not model:
        raise ValueError("Seedance provider.model cannot be empty")

    generation = request.generation
    if generation.duration < SEEDANCE_2_DURATION_MIN or generation.duration > SEEDANCE_2_DURATION_MAX:
        raise ValueError(
            f"Seedance 2.x duration must be between {SEEDANCE_2_DURATION_MIN} and "
            f"{SEEDANCE_2_DURATION_MAX} seconds"
        )

    content = [{"type": "text", "text": _compile_prompt(request)}]
    for media in request.media:
        source = media.source
        if source.get("kind") != "public_url":
            # 该编译器只支持公共 URL，避免把本地路径透传给云端 API。
            raise ValueError("Seedance compiler requires public_url media sources")
        if media.media_type == "image":
            # image: 上传/存储链路只接受 reference_image 语义，其他角色仍透传便于观察。
            content.append({
                "type": "image_url",
                "image_url": {"url": source["value"]},
                "role": "reference_image" if media.role == "reference_image" else media.role,
            })
        elif media.media_type == "video":
            # video / audio 按 Ark 字段映射到单独 content 类型。
            content.append({
                "type": "video_url",
                "video_url": {"url": source["value"]},
                "role": media.role,
            })
        elif media.media_type == "audio":
            content.append({
                "type": "audio_url",
                "audio_url": {"url": source["value"]},
                "role": media.role,
            })
        else:
            raise ValueError(f"Unsupported Seedance media type: {media.media_type}")

    # 返回值只包含 Seedance 2.x 已支持且必需的字段，其余参数不允许透传。
    return {
        "model": model,
        "content": content,
        "ratio": generation.ratio,
        "duration": generation.duration,
        "resolution": generation.resolution,
        "seed": generation.seed,
        "generate_audio": generation.generate_audio,
        "watermark": generation.watermark,
    }
