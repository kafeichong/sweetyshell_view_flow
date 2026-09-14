import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from providers.seedance_execution_policy import compile_seedance_payload  # noqa: E402


def _params(**overrides):
    value = {
        "workflow_key": "seedance.reference-image-to-video.v1",
        "workflow_version": "v1",
        "model": "doubao-seedance-2-5-260628",
        "prompt": "product orbit",
        "media_urls": [{"url": "https://example.invalid/product.png", "role": "reference_image"}],
        "duration": 5,
        "ratio": "16:9",
        "resolution": "720p",
        "generate_audio": False,
        "watermark": True,
    }
    value.update(overrides)
    return value


def test_reference_image_payload_is_a_direct_official_shape():
    assert compile_seedance_payload(_params()) == {
        "model": "doubao-seedance-2-5-260628",
        "content": [
            {"type": "text", "text": "product orbit"},
            {
                "type": "image_url",
                "image_url": {"url": "https://example.invalid/product.png"},
                "role": "reference_image",
            },
        ],
        "generate_audio": False,
        "ratio": "16:9",
        "duration": 5,
        "watermark": True,
        "resolution": "720p",
    }


def test_first_and_last_frames_keep_their_explicit_roles_and_order():
    payload = compile_seedance_payload(_params(
        workflow_key="seedance.first-last-frame-to-video.v1",
        ratio="adaptive",
        media_urls=[
            {"url": "https://example.invalid/first.png", "role": "first_frame"},
            {"url": "https://example.invalid/last.png", "role": "last_frame"},
        ],
    ))
    assert payload["content"][1:] == [
        {"type": "image_url", "image_url": {"url": "https://example.invalid/first.png"}, "role": "first_frame"},
        {"type": "image_url", "image_url": {"url": "https://example.invalid/last.png"}, "role": "last_frame"},
    ]
    with pytest.raises(ValueError, match="invalid count for role"):
        compile_seedance_payload(_params(
            workflow_key="seedance.first-last-frame-to-video.v1", ratio="adaptive",
            media_urls=[
                {"url": "https://example.invalid/first-a.png", "role": "first_frame"},
                {"url": "https://example.invalid/first-b.png", "role": "first_frame"},
            ],
        ))


def test_edit_payload_requires_frozen_special_fields():
    payload = compile_seedance_payload(_params(
        workflow_key="seedance.video-edit.v1",
        prompt="remove everyone except the hero from @video1",
        media_urls=[{"url": "https://example.invalid/input.mp4", "role": "reference_video"}],
        ratio="adaptive",
        duration=-1,
        omni_reference_task_type="edit",
        output_format="mov",
    ))
    assert payload["content"][1] == {
        "type": "video_url", "video_url": {"url": "https://example.invalid/input.mp4"}, "role": "reference_video",
    }
    assert payload["omni_reference_task_type"] == "edit"
    assert payload["output_format"] == "mov"


@pytest.mark.parametrize(
    "mutate, message",
    [
        ({"workflow_key": "seedance.unknown.v1"}, "unsupported workflow"),
        ({"media_urls": [{"url": "https://example.invalid/input.mp4", "role": "reference_video"}]}, "does not allow role"),
        ({"workflow_key": "seedance.video-edit.v1", "ratio": "16:9", "duration": -1, "media_urls": [{"url": "https://example.invalid/input.mp4", "role": "reference_video"}], "omni_reference_task_type": "edit", "output_format": "mov"}, "requires ratio adaptive"),
        ({"workflow_key": "seedance.video-edit.v1", "ratio": "adaptive", "duration": -1, "media_urls": [{"url": "https://example.invalid/input.mp4", "role": "reference_video"}], "omni_reference_task_type": "extend", "output_format": "mov"}, "requires omni_reference_task_type edit"),
    ],
)
def test_compiler_rejects_unknown_or_conflicting_frozen_intent(mutate, message):
    with pytest.raises(ValueError, match=message):
        compile_seedance_payload(_params(**mutate))
