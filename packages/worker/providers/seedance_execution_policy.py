"""Compile an approved Video Flow execution plan into an Ark Seedance payload.

This module deliberately accepts only the Backend-frozen workflow intent.  It
does not infer task type from a prompt or a media combination, and it performs
no network I/O so every supported shape is testable against sanitized fixtures.
"""

from typing import Any, Dict, List, Tuple


WorkflowPolicy = Dict[str, Any]


WORKFLOW_POLICIES: Dict[str, WorkflowPolicy] = {
    "seedance.reference-image-to-video.v1": {
        "roles": ("reference_image",), "role_limits": {"reference_image": (1, 1)}, "min_media": 1, "max_media": 1,
    },
    "seedance.first-frame-to-video.v1": {
        "roles": ("first_frame",), "role_limits": {"first_frame": (1, 1)}, "min_media": 1, "max_media": 1, "ratio": "adaptive",
    },
    "seedance.first-last-frame-to-video.v1": {
        "roles": ("first_frame", "last_frame"), "role_limits": {"first_frame": (1, 1), "last_frame": (1, 1)}, "min_media": 2, "max_media": 2, "ratio": "adaptive",
    },
    "seedance.omni-reference.v1": {
        "roles": ("reference_image", "reference_video", "reference_audio"), "role_limits": {"reference_image": (0, 30), "reference_video": (0, 10), "reference_audio": (0, 10)}, "min_media": 1, "max_media": 50,
        "omni_reference_task_type": "reference", "output_format": "mov",
    },
    "seedance.video-edit.v1": {
        "roles": ("reference_video",), "role_limits": {"reference_video": (1, 10)}, "min_media": 1, "max_media": 10, "ratio": "adaptive", "duration": -1,
        "omni_reference_task_type": "edit", "output_format": "mov",
    },
    "seedance.video-extend.v1": {
        "roles": ("reference_video",), "role_limits": {"reference_video": (1, 10)}, "min_media": 1, "max_media": 10, "ratio": "adaptive",
        "omni_reference_task_type": "extend", "output_format": "mov",
    },
}

ROLE_TYPES: Dict[str, Tuple[str, str]] = {
    "reference_image": ("image_url", "image_url"),
    "first_frame": ("image_url", "image_url"),
    "last_frame": ("image_url", "image_url"),
    "reference_video": ("video_url", "video_url"),
    "reference_audio": ("audio_url", "audio_url"),
}


def _required_string(params: Dict[str, Any], name: str) -> str:
    value = params.get(name)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"Seedance execution plan requires {name}")
    return value.strip()


def _validate_special_fields(params: Dict[str, Any], policy: WorkflowPolicy) -> None:
    for field in ("ratio", "duration", "omni_reference_task_type", "output_format"):
        expected = policy.get(field)
        actual = params.get(field)
        if expected is not None and actual != expected:
            raise ValueError(f"Seedance workflow requires {field} {expected}")
        if expected is None and actual is not None and field in ("omni_reference_task_type", "output_format"):
            raise ValueError(f"Seedance workflow does not allow {field}")


def _compile_content(prompt: str, media_urls: List[Dict[str, Any]], policy: WorkflowPolicy) -> List[Dict[str, Any]]:
    if not policy["min_media"] <= len(media_urls) <= policy["max_media"]:
        raise ValueError("Seedance workflow has invalid media count")
    content: List[Dict[str, Any]] = [{"type": "text", "text": prompt}]
    allowed_roles = policy["roles"]
    role_counts = {role: 0 for role in allowed_roles}
    previous_role_index = -1
    for item in media_urls:
        if not isinstance(item, dict):
            raise ValueError("Seedance media item must be an object")
        role = item.get("role")
        url = item.get("url")
        if role not in allowed_roles:
            raise ValueError(f"Seedance workflow does not allow role {role}")
        if not isinstance(url, str) or not url.strip():
            raise ValueError("Seedance media item requires a URL")
        role_index = allowed_roles.index(role)
        if role_index < previous_role_index:
            raise ValueError("Seedance workflow media order is invalid")
        previous_role_index = role_index
        role_counts[role] += 1
        content_type, url_field = ROLE_TYPES[role]
        content.append({"type": content_type, url_field: {"url": url}, "role": role})
    for role, (minimum, maximum) in policy["role_limits"].items():
        if not minimum <= role_counts[role] <= maximum:
            raise ValueError(f"Seedance workflow has invalid count for role {role}")
    return content


def compile_seedance_payload(params: Dict[str, Any]) -> Dict[str, Any]:
    """Turn a Backend-approved, URL-resolved execution plan into Ark JSON."""
    workflow_key = _required_string(params, "workflow_key")
    policy = WORKFLOW_POLICIES.get(workflow_key)
    if not policy:
        raise ValueError(f"Seedance unsupported workflow {workflow_key}")
    _validate_special_fields(params, policy)
    prompt = _required_string(params, "prompt")
    media_urls = params.get("media_urls")
    if not isinstance(media_urls, list):
        raise ValueError("Seedance execution plan requires media_urls")
    payload: Dict[str, Any] = {
        "model": _required_string(params, "model"),
        "content": _compile_content(prompt, media_urls, policy),
        "generate_audio": params.get("generate_audio", False),
        "ratio": params.get("ratio"),
        "duration": params.get("duration"),
        "watermark": params.get("watermark", False),
    }
    resolution = params.get("resolution")
    if isinstance(resolution, str) and resolution:
        payload["resolution"] = resolution
    for field in ("omni_reference_task_type", "output_format"):
        if field in policy:
            payload[field] = policy[field]
    return payload
