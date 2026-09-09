"""Conservative capability profiles for provider/model routing.

Unknown or unverified capabilities intentionally remain ``pending`` and are
not treated as production-enabled features.
"""

from copy import deepcopy
from typing import Any, Dict


_PROFILES: Dict[tuple[str, str], Dict[str, Any]] = {
    ("seedance", "doubao-seedance-2-0-260128"): {
        "provider": "seedance",
        "model": "doubao-seedance-2-0-260128",
        "status": "confirmed",
        "capabilities": {
            "text_to_video": "confirmed",
            "first_frame_i2v": "confirmed",
            "multi_image": "confirmed",
            "reference_video": "confirmed",
            "reference_audio": "confirmed",
            "generated_audio": "confirmed",
            "last_frame": "confirmed",
            "callback": "confirmed",
        },
        "limits": {
            "duration_seconds": {"min": 4, "max": 15},
            "camera_fixed_in_reference_image": "unsupported",
        },
    },
    ("seedance", "doubao-seedance-2-5-260628"): {
        "provider": "seedance",
        "model": "doubao-seedance-2-5-260628",
        "status": "pending",
        "capabilities": {
            "text_to_video": "pending",
            "first_frame_i2v": "pending",
            "multi_image": "pending",
            "reference_video": "pending",
            "reference_audio": "pending",
            "generated_audio": "pending",
            "last_frame": "pending",
            "callback": "pending",
        },
        "limits": {},
    },
    ("minimax", "MiniMax-Hailuo-2.3"): {
        "provider": "minimax",
        "model": "MiniMax-Hailuo-2.3",
        "status": "confirmed",
        "capabilities": {
            "text_to_video": "confirmed",
            "first_frame_i2v": "confirmed",
            "multi_image": "pending",
            "reference_video": "pending",
            "reference_audio": "pending",
            "generated_audio": "pending",
            "last_frame": "pending",
            "callback": "pending",
        },
        "limits": {
            "first_frame_image": {
                "accepted_source": ["public_url", "data_url"],
                "max_bytes": 20 * 1024 * 1024,
                "min_short_edge_px": 300,
                "aspect_ratio": {"min": 2 / 5, "max": 5 / 2},
            },
        },
        "notes": "Legacy Hailuo-2.3 v1 API: flat first_frame_image field. Use MiniMax-H3 for multimodal reference (image+video) workflows.",
    },
    ("minimax", "MiniMax-H3"): {
        "provider": "minimax",
        "model": "MiniMax-H3",
        "status": "confirmed",
        "capabilities": {
            "text_to_video": "confirmed",
            "first_frame_i2v": "confirmed",
            "last_frame": "confirmed",
            "multi_image": "confirmed",
            "reference_video": "confirmed",
            "reference_audio": "confirmed",
            "generated_audio": "pending",
            "callback": "confirmed",
        },
        "limits": {
            "endpoint": "/v2/video_generation",
            "modes": {
                "t2va": "text only; ratio required and must not be adaptive",
                "i2va": "text + 0..2 first/last frame images; ratio is always adaptive",
                "r2va": "text + reference images/videos/audio; image+video merge lives here",
            },
            "modes_mutually_exclusive": "first_frame/last_frame roles cannot mix with reference_* roles in one request",
            "duration_seconds": {"min": 4, "max": 15, "integer_only": True},
            "resolution": ["768P", "2K"],
            "max_prompt_chars": 7000,
            "max_request_bytes": 64 * 1024 * 1024,
            "image": {
                "max_count": 9,
                "max_bytes": 30 * 1024 * 1024,
                "side_px": {"min": 256, "max": 5760},
                "aspect_ratio": {"min": 0.4, "max": 2.5},
                "accepted_source": ["public_url", "data_url"],
            },
            "video": {
                "max_count": 3,
                "max_bytes": 50 * 1024 * 1024,
                "clip_seconds": {"min": 2, "max": 15},
                "total_seconds": 15,
                "accepted_source": ["public_url", "data_url"],
            },
            "audio": {
                "max_count": 3,
                "max_bytes": 15 * 1024 * 1024,
                "clip_seconds": {"min": 2, "max": 15},
                "total_seconds": 15,
                "accepted_source": ["public_url", "data_url"],
            },
            "total_files": 12,
        },
        "evidence": [
            "https://platform.minimaxi.com/docs/guides/video-generation",
            "https://platform.minimaxi.com/docs/api-reference/video-generation-v2-create",
        ],
        "notes": "H3 = Hailuo 3.0. Multimodal content[] + role model. r2va supports up to 9 reference images + 3 reference videos + 3 reference audio in one request (image+video merge). Real-face content is subject to platform moderation (422/1026); no API-level person-verification gate exists.",
    },
}


def get_capability_profile(provider: str, model: str) -> Dict[str, Any]:
    profile = _PROFILES.get((provider.strip().lower(), model.strip()))
    if profile is None:
        raise ValueError(f"No capability profile registered for {provider}/{model}")
    return deepcopy(profile)
