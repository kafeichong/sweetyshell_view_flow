import hashlib
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from providers.seedance_execution_policy import compile_seedance_payload  # noqa: E402


CONTRACT = json.loads((Path(__file__).resolve().parents[1] / "resources" / "seedance-workflows.v2.json").read_text())
CONTRACT_DIGEST = hashlib.sha256(
    json.dumps({
        "schemaVersion": CONTRACT["schemaVersion"],
        "provider": CONTRACT["provider"],
        "model": {"id": CONTRACT["model"]["id"]},
        "workflows": [{
            "key": workflow["key"],
            "capability": workflow["state"]["capability"],
            "media": workflow["media"],
            "generation": workflow["generation"],
            "providerFields": workflow.get("providerFields", {}),
        } for workflow in CONTRACT["workflows"]],
    }, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
).hexdigest()


def _params(**overrides):
    value = {
        "workflow_key": "seedance.reference-image-to-video.v1",
        "workflow_version": CONTRACT["contractRevision"],
        "contract_digest": CONTRACT_DIGEST,
        "model": "doubao-seedance-2-5-260628",
        "prompt": "product orbit",
        "media_urls": [{"url": "https://example.invalid/product.png", "role": "reference_image"}],
        "duration": 5,
        "ratio": "16:9",
        "resolution": "720p",
        "generate_audio": False,
        "watermark": True,
        "output_format": "mp4",
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
        "output_format": "mp4",
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
    with pytest.raises(ValueError, match="media order"):
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


def test_text_to_video_accepts_exact_four_and_thirty_second_boundaries():
    for duration in (4, 30):
        payload = compile_seedance_payload(_params(
            workflow_key="seedance.text-to-video.v1",
            media_urls=[],
            duration=duration,
        ))
        assert payload["duration"] == duration
        assert payload["content"] == [{"type": "text", "text": "product orbit"}]


@pytest.mark.parametrize("duration", [3, 31])
def test_text_to_video_rejects_duration_outside_the_frozen_contract(duration):
    with pytest.raises(ValueError, match="duration"):
        compile_seedance_payload(_params(
            workflow_key="seedance.text-to-video.v1",
            media_urls=[],
            duration=duration,
        ))


@pytest.mark.parametrize(
    "mutate,message",
    [
        ({"contract_digest": "0" * 64}, "contract digest"),
        ({"workflow_version": ""}, "workflow_version"),
        ({"model": "client-selected-model"}, "model"),
    ],
)
def test_compiler_rejects_a_snapshot_that_does_not_match_its_contract(mutate, message):
    with pytest.raises(ValueError, match=message):
        compile_seedance_payload(_params(**mutate))


@pytest.mark.parametrize(
    "mutate, message",
    [
        ({"workflow_key": "seedance.unknown.v1"}, "unsupported workflow"),
        ({"media_urls": [{"url": "https://example.invalid/input.mp4", "role": "reference_video"}]}, "does not allow role"),
        ({"workflow_key": "seedance.video-edit.v1", "ratio": "16:9", "duration": -1, "media_urls": [{"url": "https://example.invalid/input.mp4", "role": "reference_video"}], "omni_reference_task_type": "edit", "output_format": "mov"}, "ratio is not allowed"),
        ({"workflow_key": "seedance.video-edit.v1", "ratio": "adaptive", "duration": -1, "media_urls": [{"url": "https://example.invalid/input.mp4", "role": "reference_video"}], "omni_reference_task_type": "extend", "output_format": "mov"}, "requires omni_reference_task_type edit"),
    ],
)
def test_compiler_rejects_unknown_or_conflicting_frozen_intent(mutate, message):
    with pytest.raises(ValueError, match=message):
        compile_seedance_payload(_params(**mutate))
