from __future__ import annotations

import json
from pathlib import Path
from typing import Any


class ComfyUIWorkflowError(ValueError):
    """Raised when a ComfyUI workflow or history payload is unsafe or invalid."""


_LEGACY_REQUIRED_NODE_TYPES = {
    "SeedanceArkExecutionPolicy",
    "SeedanceArkRequestBuilder",
    "SeedanceArkRequestPreview",
    "SeedanceArkCreateTask",
    "SeedanceArkWaitTask",
    "SeedanceArkDownloadVideo",
    "SeedanceArkPreviewSaveVideo",
}
_REFERENCE_EDIT_REQUIRED_NODE_TYPES = {
    "SeedanceArkExecutionPolicy",
    "SeedanceArkMediaInput",
    "SeedanceArkMediaValidator",
    "SeedanceArkUploadImage",
    "SeedanceArkUploadVideo",
    "SeedanceArkReferenceEditRequestBuilder",
    "SeedanceArkReferenceEditRequestPreview",
    "SeedanceArkReferenceEditCreateTask",
    "SeedanceArkWaitTask",
    "SeedanceArkDownloadVideo",
    "SeedanceArkPreviewSaveVideo",
}
_FIRST_LAST_FRAME_REQUIRED_NODE_TYPES = {
    "SeedanceArkExecutionPolicy",
    "SeedanceArkMediaInput",
    "SeedanceArkMediaValidator",
    "SeedanceArkUploadImage",
    "SeedanceArkRequestPreview",
    "SeedanceArkCreateTask",
    "SeedanceArkWaitTask",
    "SeedanceArkDownloadVideo",
    "SeedanceArkPreviewSaveVideo",
}
# First/last-frame graphs legitimately run one MediaInput/MediaValidator/Upload
# pipeline per frame, so these node types may appear more than once in the API
# node map. Other node types must remain unique for the safety chain to be trusted.
_REPEATABLE_NODE_TYPES = {
    "SeedanceArkMediaInput",
    "SeedanceArkMediaValidator",
    "SeedanceArkUploadImage",
    "SeedanceArkUploadVideo",
}
_OUTPUT_COLLECTIONS = ("images", "gifs", "videos", "audio")


def load_workflow(path: str | Path) -> dict[str, Any]:
    """Load a JSON workflow and require a top-level object."""
    # 加载前置校验：工作流必须是顶层对象；不允许解析失败或结构污染。
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ComfyUIWorkflowError(f"Unable to load workflow JSON: {path}") from exc
    if not isinstance(data, dict):
        raise ComfyUIWorkflowError("Workflow JSON must be an object")
    return data


def validate_dry_run_workflow(workflow: dict[str, Any]) -> None:
    """Validate the fixed safety controls of the native Seedance dry-run graph."""
    # 两类格式都允许：UI 导出的 nodes 列表，或 API 导出的 node map。
    if not isinstance(workflow, dict):
        raise ComfyUIWorkflowError("Workflow must be an object")

    api_nodes = _api_nodes(workflow)
    if api_nodes is not None:
        _validate_api_workflow(api_nodes)
        return

    nodes = workflow.get("nodes")
    if not isinstance(nodes, list):
        raise ComfyUIWorkflowError("Workflow is missing a valid nodes list")
    typed_nodes: dict[str, dict[str, Any]] = {}
    for node in nodes:
        if isinstance(node, dict) and isinstance(node.get("type"), str):
            typed_nodes.setdefault(node["type"], node)

    required_types = _required_node_types(typed_nodes)
    missing = sorted(required_types - typed_nodes.keys())
    if missing:
        raise ComfyUIWorkflowError(f"Workflow is missing required nodes: {', '.join(missing)}")

    policy = typed_nodes["SeedanceArkExecutionPolicy"]
    policy_values = policy.get("widgets_values")
    if not isinstance(policy_values, list) or len(policy_values) < 2:
        raise ComfyUIWorkflowError("Execution policy is missing dry-run safety values")
    if policy_values[0] != "preview":
        raise ComfyUIWorkflowError("Execution policy mode must be preview")
    if policy_values[1] is not False:
        raise ComfyUIWorkflowError("Execution policy confirm_live_submission must be false")

    create_type = _create_type(typed_nodes)
    create_task = typed_nodes[create_type]
    if create_task.get("widgets_values") != []:
        raise ComfyUIWorkflowError("CreateTask must not expose overridable safety values")
    execution_input = next(
        (item for item in create_task.get("inputs", [])
         if isinstance(item, dict) and item.get("name") == "execution_policy"),
        None,
    )
    if not isinstance(execution_input, dict) or not isinstance(execution_input.get("link"), int):
        raise ComfyUIWorkflowError("CreateTask must receive the linked execution policy")


