import json
from pathlib import Path

import preflight_nodes


WORKFLOW_ROOT = Path(__file__).resolve().parents[1] / "workflows"
PREFLIGHT_TEMPLATES = sorted(WORKFLOW_ROOT.glob("*-preflight-v1.comfy.json"))


def load_template(path):
    return json.loads(path.read_text(encoding="utf-8"))


def test_all_preflight_templates_have_bidirectional_type_safe_links():
    assert len(PREFLIGHT_TEMPLATES) == 8

    for path in PREFLIGHT_TEMPLATES:
        workflow = load_template(path)
        nodes = {node["id"]: node for node in workflow["nodes"]}
        links = {link[0]: link for link in workflow["links"]}

        for link_id, source_id, source_slot, target_id, target_slot, link_type in workflow["links"]:
            source = nodes[source_id]["outputs"][source_slot]
            target = nodes[target_id]["inputs"][target_slot]
            assert source["type"] == link_type, (path.name, link_id, "source")
            assert target["type"] == link_type, (path.name, link_id, "target")
            assert link_id in source.get("links", []), (path.name, link_id, "source backlink")
            assert target.get("link") == link_id, (path.name, link_id, "target backlink")

        for node in nodes.values():
            for output in node.get("outputs", []):
                for link_id in output.get("links") or []:
                    assert link_id in links, (path.name, node["id"], link_id)
            for node_input in node.get("inputs", []):
                if node_input.get("link") is not None:
                    assert node_input["link"] in links, (path.name, node["id"], node_input["link"])


def test_all_preflight_templates_default_to_preview_and_reach_an_output_node():
    output_classes = {
        name for name, node_class in preflight_nodes.CLASSES.items()
        if getattr(node_class, "OUTPUT_NODE", False)
    }

    for path in PREFLIGHT_TEMPLATES:
        workflow = load_template(path)
        nodes = {node["id"]: node for node in workflow["nodes"]}
        policy = next(node for node in nodes.values() if node["type"] == "VideoFlowExecutionPolicy")
        assert policy["widgets_values"] == ["preview"], path.name

        outgoing = {}
        for _, source_id, _, target_id, _, _ in workflow["links"]:
            outgoing.setdefault(source_id, set()).add(target_id)

        request_node = next(node for node in nodes.values() if node["type"].endswith("Request"))
        pending = [request_node["id"]]
        reachable = set()
        while pending:
            node_id = pending.pop()
            if node_id in reachable:
                continue
            reachable.add(node_id)
            pending.extend(outgoing.get(node_id, ()))

        assert any(nodes[node_id]["type"] in output_classes for node_id in reachable), path.name


def test_reference_image_template_is_the_single_image_4_to_30_second_workflow():
    workflow = load_template(WORKFLOW_ROOT / "seedance-product-preflight-v1.comfy.json")
    node_types = [node["type"] for node in workflow["nodes"]]

    assert node_types.count("VideoFlowProductInput") == 1
    assert node_types.count("VideoFlowProductRequest") == 1
    assert "VideoFlowReferenceImageInput" not in node_types
    duration = preflight_nodes.ProductRequest.INPUT_TYPES()["required"]["duration"][0]
    assert duration == list(range(4, 31))


def test_omni_reference_template_chains_image_video_and_audio_collections():
    workflow = load_template(WORKFLOW_ROOT / "seedance-multi-reference-preflight-v1.comfy.json")
    nodes = {node["type"]: node for node in workflow["nodes"]}

    assert "VideoFlowMultiReferenceInput" not in nodes
    assert nodes["VideoFlowReferenceImageInput"]["widgets_values"] == ["请选择图片"]
    assert nodes["VideoFlowReferenceVideoInput"]["widgets_values"] == ["请选择视频"]
    assert nodes["VideoFlowReferenceAudioInput"]["widgets_values"] == ["请选择音频"]

    links = {(source, target, kind) for _, source, _, target, _, kind in workflow["links"]}
    assert (
        nodes["VideoFlowReferenceImageInput"]["id"],
        nodes["VideoFlowReferenceVideoInput"]["id"],
        "VIDEO_FLOW_LOCAL_MEDIA_LIST",
    ) in links
    assert (
        nodes["VideoFlowReferenceVideoInput"]["id"],
        nodes["VideoFlowReferenceAudioInput"]["id"],
        "VIDEO_FLOW_LOCAL_MEDIA_LIST",
    ) in links
    assert (
        nodes["VideoFlowReferenceAudioInput"]["id"],
        nodes["VideoFlowMultiReferenceRequest"]["id"],
        "VIDEO_FLOW_LOCAL_MEDIA_LIST",
    ) in links


