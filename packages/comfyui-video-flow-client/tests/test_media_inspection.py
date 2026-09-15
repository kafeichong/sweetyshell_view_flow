import shutil
import subprocess

import pytest
from PIL import Image

import media_inspection as media


def make_image(path, image_format):
    Image.new("RGB", (640, 480), (12, 34, 56)).save(path, format=image_format)


@pytest.mark.parametrize(
    ("image_format", "suffix", "mime_type"),
    [("PNG", ".png", "image/png"), ("JPEG", ".jpg", "image/jpeg"), ("WEBP", ".webp", "image/webp")],
)
def test_inspect_media_reads_real_image_content(image_format, suffix, mime_type, tmp_path):
    path = tmp_path / f"input{suffix}"
    make_image(path, image_format)

    result = media.inspect_media(path, "reference_image", "reference-1")

    assert result["path"] == str(path.resolve())
    assert "data" not in result
    assert result["descriptor"] == {
        "slotId": "reference-1",
        "role": "reference_image",
        "sha256": media.sha256_file(path),
        "mimeType": mime_type,
        "sizeBytes": path.stat().st_size,
        "metadata": {"kind": "image", "width": 640, "height": 480},
    }


def test_inspect_media_uses_content_not_filename_extension(tmp_path):
    path = tmp_path / "pretends-to-be-jpeg.jpg"
    make_image(path, "PNG")

    result = media.inspect_media(path, "first_frame", "first-frame")

    assert result["descriptor"]["mimeType"] == "image/png"


def test_inspect_media_rejects_role_kind_mismatch_and_damaged_content(tmp_path):
    image = tmp_path / "image.png"
    make_image(image, "PNG")
    with pytest.raises(media.MediaInspectionError, match="MEDIA_ROLE_KIND_MISMATCH"):
        media.inspect_media(image, "reference_audio", "audio-1")

    damaged = tmp_path / "damaged.mp4"
    damaged.write_bytes(b"not a media file")
    with pytest.raises(media.MediaInspectionError, match="MEDIA_INSPECTION_FAILED"):
        media.inspect_media(damaged, "reference_video", "video-1")


@pytest.mark.skipif(not shutil.which("ffmpeg") or not shutil.which("ffprobe"), reason="ffmpeg/ffprobe unavailable")
@pytest.mark.parametrize(("suffix", "codec", "mime_type"), [(".mp4", "libx264", "video/mp4"), (".mov", "libx264", "video/quicktime")])
def test_inspect_media_reads_real_video_container_and_streams(suffix, codec, mime_type, tmp_path):
    path = tmp_path / f"clip{suffix}"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=720x576:r=24:d=2", "-c:v", codec, "-pix_fmt", "yuv420p", str(path)],
        check=True,
    )

    descriptor = media.inspect_media(path, "reference_video", "video-1")["descriptor"]

    assert descriptor["mimeType"] == mime_type
    assert descriptor["metadata"] == {
        "kind": "video",
        "width": 720,
        "height": 576,
        "durationSeconds": 2.0,
        "frameRate": 24.0,
        "videoCodec": "h264",
    }


@pytest.mark.parametrize(("format_name", "suffix"), [("matroska,webm", ".webm"), ("matroska", ".mkv")])
def test_inspect_media_rejects_unsupported_video_containers(format_name, suffix, tmp_path, monkeypatch):
    path = tmp_path / f"clip{suffix}"
    path.write_bytes(b"probe fixture")
    monkeypatch.setattr(media, "_inspect_image", lambda _path: None)
    monkeypatch.setattr(media, "_probe", lambda _path: {
        "format": {"format_name": format_name, "duration": "5"},
        "streams": [{
            "codec_type": "video", "width": 1280, "height": 720,
            "codec_name": "h264", "avg_frame_rate": "24/1",
        }],
    })

    with pytest.raises(media.MediaInspectionError, match="VIDEO_CONTAINER_INVALID"):
        media.inspect_media(path, "reference_video", "video-1")


@pytest.mark.skipif(not shutil.which("ffmpeg") or not shutil.which("ffprobe"), reason="ffmpeg/ffprobe unavailable")
@pytest.mark.parametrize(("suffix", "mime_type"), [(".wav", "audio/wav"), (".mp3", "audio/mpeg")])
def test_inspect_media_reads_real_audio_duration_and_codec(suffix, mime_type, tmp_path):
    path = tmp_path / f"audio{suffix}"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", str(path)],
        check=True,
    )

    descriptor = media.inspect_media(path, "reference_audio", "audio-1")["descriptor"]

    assert descriptor["mimeType"] == mime_type
    assert descriptor["metadata"]["kind"] == "audio"
    assert descriptor["metadata"]["durationSeconds"] == pytest.approx(2.0, abs=0.001)
    assert descriptor["metadata"]["audioCodec"] in {"pcm_s16le", "mp3"}


def test_read_verified_media_rejects_same_filename_after_content_changes(tmp_path):
    path = tmp_path / "same.png"
    make_image(path, "PNG")
    inspected = media.inspect_media(path, "reference_image", "reference-1")
    Image.new("RGB", (640, 480), (99, 88, 77)).save(path, format="PNG")

    with pytest.raises(media.MediaInspectionError, match="MEDIA_CONTENT_CHANGED"):
        media.read_verified_media(inspected)


def test_non_image_inspection_reports_missing_ffprobe_explicitly(tmp_path, monkeypatch):
    path = tmp_path / "audio.wav"
    path.write_bytes(b"RIFF-not-enough")
    monkeypatch.setattr(media.shutil, "which", lambda _name: None)

    with pytest.raises(media.MediaInspectionError, match="FFPROBE_NOT_AVAILABLE"):
        media.inspect_media(path, "reference_audio", "audio-1")


def test_validate_media_collection_rejects_video_and_audio_totals_above_30_seconds():
    def item(role, duration):
        return {"descriptor": {"role": role, "metadata": {"kind": role.removeprefix("reference_"), "durationSeconds": duration}}}

    with pytest.raises(media.MediaInspectionError, match="VIDEO_TOTAL_DURATION_INVALID"):
        media.validate_media_collection([item("reference_video", 16), item("reference_video", 15)])
    with pytest.raises(media.MediaInspectionError, match="AUDIO_TOTAL_DURATION_INVALID"):
        media.validate_media_collection([item("reference_audio", 20), item("reference_audio", 11)])
    media.validate_media_collection([item("reference_video", 12.25), item("reference_video", 17.75), item("reference_audio", 30)])


def test_video_and_audio_size_allow_inclusive_limits_while_image_limit_is_exclusive(tmp_path, monkeypatch):
    path = tmp_path / "boundary.bin"
    with path.open("wb") as output:
        output.seek(200 * 1024 * 1024 - 1)
        output.write(b"\0")
    monkeypatch.setattr(media, "_inspect_image", lambda _path: None)
    monkeypatch.setattr(media, "_inspect_av", lambda _path: (
        "video", "video/mp4", {
            "kind": "video", "width": 1280, "height": 720,
            "durationSeconds": 2.0, "frameRate": 24.0, "videoCodec": "h264",
        },
    ))
    monkeypatch.setattr(media, "sha256_file", lambda _path: "a" * 64)

    assert media.inspect_media(path, "reference_video", "video-1")["descriptor"]["sizeBytes"] == 200 * 1024 * 1024
    with pytest.raises(media.MediaInspectionError, match="IMAGE_SIZE_INVALID"):
        media._validate("image", "image/png", 30 * 1024 * 1024, {"width": 640, "height": 480})
    media._validate("audio", "audio/wav", 15 * 1024 * 1024, {"durationSeconds": 2})
