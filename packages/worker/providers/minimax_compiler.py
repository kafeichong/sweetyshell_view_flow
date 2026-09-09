"""Compile the common workflow contract into MiniMax video payloads.

Two compilers live here:

- ``compile_minimax_request`` targets the **legacy Hailuo-2.3 v1 API** (flat
  ``first_frame_image`` field, ``/v1/video_generation`` style).
- ``compile_minimax_h3_request`` targets the **MiniMax-H3 (Hailuo 3.0) V2 API**
  (``POST /v2/video_generation``) with the multimodal ``content[]`` + ``role``
  structure, covering t2va / i2va / fl2va / r2va. The "素材图 + 已有视频 →
  合成一条新视频" merge workflow maps to **r2va** (reference image gives the
  subject identity, reference video gives the motion).

Official constraints enforced here come from
https://platform.minimaxi.com/docs/guides/video-generation and
https://platform.minimaxi.com/docs/api-reference/video-generation-v2-create
"""

from typing import Any, Dict, List

from contracts import GenerationRequest

MINIMAX_H3_MODEL = "MiniMax-H3"
H3_RESOLUTIONS = ("768P", "2K")
H3_RATIOS = ("21:9", "16:9", "4:3", "1:1", "3:4", "9:16")
H3_DURATION_MIN = 4
H3_DURATION_MAX = 15
H3_MAX_PROMPT_CHARS = 7000
H3_MAX_IMAGES = 9
H3_MAX_VIDEOS = 3
H3_MAX_AUDIOS = 3
H3_MAX_TOTAL_FILES = 12

_H3_ROLE_TO_TYPE = {
    "first_frame": "image",
    "last_frame": "image",
    "reference_image": "image",
    # MiniMax-H3 has no dedicated subject/style role: subject identity and
    # style are both expressed through reference_image semantics and are bound
    # by the prompt. Map them here so MediaSpec stays provider-agnostic.
    "subject_reference": "image",
    "style_reference": "image",
    "reference_video": "video",
    "reference_audio": "audio",
}


def _compile_minimax_prompt(request: GenerationRequest) -> str:
    # 统一 prompt 结构：正向提示 + 约束/负向提示，供后续多模态 payload 拼接。
    prompt = request.prompt.positive.strip()
    if request.prompt.constraints:
        constraints = "；".join(item.strip() for item in request.prompt.constraints if item.strip())
        if constraints:
            prompt = f"{prompt}\n约束：{constraints}"
    if request.prompt.negative.strip():
        prompt = f"{prompt}\n避免：{request.prompt.negative.strip()}"
    return prompt


# --------------------------------------------------------------------------
# Legacy Hailuo-2.3 v1 compiler (kept for backward compatibility)
# --------------------------------------------------------------------------


def compile_minimax_request(request: GenerationRequest) -> Dict[str, Any]:
    """Compile a Hailuo-2.3 v1 payload (flat ``first_frame_image`` field).

    Use ``compile_minimax_h3_request`` instead for the H3 multimodal API.
    """
    # 保留旧版 Hailuo-2.3 接口兼容：要求模型不为空且仅支持 first_frame。
    model = request.provider.get("model", "").strip()
    if not model:
        raise ValueError("MiniMax provider.model cannot be empty")

    prompt = _compile_minimax_prompt(request)

    payload: Dict[str, Any] = {
        "prompt": prompt,
        "model": model,
        "duration": request.generation.duration,
        "resolution": request.generation.resolution,
    }

    if request.capability == "IMAGE_TO_VIDEO":
        first_frames = [
            media for media in request.media
            if media.media_type == "image" and media.role == "first_frame"
        ]
        if not first_frames:
            raise ValueError("MiniMax IMAGE_TO_VIDEO requires a first_frame image")
        source = first_frames[0].source
        if source.get("kind") not in {"public_url", "data_url"}:
            raise ValueError("MiniMax first_frame requires public_url or data_url")
        payload["first_frame_image"] = source["value"]

    return payload


# --------------------------------------------------------------------------
# MiniMax-H3 V2 compiler (content[] + role)
# --------------------------------------------------------------------------


