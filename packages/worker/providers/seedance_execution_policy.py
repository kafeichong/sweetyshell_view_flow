"""Compile only Backend-frozen Seedance plans matching the shared v2 contract."""

import hashlib
import json
from pathlib import Path
from typing import Any, Dict, List


_CONTRACT_PATH = Path(__file__).resolve().parents[1] / "resources" / "seedance-workflows.v2.json"
_CONTRACT: Dict[str, Any] = json.loads(_CONTRACT_PATH.read_text(encoding="utf-8"))


def workflow_execution_digest(contract: Dict[str, Any]) -> str:
    execution_contract = {
        "schemaVersion": contract["schemaVersion"],
        "provider": contract["provider"],
        "model": {"id": contract["model"]["id"]},
        "workflows": [
            {
                "key": workflow["key"],
                "capability": workflow["state"]["capability"],
                "media": workflow["media"],
                "generation": workflow["generation"],
                "providerFields": workflow.get("providerFields", {}),
            }
            for workflow in contract["workflows"]
        ],
    }
    return hashlib.sha256(
        json.dumps(execution_contract, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


_CONTRACT_DIGEST = workflow_execution_digest(_CONTRACT)
_WORKFLOWS = {item["key"]: item for item in _CONTRACT["workflows"]}

_ROLE_URL_FIELDS = {
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


def _validate_frozen_contract(params: Dict[str, Any]) -> Dict[str, Any]:
    if _required_string(params, "contract_digest") != _CONTRACT_DIGEST:
        raise ValueError("Seedance execution plan contract digest does not match Worker contract")
    _required_string(params, "workflow_version")
    if _required_string(params, "model") != _CONTRACT["model"]["id"]:
        raise ValueError("Seedance execution plan model does not match Worker contract")
    workflow_key = _required_string(params, "workflow_key")
    workflow = _WORKFLOWS.get(workflow_key)
    if not workflow:
        raise ValueError(f"Seedance unsupported workflow {workflow_key}")
    if workflow["state"]["capability"] != "confirmed":
        raise ValueError(f"Seedance workflow capability is not confirmed: {workflow_key}")
    return workflow


def _validate_generation(params: Dict[str, Any], workflow: Dict[str, Any]) -> None:
    generation = workflow["generation"]
    duration = params.get("duration")
    policy = generation["productDuration"]
    if not isinstance(duration, int) or isinstance(duration, bool):
        raise ValueError("Seedance workflow duration must be an integer")
    if policy["kind"] == "fixed":
        if duration != policy["value"]:
            raise ValueError(f"Seedance workflow requires duration {policy['value']}")
    elif duration < policy["minimum"] or duration > policy["maximum"]:
        raise ValueError(
            f"Seedance workflow duration must be between {policy['minimum']} and {policy['maximum']} seconds"
        )
    if params.get("ratio") not in generation["ratios"]:
        raise ValueError("Seedance workflow ratio is not allowed")
    if params.get("resolution") not in generation["resolutions"]:
        raise ValueError("Seedance workflow resolution is not allowed")
    if params.get("output_format") not in generation["outputFormats"]:
        raise ValueError("Seedance workflow output format is not allowed")
    for field in ("generate_audio", "watermark"):
        if not isinstance(params.get(field), bool):
            raise ValueError(f"Seedance execution plan requires boolean {field}")


def _validate_provider_fields(params: Dict[str, Any], workflow: Dict[str, Any]) -> Dict[str, Any]:
    expected = workflow.get("providerFields", {})
    for field, value in expected.items():
        if params.get(field) != value:
            raise ValueError(f"Seedance workflow requires {field} {value}")
    known_fields = {field for item in _WORKFLOWS.values() for field in item.get("providerFields", {})}
    for field in known_fields - set(expected):
        if params.get(field) is not None:
            raise ValueError(f"Seedance workflow does not allow {field}")
    return dict(expected)


def _compile_content(prompt: str, media_urls: List[Dict[str, Any]], workflow: Dict[str, Any]) -> List[Dict[str, Any]]:
    media_policy = workflow["media"]
    if not media_policy["minimumTotal"] <= len(media_urls) <= media_policy["maximumTotal"]:
        raise ValueError("Seedance workflow has invalid media count")
    limits = {item["role"]: (item["minimum"], item["maximum"]) for item in media_policy["roles"]}
    counts = {role: 0 for role in limits}
    ordered_roles = media_policy.get("orderedRoles")
    content: List[Dict[str, Any]] = [{"type": "text", "text": prompt}]
    for index, item in enumerate(media_urls):
        if not isinstance(item, dict):
            raise ValueError("Seedance media item must be an object")
        role = item.get("role")
        url = item.get("url")
        if role not in limits:
            raise ValueError(f"Seedance workflow does not allow role {role}")
        if ordered_roles is not None and (index >= len(ordered_roles) or ordered_roles[index] != role):
            raise ValueError("Seedance workflow media order is invalid")
        if not isinstance(url, str) or not url.strip():
            raise ValueError("Seedance media item requires a URL")
        counts[role] += 1
        content_type, url_field = _ROLE_URL_FIELDS[role]
        content.append({"type": content_type, url_field: {"url": url.strip()}, "role": role})
    for role, (minimum, maximum) in limits.items():
        if not minimum <= counts[role] <= maximum:
            raise ValueError(f"Seedance workflow has invalid count for role {role}")
    return content


def compile_seedance_payload(params: Dict[str, Any]) -> Dict[str, Any]:
    """Turn a URL-resolved Backend execution snapshot into the sole Ark payload."""
    workflow = _validate_frozen_contract(params)
    _validate_generation(params, workflow)
    provider_fields = _validate_provider_fields(params, workflow)
    prompt = _required_string(params, "prompt")
    media_urls = params.get("media_urls")
    if not isinstance(media_urls, list):
        raise ValueError("Seedance execution plan requires media_urls")
    return {
        "model": _CONTRACT["model"]["id"],
        "content": _compile_content(prompt, media_urls, workflow),
        "generate_audio": params["generate_audio"],
        "ratio": params["ratio"],
        "duration": params["duration"],
        "watermark": params["watermark"],
        "resolution": params["resolution"],
        "output_format": params["output_format"],
        **provider_fields,
    }
