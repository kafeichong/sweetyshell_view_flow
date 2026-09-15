"""Read-only local media inspection shared by Video Flow ComfyUI nodes."""

from __future__ import annotations

import hashlib
import json
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


def _validate(kind: str, mime_type: str, size_bytes: int, metadata: dict[str, Any]) -> None:
    if size_bytes <= 0 or (size_bytes >= MAX_SIZE[kind] if kind == "image" else size_bytes > MAX_SIZE[kind]):
        raise MediaInspectionError(f"{kind.upper()}_SIZE_INVALID")
    if kind in {"image", "video"}:
        width = metadata.get("width")
        height = metadata.get("height")
        if not isinstance(width, int) or not isinstance(height, int) or not (300 <= width <= 6000 and 300 <= height <= 6000):
            raise MediaInspectionError(f"{kind.upper()}_DIMENSIONS_INVALID")
        if not 0.4 <= width / height <= 2.5:
            raise MediaInspectionError(f"{kind.upper()}_ASPECT_RATIO_INVALID")
    if kind == "video":
        pixels = metadata["width"] * metadata["height"]
        if not 407696 <= pixels <= 8295044:
            raise MediaInspectionError("VIDEO_PIXELS_INVALID")
        if not 2 <= metadata.get("durationSeconds", 0) <= 30:
            raise MediaInspectionError("VIDEO_DURATION_INVALID")
        if not 24 <= metadata.get("frameRate", 0) <= 60:
            raise MediaInspectionError("VIDEO_FRAME_RATE_INVALID")
        if metadata.get("videoCodec") not in {"h264", "h265", "hevc"}:
            raise MediaInspectionError("VIDEO_CODEC_INVALID")
        if mime_type not in {"video/mp4", "video/quicktime"}:
            raise MediaInspectionError("VIDEO_CONTAINER_INVALID")
    if kind == "audio":
        if not 2 <= metadata.get("durationSeconds", 0) <= 30:
            raise MediaInspectionError("AUDIO_DURATION_INVALID")
        if mime_type not in {"audio/wav", "audio/mpeg"}:
            raise MediaInspectionError("AUDIO_FORMAT_INVALID")


def _inspect_image(path: Path) -> tuple[str, dict[str, Any]] | None:
    try:
        with Image.open(path) as image:
            image.load()
            mime_type = IMAGE_MIME.get(image.format or "")
            if not mime_type or getattr(image, "n_frames", 1) != 1:
                raise MediaInspectionError("IMAGE_FORMAT_INVALID")
            width, height = image.size
            return mime_type, {"kind": "image", "width": width, "height": height}
    except UnidentifiedImageError:
        return None
    except OSError as error:
        raise MediaInspectionError("MEDIA_INSPECTION_FAILED") from error


def _probe(path: Path) -> dict[str, Any]:
    executable = shutil.which("ffprobe")
    if not executable:
        raise MediaInspectionError("FFPROBE_NOT_AVAILABLE")
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


def _inspect_av(path: Path) -> tuple[str, str, dict[str, Any]]:
    probe = _probe(path)
    streams = probe.get("streams") if isinstance(probe.get("streams"), list) else []
    video = next((stream for stream in streams if stream.get("codec_type") == "video"), None)
    audio = next((stream for stream in streams if stream.get("codec_type") == "audio"), None)
    format_data = probe.get("format") if isinstance(probe.get("format"), dict) else {}
    format_name = str(format_data.get("format_name", "")).lower()
    duration = _number(format_data.get("duration"))
    if video:
        if "mov" not in format_name and "mp4" not in format_name:
            raise MediaInspectionError("VIDEO_CONTAINER_INVALID")
        brand = str((format_data.get("tags") or {}).get("major_brand", "")).strip().lower()
        mime_type = "video/quicktime" if brand.startswith("qt") else "video/mp4"
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
            raise MediaInspectionError("AUDIO_FORMAT_INVALID")
        return "audio", mime_type, {
            "kind": "audio",
            "durationSeconds": duration,
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

    if total("reference_video") > 30:
        raise MediaInspectionError("VIDEO_TOTAL_DURATION_INVALID")
    if total("reference_audio") > 30:
        raise MediaInspectionError("AUDIO_TOTAL_DURATION_INVALID")