def validate_api_workflow(workflow: dict[str, Any]) -> None:
    """Require a strict ComfyUI API node map for executor submission."""
    # API 格式是执行入口的前置条件，UI 格式不再直接提交给 /prompt 执行路径。
    api_nodes = _api_nodes(workflow)
    if api_nodes is None:
        raise ComfyUIWorkflowError(
            "ComfyUI executor requires an API-format node map, not UI nodes"
        )
    _validate_api_workflow(api_nodes)


def _api_nodes(workflow: dict[str, Any]) -> dict[str, dict[str, Any]] | None:
    """Return API-format nodes, or None for a UI-export workflow."""
    if "nodes" in workflow:
        return None
    if not workflow:
        raise ComfyUIWorkflowError("API workflow must contain nodes")

    api_nodes: dict[str, dict[str, Any]] = {}
    for node_id, node in workflow.items():
        if not isinstance(node_id, str) or not node_id.strip():
            raise ComfyUIWorkflowError("API workflow node IDs must be non-empty strings")
        if not isinstance(node, dict) or not isinstance(node.get("class_type"), str):
            raise ComfyUIWorkflowError(
                "API workflow nodes require class_type and inputs"
            )
        if not isinstance(node.get("inputs"), dict):
            raise ComfyUIWorkflowError("API workflow nodes require object inputs")
        api_nodes[node_id] = node
    return api_nodes


def _api_link(value: Any) -> bool:
    return (
        isinstance(value, list)
        and len(value) == 2
        and isinstance(value[0], (str, int))
        and bool(str(value[0]).strip())
        and isinstance(value[1], int)
        and value[1] >= 0
    )


def _required_node_types(typed_nodes: dict[str, Any]) -> set[str]:
    # 根据 workflow 的拓扑类型选择安全链路：普通、reference-edit、first-last frame。
    if any(node_type.startswith("SeedanceArkReferenceEdit") for node_type in typed_nodes):
        return _REFERENCE_EDIT_REQUIRED_NODE_TYPES
    if any(node_type.startswith("SeedanceArkFirstLastFrame") for node_type in typed_nodes):
        # Either the base or the structured first/last-frame builder may be
        # present; require exactly the builder(s) the graph actually uses.
        builders = {
            node_type
            for node_type in typed_nodes
            if node_type.startswith("SeedanceArkFirstLastFrame")
        }
        return _FIRST_LAST_FRAME_REQUIRED_NODE_TYPES | builders
    return _LEGACY_REQUIRED_NODE_TYPES


def _create_type(typed_nodes: dict[str, Any]) -> str:
    if "SeedanceArkReferenceEditCreateTask" in typed_nodes:
        return "SeedanceArkReferenceEditCreateTask"
    return "SeedanceArkCreateTask"


