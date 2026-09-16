"""Read-only local media inspection shared by Video Flow ComfyUI nodes."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

from PIL import Image, UnidentifiedImageError


ROLE_KIND = {
    "reference_image": "image",
    "first_frame": "image",
    "last_frame": "image",
    "reference_video": "video",
    "reference_audio": "audio",
}
IMAGE_MIME = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp"}
MAX_SIZE = {"image": 30 * 1024 * 1024, "video": 200 * 1024 * 1024, "audio": 15 * 1024 * 1024}


class MediaInspectionError(ValueError):
    """A stable local validation error that can be shown in a ComfyUI node."""


def sha256_file(path: str | Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _number(value: Any) -> float | None:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    if result <= 0 or result == float("inf") or result != result:
        return None
    return round(result, 6)


def _frame_rate(value: Any) -> float | None:
    if not isinstance(value, str) or not value:
        return None
    parts = value.split("/", 1)
    numerator = _number(parts[0])
    denominator = _number(parts[1]) if len(parts) == 2 else 1.0
    if numerator is None or denominator is None:
        return None
    return round(numerator / denominator, 6)


def _measured(value: Any, digits: int = 2) -> str:
    """把实测值写成人能读的样子；读不到就明说，别让它变成 "None"。

    时长按两位小数（95.346938 秒要写成 95.35，用户才好判断该剪到几秒）；帧率这类则用
    有效数字（24.0 写成 24，29.97 原样保留）。
    """
    number = _number(value)
    if number is None:
        return "读不到"
    return f"{number:.{digits}f}" if digits else f"{number:g}"


def _stable_audio_duration(value: Any) -> Any:
    """音频时长按 0.1 秒归一，理由见后端 media-inspector.service.ts 的同名处理。

    mp3 的时长靠帧计数，不同 ffprobe 版本会对同一个文件给出不同的值（实测同一个 10 秒 mp3：
    容器里的 5.1.9 报 10.03102、本机 8.0.1 报 10.0）。预检元数据要按内容摘要与服务端逐字段
    比对，不归一就会在正式提交时撞 `PREFLIGHT_ACTUAL_CONTENT_MISMATCH`（2026-09-16 首次
    提交纯音频任务时真实踩到）。音频时长不进入计费公式，只用于官方 2–30 秒的限制。
    """
    number = _number(value)
    return round(number, 1) if number is not None else value


def _invalid(code: str, detail: str) -> MediaInspectionError:
    """不合格的错误信息必须写清"实际是多少、要求是多少"。

    踩过：只丢一个 `AUDIO_DURATION_INVALID` 出去，用户拿到 95 秒的音乐，在 ComfyUI 的报错面板里
    就只看到这一行码——既看不出是时长还是格式的问题，也不知道该剪到几秒，而这些限制本来
    都是可操作的。码放最前面，测试与日志照旧可以按码匹配。
    """
    return MediaInspectionError(f"{code}: {detail}")


def _validate(kind: str, mime_type: str, size_bytes: int, metadata: dict[str, Any]) -> None:
    if size_bytes <= 0 or (size_bytes >= MAX_SIZE[kind] if kind == "image" else size_bytes > MAX_SIZE[kind]):
        raise _invalid(f"{kind.upper()}_SIZE_INVALID",
                       f"文件 {size_bytes / 1024 / 1024:.2f} MB，上限 {MAX_SIZE[kind] / 1024 / 1024:g} MB")
    if kind in {"image", "video"}:
        width = metadata.get("width")
        height = metadata.get("height")
        if not isinstance(width, int) or not isinstance(height, int) or not (300 <= width <= 6000 and 300 <= height <= 6000):
            raise _invalid(f"{kind.upper()}_DIMENSIONS_INVALID",
                           f"尺寸 {width}×{height}，要求宽和高都在 300–6000 像素之间")
        if not 0.4 <= width / height <= 2.5:
            raise _invalid(f"{kind.upper()}_ASPECT_RATIO_INVALID", f"宽高比 {width / height:.2f}，要求 0.4–2.5")
    if kind == "video":
        pixels = metadata["width"] * metadata["height"]
        if not 407696 <= pixels <= 8295044:
            raise _invalid("VIDEO_PIXELS_INVALID", f"像素 {pixels}，要求 407696–8295044")
        if not 2 <= metadata.get("durationSeconds", 0) <= 30:
            raise _invalid("VIDEO_DURATION_INVALID", f"时长 {_measured(metadata.get('durationSeconds'))} 秒，要求 2–30 秒")
        if not 24 <= metadata.get("frameRate", 0) <= 60:
            raise _invalid("VIDEO_FRAME_RATE_INVALID", f"帧率 {_measured(metadata.get('frameRate'), 0)}，要求 24–60")
        if metadata.get("videoCodec") not in {"h264", "h265", "hevc"}:
            raise _invalid("VIDEO_CODEC_INVALID", f"编码 {metadata.get('videoCodec')}，只接受 h264 / h265 / hevc")
        if mime_type not in {"video/mp4", "video/quicktime"}:
            raise _invalid("VIDEO_CONTAINER_INVALID", f"容器 {mime_type}，只接受 mp4 / mov")
    if kind == "audio":
        if not 2 <= metadata.get("durationSeconds", 0) <= 30:
            raise _invalid("AUDIO_DURATION_INVALID", f"时长 {_measured(metadata.get('durationSeconds'))} 秒，要求 2–30 秒")
        if mime_type not in {"audio/wav", "audio/mpeg"}:
            raise _invalid("AUDIO_FORMAT_INVALID", f"格式 {mime_type}，只接受 wav / mp3")


def _inspect_image(path: Path) -> tuple[str, dict[str, Any]] | None:
    try:
        with Image.open(path) as image:
            image.load()
            mime_type = IMAGE_MIME.get(image.format or "")
            if not mime_type or getattr(image, "n_frames", 1) != 1:
                raise _invalid("IMAGE_FORMAT_INVALID", f"图片格式 {image.format} 不支持，只接受 png / jpg / jpeg / webp 的静态图")
            width, height = image.size
            return mime_type, {"kind": "image", "width": width, "height": height}
    except UnidentifiedImageError:
        return None
    except OSError as error:
        raise MediaInspectionError("MEDIA_INSPECTION_FAILED") from error


# 找不到 ffprobe 时的兜底查找位置。Comfy Desktop 从 GUI 启动，进程 PATH 只有系统默认值，
# **不含 /opt/homebrew/bin**，所以只靠 shutil.which 会在"明明装了 ffmpeg"的机器上报错
# （踩过一次：节点报 FFPROBE_NOT_AVAILABLE，但 /opt/homebrew/bin/ffprobe 就在那儿）。
FFPROBE_CANDIDATES = (
    "/opt/homebrew/bin/ffprobe",   # macOS / Apple Silicon 的 Homebrew
    "/usr/local/bin/ffprobe",      # macOS / Intel 的 Homebrew
    "/opt/local/bin/ffprobe",      # MacPorts
    "/usr/bin/ffprobe",            # 常见发行版自带
    # 没装包管理器时的"手动落点"：把 ffprobe 二进制丢进 ~/.video-flow/ 即可，不用碰环境变量
    # （Comfy Desktop 从 GUI 启动，改了 .zshrc 里的 PATH 也传不进来）。同事机器上缺 ffprobe
    # 报 FFPROBE_NOT_AVAILABLE 时，安装器就是引导到这里。
    str(Path.home() / ".video-flow" / "ffprobe"),
)


def _is_executable(path: str) -> bool:
    return os.path.isfile(path) and os.access(path, os.X_OK)


def ffprobe_executable() -> str | None:
    """按顺序找一个可用的 ffprobe：环境变量 → PATH → 上面那几个常见位置。"""
    override = os.environ.get("VIDEO_FLOW_FFPROBE")
    if override:
        return override if _is_executable(override) else None
    found = shutil.which("ffprobe")
    if found:
        return found
    return next((candidate for candidate in FFPROBE_CANDIDATES if _is_executable(candidate)), None)


def _probe(path: Path) -> dict[str, Any]:
    executable = ffprobe_executable()
    if not executable:
        raise MediaInspectionError(
            "FFPROBE_NOT_AVAILABLE: 需要 ffprobe（ffmpeg 自带）。已查找 PATH 与 "
            + "、".join(FFPROBE_CANDIDATES)
            + "；也可以用环境变量 VIDEO_FLOW_FFPROBE 指定绝对路径。",
        )
    try:
        completed = subprocess.run(
            [executable, "-v", "error", "-show_format", "-show_streams", "-of", "json", str(path)],
            check=True,
            capture_output=True,
            text=True,
            timeout=15,
        )
        return json.loads(completed.stdout)
    except (subprocess.SubprocessError, json.JSONDecodeError) as error:
        raise MediaInspectionError("MEDIA_INSPECTION_FAILED") from error


def _is_quicktime_brand(format_data: dict[str, Any]) -> bool:
    """容器是不是 QuickTime 品牌。

    **不能写 `brand.startswith("qt")`**：ffprobe 9.0 起 `major_brand` 会给出**分号拼起来的品牌
    列表**，同一个文件在 8.x 是 `qt`、在 9.x 是 `isom;qt`。只看开头就会把后者判成 mp4，与服务端
    （8.x，判成 quicktime）对不上——正式提交时被服务端按 mime 不符拒掉，而且错误被吞成一句
    "Uploaded media could not be inspected"（2026-09-16 同事机上真实踩到，就是因为随包的
    ffprobe 是 9.0.1）。所以按 `;` 拆开，逐个比。
    """
    brand = str((format_data.get("tags") or {}).get("major_brand", "")).lower()
    return any(part.strip() == "qt" for part in brand.split(";"))


def _inspect_av(path: Path) -> tuple[str, str, dict[str, Any]]:
    probe = _probe(path)
    streams = probe.get("streams") if isinstance(probe.get("streams"), list) else []
    video = next((stream for stream in streams if stream.get("codec_type") == "video"), None)
    audio = next((stream for stream in streams if stream.get("codec_type") == "audio"), None)
    format_data = probe.get("format") if isinstance(probe.get("format"), dict) else {}
    format_name = str(format_data.get("format_name", "")).lower()
    # 时长取**流**的 duration，而不是容器的：同一个 mp4，容器 ffprobe 5.1.9 报 5.077333、
    # 8.0.1 报 5.041667，而流的时长两边都是 5.041667。元数据要按内容摘要与后端逐字段比对，
    # 用容器时长会让本机与后端对不上，提交被 PREFLIGHT_ACTUAL_CONTENT_MISMATCH 拒掉（踩过）。
    stream_duration = _number((video or audio or {}).get("duration"))
    duration = stream_duration if stream_duration else _number(format_data.get("duration"))
    if video:
        if "mov" not in format_name and "mp4" not in format_name:
            raise _invalid("VIDEO_CONTAINER_INVALID", f"容器是 {format_name or '未知'}，只接受 mp4 / mov")
        mime_type = "video/quicktime" if _is_quicktime_brand(format_data) else "video/mp4"
        codec = str(video.get("codec_name", "")).lower()
        metadata = {
            "kind": "video",
            "width": video.get("width"),
            "height": video.get("height"),
            "durationSeconds": duration,
            "frameRate": _frame_rate(video.get("avg_frame_rate") or video.get("r_frame_rate")),
            "videoCodec": "h265" if codec == "hevc" else codec,
        }
        if audio and audio.get("codec_name"):
            metadata["audioCodec"] = str(audio["codec_name"]).lower()
        return "video", mime_type, metadata
    if audio:
        if "wav" in format_name:
            mime_type = "audio/wav"
        elif "mp3" in format_name:
            mime_type = "audio/mpeg"
        else:
            raise _invalid("AUDIO_FORMAT_INVALID", f"格式是 {format_name or '未知'}，只接受 wav / mp3")
        return "audio", mime_type, {
            "kind": "audio",
            "durationSeconds": _stable_audio_duration(duration),
            "audioCodec": str(audio.get("codec_name", "")).lower(),
        }
    raise MediaInspectionError("MEDIA_INSPECTION_FAILED")


def inspect_media(path: str | Path, role: str, slot_id: str) -> dict[str, Any]:
    resolved = Path(path).expanduser().resolve()
    if role not in ROLE_KIND:
        raise MediaInspectionError("MEDIA_ROLE_INVALID")
    if not slot_id or not slot_id.strip():
        raise MediaInspectionError("MEDIA_SLOT_INVALID")
    if not resolved.is_file():
        raise MediaInspectionError("MEDIA_FILE_NOT_FOUND")

    image_result = _inspect_image(resolved)
    if image_result:
        mime_type, metadata = image_result
        kind = "image"
    else:
        kind, mime_type, metadata = _inspect_av(resolved)
    if ROLE_KIND[role] != kind:
        raise MediaInspectionError("MEDIA_ROLE_KIND_MISMATCH")

    size_bytes = resolved.stat().st_size
    _validate(kind, mime_type, size_bytes, metadata)
    descriptor = {
        "slotId": slot_id.strip(),
        "role": role,
        "sha256": sha256_file(resolved),
        "mimeType": mime_type,
        "sizeBytes": size_bytes,
        "metadata": {key: value for key, value in metadata.items() if value is not None and value != ""},
    }
    return {"path": str(resolved), "filename": resolved.name, "descriptor": descriptor}


def read_verified_media(media: dict[str, Any]) -> bytes:
    descriptor = media.get("descriptor") if isinstance(media, dict) else None
    if not isinstance(descriptor, dict):
        raise MediaInspectionError("MEDIA_DESCRIPTOR_INVALID")
    inspected = inspect_media(media.get("path", ""), descriptor.get("role", ""), descriptor.get("slotId", ""))
    if inspected["descriptor"] != descriptor:
        raise MediaInspectionError("MEDIA_CONTENT_CHANGED")
    return Path(inspected["path"]).read_bytes()


def validate_media_collection(media: list[dict[str, Any]]) -> None:
    def total(role: str) -> float:
        return sum(
            float(item.get("descriptor", {}).get("metadata", {}).get("durationSeconds", 0))
            for item in media
            if item.get("descriptor", {}).get("role") == role
        )

    video_total = total("reference_video")
    if video_total > 30:
        raise _invalid("VIDEO_TOTAL_DURATION_INVALID", f"参考视频合计 {_measured(video_total)} 秒，上限 30 秒")
    audio_total = total("reference_audio")
    if audio_total > 30:
        raise _invalid("AUDIO_TOTAL_DURATION_INVALID", f"参考音频合计 {_measured(audio_total)} 秒，上限 30 秒")