def test_video_edit_template_uses_video_collection_and_fixed_edit_request():
    workflow = load_template(WORKFLOW_ROOT / "seedance-video-edit-preflight-v1.comfy.json")
    nodes = {node["type"]: node for node in workflow["nodes"]}

    assert nodes["VideoFlowExecutionPolicy"]["widgets_values"] == ["preview"]
    assert nodes["VideoFlowReferenceVideoInput"]["widgets_values"] == ["请选择视频"]
    assert nodes["VideoFlowVideoEditRequest"]["widgets_values"] == ["编辑参考视频", "720p"]
    links = {(source, target, kind) for _, source, _, target, _, kind in workflow["links"]}
    assert (
        nodes["VideoFlowReferenceVideoInput"]["id"],
        nodes["VideoFlowVideoEditRequest"]["id"],
        "VIDEO_FLOW_LOCAL_MEDIA_LIST",
    ) in links


def test_video_extend_template_chains_multiple_videos_and_exposes_output_duration():
    workflow = load_template(WORKFLOW_ROOT / "seedance-video-extend-preflight-v1.comfy.json")
    video_nodes = [node for node in workflow["nodes"] if node["type"] == "VideoFlowReferenceVideoInput"]
    nodes = {node["type"]: node for node in workflow["nodes"] if node["type"] != "VideoFlowReferenceVideoInput"}

    assert nodes["VideoFlowExecutionPolicy"]["widgets_values"] == ["preview"]
    assert len(video_nodes) == 3
    assert nodes["VideoFlowVideoExtendRequest"]["widgets_values"] == ["向后延长 @video1", 11, "720p"]
    links = {(source, target, kind) for _, source, _, target, _, kind in workflow["links"]}
    assert (
        video_nodes[0]["id"], video_nodes[1]["id"], "VIDEO_FLOW_LOCAL_MEDIA_LIST",
    ) in links
    assert (
        video_nodes[1]["id"], video_nodes[2]["id"], "VIDEO_FLOW_LOCAL_MEDIA_LIST",
    ) in links
    assert (
        video_nodes[2]["id"], nodes["VideoFlowVideoExtendRequest"]["id"], "VIDEO_FLOW_LOCAL_MEDIA_LIST",
    ) in links


def test_audio_reference_template_chains_multiple_audio_inputs():
    workflow = load_template(WORKFLOW_ROOT / "seedance-audio-reference-preflight-v1.comfy.json")
    audio_nodes = [node for node in workflow["nodes"] if node["type"] == "VideoFlowReferenceAudioInput"]
    nodes = {node["type"]: node for node in workflow["nodes"] if node["type"] != "VideoFlowReferenceAudioInput"}

    assert nodes["VideoFlowExecutionPolicy"]["widgets_values"] == ["preview"]
    assert len(audio_nodes) == 2
    assert nodes["VideoFlowAudioReferenceRequest"]["widgets_values"] == ["参考音频生成画面", 5, "16:9", "720p"]
    links = {(source, target, kind) for _, source, _, target, _, kind in workflow["links"]}
    assert (
        audio_nodes[0]["id"], audio_nodes[1]["id"], "VIDEO_FLOW_LOCAL_MEDIA_LIST",
    ) in links
    assert (
        audio_nodes[1]["id"], nodes["VideoFlowAudioReferenceRequest"]["id"], "VIDEO_FLOW_LOCAL_MEDIA_LIST",
    ) in links