def compile_minimax_h3_request(request: GenerationRequest) -> Dict[str, Any]:
    """Compile a MiniMax-H3 ``/v2/video_generation`` payload.

    Mode is derived from the media content:

    - no media                 -> t2va (text to video)
    - first/last frame images  -> i2va / fl2va (image to video)
    - reference_* items        -> r2va (全能参考; image+video merge)

    Hard rules enforced: first/last frame roles and reference roles are
    mutually exclusive; prompt is required and capped at 7000 chars; duration
    is an integer in [4, 15]; resolution must be 768P or 2K; per-type media
    counts and the 12-file total cap follow the official limits; audio alone
    is not a valid reference input.
    """
    model = request.provider.get("model", "").strip()
    # H3 专用编译器要求 model 固定为 MiniMax-H3，避免把参数喂给错模型。
    if model != MINIMAX_H3_MODEL:
        raise ValueError(
            f"MiniMax H3 compiler requires model '{MINIMAX_H3_MODEL}', got '{model or '<empty>'}'"
        )

    prompt = _compile_minimax_prompt(request)
    if len(prompt) > H3_MAX_PROMPT_CHARS:
        raise ValueError(
            f"MiniMax-H3 prompt exceeds {H3_MAX_PROMPT_CHARS} chars "
            f"(got {len(prompt)}); keep the prompt under the official cap"
        )

    duration = request.generation.duration
    if not isinstance(duration, int) or isinstance(duration, bool):
        raise ValueError("MiniMax-H3 duration must be an integer")
    if duration < H3_DURATION_MIN or duration > H3_DURATION_MAX:
        raise ValueError(
            f"MiniMax-H3 duration must be an integer between "
            f"{H3_DURATION_MIN} and {H3_DURATION_MAX}, got {duration}"
        )

    resolution = str(request.generation.resolution).upper()
    if resolution not in H3_RESOLUTIONS:
        raise ValueError(
            f"MiniMax-H3 resolution must be one of {H3_RESOLUTIONS}, got "
            f"'{request.generation.resolution}' (no silent fallback from "
            f"720p/1080P; request 768P or 2K explicitly)"
        )

    # ---- classify media by role ------------------------------------------
    first_frames: List[Dict[str, Any]] = []
    last_frames: List[Dict[str, Any]] = []
    ref_images: List[Dict[str, Any]] = []
    ref_videos: List[Dict[str, Any]] = []
    ref_audios: List[Dict[str, Any]] = []

    for media in request.media:
        expected_type = _H3_ROLE_TO_TYPE.get(media.role)
        if expected_type is None:
            raise ValueError(f"MiniMax-H3 does not support media role: {media.role}")
        if media.media_type != expected_type:
            raise ValueError(
                f"MiniMax-H3 role '{media.role}' requires media_type "
                f"'{expected_type}', got '{media.media_type}'"
            )
        if media.source.get("kind") not in {"public_url", "data_url"}:
            raise ValueError(
                "MiniMax-H3 media requires public_url or data_url source "
                f"(got {media.source.get('kind')}); local files must be uploaded first"
            )
        item = {
            "url": media.source["value"],
            "role": media.role if media.role in {"first_frame", "last_frame"} else "reference_image",
        }
        if media.role == "first_frame":
            first_frames.append(item)
        elif media.role == "last_frame":
            last_frames.append(item)
        elif media.role == "reference_video":
            ref_videos.append(item)
        elif media.role == "reference_audio":
            ref_audios.append(item)
        else:  # reference_image / subject_reference / style_reference
            ref_images.append(item)

    if len(first_frames) > 1 or len(last_frames) > 1:
        raise ValueError("MiniMax-H3 supports at most one first_frame and one last_frame image")
    if len(first_frames) + len(last_frames) > 2:
        raise ValueError("MiniMax-H3 image-to-video accepts 0, 1 or 2 frame images")

    has_frames = bool(first_frames or last_frames)
    has_refs = bool(ref_images or ref_videos or ref_audios)
    if has_frames and has_refs:
        raise ValueError(
            "MiniMax-H3 图生视频与多模态参考互斥：同一请求不能同时出现 "
            "first_frame/last_frame 与 reference_image/reference_video/"
            "reference_audio role（官方硬约束）"
        )

    if len(ref_images) > H3_MAX_IMAGES:
        raise ValueError(f"MiniMax-H3 allows at most {H3_MAX_IMAGES} reference images")
    if len(ref_videos) > H3_MAX_VIDEOS:
        raise ValueError(f"MiniMax-H3 allows at most {H3_MAX_VIDEOS} reference videos")
    if len(ref_audios) > H3_MAX_AUDIOS:
        raise ValueError(f"MiniMax-H3 allows at most {H3_MAX_AUDIOS} reference audios")
    total_files = len(request.media)
    if total_files > H3_MAX_TOTAL_FILES:
        raise ValueError(
            f"MiniMax-H3 mixed input allows at most {H3_MAX_TOTAL_FILES} media files, "
            f"got {total_files}"
        )
    if ref_audios and not (ref_images or ref_videos):
        raise ValueError(
            "MiniMax-H3 音频不能单独作为参考输入，必须同时提供至少一张图片或一段视频"
        )

    # ---- build content[] --------------------------------------------------
    content: List[Dict[str, Any]] = [{"type": "text", "text": prompt}]
    # content 按 role 构建文本+媒体顺序；Comfy/Seedance 不同，这里严格跟 H3 API 约定。
    for frame in first_frames + last_frames:
        content.append({
            "type": "image_url",
            "image_url": {"url": frame["url"]},
            "role": frame["role"],
        })
    for image in ref_images:
        content.append({
            "type": "image_url",
            "image_url": {"url": image["url"]},
            "role": "reference_image",
        })
    for video in ref_videos:
        content.append({
            "type": "video_url",
            "video_url": {"url": video["url"]},
            "role": "reference_video",
        })
    for audio in ref_audios:
        content.append({
            "type": "audio_url",
            "audio_url": {"url": audio["url"]},
            "role": "reference_audio",
        })

    # ---- mode-specific ratio rules -----------------------------------------
    ratio = str(request.generation.ratio or "16:9").strip()
    if not has_frames and not has_refs:
        # t2va: ratio is required and cannot be adaptive
        if ratio == "adaptive":
            raise ValueError("MiniMax-H3 t2va 需要显式 ratio，不能为 adaptive")
        if ratio not in H3_RATIOS:
            raise ValueError(
                f"MiniMax-H3 t2va ratio must be one of {H3_RATIOS}, got '{ratio}'"
            )
        resolved_ratio = ratio
    elif has_frames:
        # i2va/fl2va: aspect follows the input frames; ratio is always adaptive
        resolved_ratio = "adaptive"
    else:
        # r2va: ratio optional, defaults to adaptive
        if ratio in H3_RATIOS:
            resolved_ratio = ratio
        else:
            resolved_ratio = "adaptive"

    payload: Dict[str, Any] = {
        "model": MINIMAX_H3_MODEL,
        "content": content,
        "resolution": resolution,
        "duration": duration,
        "ratio": resolved_ratio,
    }
    if request.generation.watermark:
        payload["aigc_watermark"] = True
    return payload
