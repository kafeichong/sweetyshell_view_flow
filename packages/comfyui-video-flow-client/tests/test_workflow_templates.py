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
            for output_slot, output in enumerate(node.get("outputs", [])):
                for link_id in output.get("links") or []:
                    assert link_id in links, (path.name, node["id"], link_id)
                    assert links[link_id][1:3] == [node["id"], output_slot], (
                        path.name, node["id"], output_slot, link_id, "wrong source backlink",
                    )
            for input_slot, node_input in enumerate(node.get("inputs", [])):
                if node_input.get("link") is not None:
                    assert node_input["link"] in links, (path.name, node["id"], node_input["link"])
                    assert links[node_input["link"]][3:5] == [node["id"], input_slot], (
                        path.name, node["id"], input_slot, node_input["link"], "wrong target backlink",
                    )


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


OPEN_TEMPLATE_REQUEST_NODES = {
    "seedance-text-to-video-preflight-v1.comfy.json": "VideoFlowTextRequest",
    "seedance-first-frame-to-video-preflight-v1.comfy.json": "VideoFlowFirstFrameRequest",
    "seedance-first-last-frame-to-video-preflight-v1.comfy.json": "VideoFlowFirstLastFrameRequest",
    "seedance-multi-reference-preflight-v1.comfy.json": "VideoFlowMultiReferenceRequest",
}


def test_open_templates_ship_worked_examples_rather_than_placeholders():
    """默认提示词会**直接提交给模型**：每条都得是一段照着改就能用的完整示例。

    官方公式有四段（一句话概述 → 贯穿细节 → 时间戳分镜 → 结尾补充），默认值要把它走全，
    否则用户学不到分镜该怎么写；同时不能混进说明文字——用户忘了改就会连说明一起发出去。
    """
    for filename, node_type in OPEN_TEMPLATE_REQUEST_NODES.items():
        workflow = load_template(WORKFLOW_ROOT / filename)
        prompt = next(node for node in workflow["nodes"] if node["type"] == node_type)["widgets_values"][0]

        # 分镜：默认时长 5 秒，示例的时间戳要落在 5 秒内，用户不改时长也能直接跑。
        assert "0s-3s" in prompt and "3s-5s" in prompt, filename
        # 镜头语言与结尾补充都要出现，让人看得到"这四段长什么样"。
        assert "镜头" in prompt and "景深" in prompt, filename
        for instructional in ("写法", "公式", "建议", "tooltip", "【"):
            assert instructional not in prompt, f"{filename} 默认值里不能出现说明性文字或占位符：{instructional}"
        assert len(prompt) <= 300, f"{filename} 示例要能在官方建议的 500 字内留出改写空间"

    # 全模态参考的示例要示范"怎么指代素材"——这是这条工作流最容易写错的地方。
    multi = load_template(WORKFLOW_ROOT / "seedance-multi-reference-preflight-v1.comfy.json")
    multi_prompt = next(node for node in multi["nodes"] if node["type"] == "VideoFlowMultiReferenceRequest")["widgets_values"][0]
    assert "@图像1" in multi_prompt and "@视频1" in multi_prompt


def test_omni_reference_template_ships_ready_made_slots_for_extra_media():
    workflow = load_template(WORKFLOW_ROOT / "seedance-multi-reference-preflight-v1.comfy.json")
    nodes = workflow["nodes"]
    by_id = {node["id"]: node for node in nodes}
    types = [node["type"] for node in nodes]

    assert types.count("VideoFlowMultiReferenceInput") == 0
    assert types.count("VideoFlowReferenceImageInput") == 4
    assert types.count("VideoFlowReferenceVideoInput") == 2
    assert types.count("VideoFlowReferenceAudioInput") == 1

    # **所有槽位默认都是空的**：没动过的槽位不会悄悄带上某个文件，想用哪个就显式去选，
    # 不想用的晾着即可——不用删连线、也不用右键旁路节点。
    slots = [node for node in nodes if node["type"] in (
        "VideoFlowReferenceImageInput", "VideoFlowReferenceVideoInput", "VideoFlowReferenceAudioInput")]
    assert len(slots) == 7
    assert all(node["widgets_values"] == [preflight_nodes.UNUSED_MEDIA_CHOICE] for node in slots)

    # 七个槽位串成一条链，顺序是 4 图 → 2 视频 → 1 音频，末尾接请求节点。
    # 从请求节点反向走链，避免把节点 id 写死在测试里。
    incoming = {(link[3], link[4]): link for link in workflow["links"]}
    request = next(node for node in nodes if node["type"] == "VideoFlowMultiReferenceRequest")
    chain, current, slot = [], request["id"], 0
    while (link := incoming.get((current, slot))) is not None:
        chain.append(by_id[link[1]]["type"])
        current, slot = link[1], 0

    assert chain == [
        "VideoFlowReferenceAudioInput",
        "VideoFlowReferenceVideoInput",
        "VideoFlowReferenceVideoInput",
        "VideoFlowReferenceImageInput",
        "VideoFlowReferenceImageInput",
        "VideoFlowReferenceImageInput",
        "VideoFlowReferenceImageInput",
    ]


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