def _validate_api_workflow(api_nodes: dict[str, dict[str, Any]]) -> None:
    typed_nodes: dict[str, dict[str, Any]] = {}
    for node in api_nodes.values():
        node_type = node["class_type"]
        if node_type in typed_nodes and node_type not in _REPEATABLE_NODE_TYPES:
            raise ComfyUIWorkflowError(f"API workflow contains duplicate node type: {node_type}")
        typed_nodes[node_type] = node

    required_types = _required_node_types(typed_nodes)
    missing = sorted(required_types - typed_nodes.keys())
    if missing:
        raise ComfyUIWorkflowError(
            f"API workflow is missing required nodes: {', '.join(missing)}"
        )

    policy_inputs = typed_nodes["SeedanceArkExecutionPolicy"]["inputs"]
    if policy_inputs.get("mode") != "preview":
        raise ComfyUIWorkflowError("Execution policy mode must be preview")
    if policy_inputs.get("confirm_live_submission") is not False:
        raise ComfyUIWorkflowError(
            "Execution policy confirm_live_submission must be false"
        )

    create_type = _create_type(typed_nodes)
    create_inputs = typed_nodes[create_type]["inputs"]
    if set(create_inputs) != {"request_json", "execution_policy"}:
        raise ComfyUIWorkflowError(
            "CreateTask must expose only linked request and execution policy inputs"
        )
    if not _api_link(create_inputs["request_json"]):
        raise ComfyUIWorkflowError("CreateTask request_json must be a linked input")
    if not _api_link(create_inputs["execution_policy"]):
        raise ComfyUIWorkflowError(
            "CreateTask execution_policy must be a linked input"
        )

    policy_node_types = [
        (
            "SeedanceArkReferenceEditRequestPreview"
            if create_type == "SeedanceArkReferenceEditCreateTask"
            else "SeedanceArkRequestPreview"
        ),
        create_type,
        "SeedanceArkWaitTask",
        "SeedanceArkDownloadVideo",
        "SeedanceArkPreviewSaveVideo",
    ]
    if create_type == "SeedanceArkReferenceEditCreateTask":
        policy_node_types[0:0] = [
            "SeedanceArkUploadImage", "SeedanceArkUploadVideo",
        ]
    for node_type in policy_node_types:
        inputs = typed_nodes[node_type]["inputs"]
        policy_link = inputs.get("execution_policy")
        if not _api_link(policy_link):
            raise ComfyUIWorkflowError(
                f"{node_type} execution_policy must be a linked input"
            )
        target_id = str(policy_link[0])
        target = api_nodes.get(target_id)
        if target is None or target.get("class_type") != "SeedanceArkExecutionPolicy":
            raise ComfyUIWorkflowError(
                f"{node_type} execution_policy must target "
                "SeedanceArkExecutionPolicy"
            )


def extract_history_outputs(history: dict[str, Any]) -> list[dict[str, Any]]:
    """Extract ComfyUI output file metadata without assigning provider cost."""
    # 只抽取文件定位元数据，不在此阶段绑定 URL 或 OSS 上传逻辑。
    if not isinstance(history, dict):
        raise ComfyUIWorkflowError("History must be an object")

    entries: list[Any]
    if "outputs" in history:
        if not isinstance(history["outputs"], dict):
            raise ComfyUIWorkflowError("History outputs must be an object")
        entries = [history]
    else:
        entries = list(history.values())

    outputs: list[dict[str, Any]] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        if "outputs" not in entry:
            continue
        raw_outputs = entry["outputs"]
        if not isinstance(raw_outputs, dict):
            raise ComfyUIWorkflowError("History outputs must be an object")
        for node_output in raw_outputs.values():
            if not isinstance(node_output, dict):
                raise ComfyUIWorkflowError("History node output must be an object")
            for collection_name in _OUTPUT_COLLECTIONS:
                if collection_name not in node_output:
                    continue
                collection = node_output[collection_name]
                if not isinstance(collection, list):
                    raise ComfyUIWorkflowError(
                        f"History {collection_name} output must be a list"
                    )
                for metadata in collection:
                    if not isinstance(metadata, dict):
                        raise ComfyUIWorkflowError("History output metadata must be an object")
                    if any(
                        not isinstance(metadata.get(field), str)
                        for field in ("filename", "subfolder", "type")
                    ):
                        raise ComfyUIWorkflowError(
                            "History output metadata requires string filename, subfolder, and type"
                        )
                    outputs.append({
                        "filename": metadata["filename"],
                        "subfolder": metadata["subfolder"],
                        "type": metadata["type"],
                    })
    return outputs
