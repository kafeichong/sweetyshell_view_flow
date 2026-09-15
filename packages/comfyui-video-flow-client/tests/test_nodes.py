import json
import sys
from pathlib import Path

import nodes
from config import VideoFlowConfig


class _FakeFolderPaths:
    def __init__(self, output_directory: Path):
        self._output_directory = output_directory

    def get_output_directory(self) -> str:
        return str(self._output_directory)


def test_config_node_defaults_to_company_backend(monkeypatch):
    monkeypatch.delenv("VIDEO_FLOW_BACKEND_URL", raising=False)

    defaults = nodes.VideoFlowConfigNode.INPUT_TYPES()["required"]

    assert defaults["backend_url"][1]["default"] == "https://ai.sweetyshell.com"


def test_registered_nodes_exclude_retired_upload_and_fixed_spec_entrypoints():
    retired = {
        "VideoFlowSeedancePreview",
        "VideoFlowSeedanceProduction",
        "VideoFlowSeedanceOneClickProductVideo",
        "VideoFlowSeedanceTextToVideo",
    }

    assert retired.isdisjoint(nodes.NODE_CLASS_MAPPINGS)
    assert {
        "VideoFlowConfig",
        "VideoFlowWaitTask",
        "VideoFlowLoadResult",
        "VideoFlowRequestPreflight",
        "VideoFlowConfirmedCreate",
    }.issubset(nodes.NODE_CLASS_MAPPINGS)


def test_result_node_downloads_into_comfyui_output(monkeypatch, tmp_path):
    calls = {}

    class FakeClient:
        def __init__(self, _config):
            pass

        def download_task_result(self, task_id, output_dir):
            calls["task_id"] = task_id
            calls["output_dir"] = Path(output_dir)
            return {
                "localPath": str(Path(output_dir) / "result.mp4"),
                "costSummary": {"status": "usage_calculated", "usageCalculatedCny": "0.700000"},
            }

        def cost_note(self, _result):
            return "费用已确认：0.700000 CNY（usage_calculated）"

    monkeypatch.setattr(nodes, "VideoFlowClient", FakeClient)
    monkeypatch.setitem(sys.modules, "folder_paths", _FakeFolderPaths(tmp_path))

    result = nodes.VideoFlowLoadResult().download(
        VideoFlowConfig("https://backend.test", "token"),
        "task-1",
    )

    assert result == (
        str(tmp_path / "video-flow" / "result.mp4"),
        "费用已确认：0.700000 CNY（usage_calculated）",
    )
    assert calls == {"task_id": "task-1", "output_dir": tmp_path / "video-flow"}


def test_wait_node_blocks_until_ready_and_outputs_task_id(monkeypatch):
    calls = {}

    class FakeClient:
        def __init__(self, _config):
            pass

        def wait_for_task(self, task_id, *, timeout_seconds=1200, poll_seconds=5):
            calls["task_id"] = task_id
            calls["timeout_seconds"] = timeout_seconds
            return {"delivery": {"status": "ready"}, "costSummary": {"status": "unavailable"}}

        def cost_note(self, _summary):
            return "费用待核实"

    monkeypatch.setattr(nodes, "VideoFlowClient", FakeClient)

    result = nodes.VideoFlowWaitTask().wait(
        VideoFlowConfig("https://backend.test", "token"),
        "task-1",
        300,
    )

    assert result == ("task-1",)
    assert calls == {"task_id": "task-1", "timeout_seconds": 300}


def test_wait_and_result_nodes_allow_requerying():
    first = nodes.VideoFlowWaitTask.IS_CHANGED()
    second = nodes.VideoFlowWaitTask.IS_CHANGED()

    assert first != second
    assert nodes.VideoFlowLoadResult.IS_CHANGED() != nodes.VideoFlowWaitTask.IS_CHANGED()


def _load_example(name):
    path = Path(__file__).resolve().parents[1] / "examples" / name
    return json.loads(path.read_text(encoding="utf-8"))


def test_resume_example_reuses_an_existing_task_id():
    workflow = _load_example("seedance-resume.json")

    for node in workflow.values():
        if node["class_type"].startswith("VideoFlow"):
            assert node["class_type"] in nodes.NODE_CLASS_MAPPINGS

    wait = next(n for n in workflow.values() if n["class_type"] == "VideoFlowWaitTask")
    result = next(n for n in workflow.values() if n["class_type"] == "VideoFlowLoadResult")

    assert isinstance(wait["inputs"]["task_id"], str)
    assert result["inputs"]["task_id"][0] == next(
        key for key, node in workflow.items() if node is wait
    )
    assert all(
        n["class_type"] not in {"VideoFlowSeedanceProduction", "VideoFlowSeedancePreview"}
        for n in workflow.values()
    )


def test_default_output_dir_follows_comfyui_configuration(monkeypatch, tmp_path):
    configured = tmp_path / "custom-output"
    monkeypatch.setitem(sys.modules, "folder_paths", _FakeFolderPaths(configured))

    assert nodes.default_output_dir() == configured / "video-flow"


def test_default_output_dir_falls_back_without_comfyui(monkeypatch):
    monkeypatch.delitem(sys.modules, "folder_paths", raising=False)

    fallback = nodes.default_output_dir()

    assert fallback.name == "video-flow"
    assert fallback.parent.name == "output"
