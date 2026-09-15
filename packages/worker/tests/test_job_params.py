import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from models import Job  # noqa: E402


def _job(**overrides):
    payload = {
        "id": "task-1",
        "status": "pending",
        "createdBy": "alice",
        "prompt": "product on water",
        "createdAt": "2026-09-10T00:00:00.000Z",
    }
    payload.update(overrides)
    return Job(**payload)


def test_v1_request_snapshot_params_are_forwarded():
    """v1 的 params 必须透传，否则 image_asset_id 会被静默丢弃。"""
    job = _job(
        requestSnapshot={
            "capability": "IMAGE_TO_VIDEO",
            "profile": "seedance",
            "params": {
                "prompt": "product on water",
                "image_asset_id": "asset-1",
                "ratio": "9:16",
                "duration": 8,
            },
        },
    )

    params = job.get_params()

    assert params["image_asset_id"] == "asset-1"
    assert params["ratio"] == "9:16"
    assert params["duration"] == 8


def test_legacy_task_falls_back_to_prompt_and_image_url():
    job = _job(imageUrl="https://example.com/a.png")

    assert job.get_params() == {
        "prompt": "product on water",
        "image_url": "https://example.com/a.png",
    }


def test_snapshot_params_win_over_legacy_image_url():
    job = _job(
        imageUrl="https://example.com/legacy.png",
        requestSnapshot={"params": {"image_url": "https://example.com/v1.png"}},
    )

    assert job.get_params()["image_url"] == "https://example.com/v1.png"


def test_recovery_job_preserves_backend_execution_and_delivery_contract():
    job = _job(
        taskStatus="in_progress",
        deliveryStatus="archiving",
        executionPlan={
            "version": "mvp-v1",
            "model": "doubao-seedance-2-5-260628",
            "duration": 5,
            "ratio": "16:9",
        },
        providerTaskId="provider-1",
        attemptId="attempt-1",
    )

    assert job.taskStatus == "in_progress"
    assert job.deliveryStatus == "archiving"
    assert job.executionPlan["model"] == "doubao-seedance-2-5-260628"
    assert job.providerTaskId == "provider-1"


def test_execution_plan_freezes_provider_parameters():
    job = _job(
        requestSnapshot={
            "params": {
                "prompt": "client prompt",
                "image_asset_id": "untrusted-asset",
                "duration": 60,
                "ratio": "9:16",
            }
        },
        executionPlan={
            "specVersion": "test-v1",
            "pricingVersion": "test-price-v1",
            "model": "test-model",
            "prompt": "approved prompt",
            "imageAssetId": "approved-asset",
            "duration": 5,
            "ratio": "16:9",
            "resolution": "test-resolution",
            "generateAudio": False,
            "watermark": True,
        },
    )

    assert job.get_params() == {
        "prompt": "approved prompt",
        "image_asset_id": "approved-asset",
        "model": "test-model",
        "duration": 5,
        "ratio": "16:9",
        "resolution": "test-resolution",
        "generate_audio": False,
        "watermark": True,
    }



def test_execution_plan_uses_structured_media_roles():
    job = _job(
        executionPlan={
            "workflowKey": "seedance.reference-image-to-video.v1",
            "workflowVersion": "v1",
            "model": "test-model",
            "prompt": "approved prompt",
            "media": [{"assetId": "asset-reference", "role": "reference_image"}],
            "duration": 5,
            "ratio": "16:9",
            "resolution": "720p",
            "generateAudio": False,
            "watermark": True,
        },
    )

    assert job.get_params()["media"] == [{"asset_id": "asset-reference", "role": "reference_image"}]


def test_execution_plan_preserves_frozen_workflow_and_provider_fields():
    job = _job(
        executionPlan={
            "contractDigest": "contract-digest",
            "workflowKey": "seedance.video-extend.v1",
            "workflowVersion": "v1",
            "model": "test-model",
            "prompt": "extend @video1",
            "media": [{"assetId": "video-1", "role": "reference_video"}],
            "duration": 11,
            "ratio": "adaptive",
            "resolution": "720p",
            "generateAudio": True,
            "watermark": False,
            "omni_reference_task_type": "extend",
            "outputFormat": "mov",
        },
    )

    assert job.get_params() == {
        "prompt": "extend @video1",
        "media": [{"asset_id": "video-1", "role": "reference_video"}],
        "model": "test-model",
        "duration": 11,
        "ratio": "adaptive",
        "resolution": "720p",
        "generate_audio": True,
        "watermark": False,
        "workflow_key": "seedance.video-extend.v1",
        "workflow_version": "v1",
        "contract_digest": "contract-digest",
        "omni_reference_task_type": "extend",
        "output_format": "mov",
    }
