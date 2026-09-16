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
    monkeypatch.setattr(media, "FFPROBE_CANDIDATES", ())
    monkeypatch.delenv("VIDEO_FLOW_FFPROBE", raising=False)

    with pytest.raises(media.MediaInspectionError, match="FFPROBE_NOT_AVAILABLE"):
        media.inspect_media(path, "reference_audio", "audio-1")


def test_ffprobe_lookup_falls_back_to_known_install_locations(tmp_path, monkeypatch):
    # GUI 启动的 ComfyUI 进程 PATH 里没有 /opt/homebrew/bin，只查 PATH 会误报"没装 ffprobe"。
    fake = tmp_path / "ffprobe"
    fake.write_text("#!/bin/sh\n")
    fake.chmod(0o755)
    monkeypatch.setattr(media.shutil, "which", lambda _name: None)
    monkeypatch.setattr(media, "FFPROBE_CANDIDATES", (str(fake),))
    monkeypatch.delenv("VIDEO_FLOW_FFPROBE", raising=False)

    assert media.ffprobe_executable() == str(fake)


def test_ffprobe_lookup_includes_the_manual_drop_in_location():
    """没装包管理器的机器，可以把 ffprobe 直接丢进 `~/.video-flow/`。

    同事机器上真实踩到过 FFPROBE_NOT_AVAILABLE。**让他"设个环境变量"是不现实的**——Comfy
    Desktop 从 GUI 启动，改 .zshrc 里的 PATH 传不进来。所以安装器引导的是一个"丢文件"的落点，
    客户端就必须真的去那儿找；这条断言盯住它别在重构里被删掉。
    """
    from pathlib import Path

    assert str(Path.home() / ".video-flow" / "ffprobe") in media.FFPROBE_CANDIDATES


def test_ffprobe_lookup_prefers_an_explicit_override(tmp_path, monkeypatch):
    chosen = tmp_path / "custom-ffprobe"
    chosen.write_text("#!/bin/sh\n")
    chosen.chmod(0o755)
    monkeypatch.setattr(media.shutil, "which", lambda _name: "/usr/bin/ffprobe")
    monkeypatch.setenv("VIDEO_FLOW_FFPROBE", str(chosen))

    assert media.ffprobe_executable() == str(chosen)

    # 指到了不存在的路径要当作"没有"，而不是静默回落到别的 ffprobe。
    monkeypatch.setenv("VIDEO_FLOW_FFPROBE", str(tmp_path / "missing"))
    assert media.ffprobe_executable() is None


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


def test_video_duration_comes_from_the_stream_not_the_container(tmp_path, monkeypatch):
    """时长必须取流的 duration：容器时长随 ffprobe 版本变化，会让本机与后端对不上。

    真事：同一个 mp4，容器 ffprobe 5.1.9 报 5.077333、8.0.1 报 5.041667，而流的时长两边
    都是 5.041667。预检元数据按内容摘要逐字段比对，用容器时长就会被
    PREFLIGHT_ACTUAL_CONTENT_MISMATCH 拒掉。
    """
    path = tmp_path / "clip.mp4"
    path.write_bytes(b"fake")
    monkeypatch.setattr(media, "_probe", lambda _path: {
        "format": {"duration": "5.077333", "format_name": "mov,mp4,m4a,3gp,3g2,mj2", "tags": {"major_brand": "isom"}},
        "streams": [
            {"codec_type": "video", "width": 1280, "height": 720, "codec_name": "h264",
             "duration": "5.041667", "avg_frame_rate": "24/1"},
            {"codec_type": "audio", "codec_name": "aac", "duration": "5.041667"},
        ],
    })

    item = media.inspect_media(path, "reference_video", "reference-video-1")
    assert item["descriptor"]["metadata"]["durationSeconds"] == 5.041667

@pytest.mark.parametrize("brand,expected", [
    ("qt  ", True),           # ffprobe 8.x：只给主品牌
    ("isom;qt  ", True),      # ffprobe 9.x：把品牌拼成 `;` 列表——同一个文件
    ("isom", False),
    ("mp42", False),
    ("", False),
])
def test_quicktime_brand_survives_ffprobe_brand_lists(brand, expected):
    """判 QuickTime 要按 `;` 拆开比，不能只看开头。

    踩过（同事机真实发生）：随包的 ffprobe 是 9.0.1，同一个 mov 文件它给
    `major_brand = "isom;qt  "`，而服务端 8.x 给 `"qt  "`。客户端用 `startswith("qt")`
    就把前者判成 mp4，与服务端的 quicktime 对不上，正式提交被按 mime 不符拒掉。
    """
    assert media._is_quicktime_brand({"tags": {"major_brand": brand}}) is expected
    assert media._is_quicktime_brand({}) is False
