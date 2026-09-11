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
