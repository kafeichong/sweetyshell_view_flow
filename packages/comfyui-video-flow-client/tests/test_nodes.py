import json
import sys
from pathlib import Path

import nodes
from config import VideoFlowConfig
from receipts import ReceiptStore


class _FakeFolderPaths:
    """替换 ComfyUI 的 folder_paths 运行时模块。"""

    def __init__(self, output_directory: Path):
        self._output_directory = output_directory

    def get_output_directory(self) -> str:
        return str(self._output_directory)


class _Pixels:
    def __init__(self, value):
        self.value = value

    def cpu(self):
        return self

    def numpy(self):
        return self.value


def test_production_node_explicitly_submits_production(monkeypatch, tmp_path):
    calls = {}

    class FakeClient:
        def __init__(self, _config):
            pass

        def upload_media(self, *_args, **_kwargs):
            # 上传票据带临时签名 URL：它绝不能进入幂等请求体。
            return {
                "assetId": "asset-1",
                "uploadUrl": "https://oss.test/signed?Expires=1",
            }

        @staticmethod
        def stable_idempotency_key(*_args, **kwargs):
            calls["key_params"] = kwargs
            return "base-key"

        def receipt_store(self, root):
            calls["receipt_root"] = root
            return ReceiptStore(root)

        def create_task_with_receipt(self, **kwargs):
            calls["create"] = kwargs
            return {"id": "task-production"}

    monkeypatch.setattr(nodes, "VideoFlowClient", FakeClient)
    image = [_Pixels(nodes.np.zeros((2, 2, 3), dtype=nodes.np.float32))]

    result = nodes.VideoFlowSeedanceProduction().submit(
        VideoFlowConfig("https://backend.test", "token", receipt_dir=str(tmp_path)),
        "prompt",
        image,
        1,
    )

    assert result == ("task-production",)
    assert calls["create"]["mode"] == "production"
    assert calls["create"]["payload"]["workflowKey"] == "seedance.reference-image-to-video.v1"
    assert calls["create"]["payload"]["generation"] == {"duration": 5, "ratio": "16:9", "resolution": "720p"}
    assert calls["create"]["payload"]["media"] == [{"assetId": "asset-1", "role": "reference_image"}]
    # 幂等键纳入工作流、固定规格与版本。
    assert calls["key_params"] == {
        "workflow_key": "seedance.reference-image-to-video.v1",
        "duration": 5,
        "ratio": "16:9",
        "resolution": "720p",
        "generation_version": 1,
        "spec_version": "",
    }
    # 回执写进配置目录（真实客户端还会再按凭证分命名空间）。
    assert calls["receipt_root"] == str(tmp_path)
    assert calls["create"]["intent_key"] == "base-key"

    # 上传票据里的临时签名 URL 与任何执行时间戳都不能混进幂等请求。
    serialized = repr(calls["create"]["payload"])
    assert "signed" not in serialized
    assert "Expires" not in serialized
    assert set(calls["create"]["payload"]) == {"workflowKey", "prompt", "generation", "media"}


def test_config_node_defaults_to_company_backend(monkeypatch):
    monkeypatch.delenv("VIDEO_FLOW_BACKEND_URL", raising=False)

    defaults = nodes.VideoFlowConfigNode.INPUT_TYPES()["required"]

    assert defaults["backend_url"][1]["default"] == "https://ai.sweetyshell.com"


def test_one_click_product_video_runs_complete_delivery_chain(monkeypatch):
    calls = []
    config = VideoFlowConfig("https://ai.sweetyshell.com", "creative-token")

    class FakeProduction:
        def submit(self, received_config, prompt, image, generation_version):
            calls.append(("submit", received_config, prompt, image, generation_version))
            return ("task-1",)

    class FakeWait:
        def wait(self, received_config, task_id, timeout_seconds):
            calls.append(("wait", received_config, task_id, timeout_seconds))
            return (task_id,)

    class FakeLoadResult:
        def download(self, received_config, task_id):
            calls.append(("download", received_config, task_id))
            return ("/output/video-flow/task-1.mp4", "费用已确认")

    monkeypatch.setattr(nodes.VideoFlowConfig, "from_env", classmethod(lambda _cls: config))
    monkeypatch.setattr(nodes, "VideoFlowSeedanceProduction", FakeProduction)
    monkeypatch.setattr(nodes, "VideoFlowWaitTask", FakeWait)
    monkeypatch.setattr(nodes, "VideoFlowLoadResult", FakeLoadResult)
    image = object()
    monkeypatch.setattr(nodes, "_load_product_image", lambda filename: image)

    result = nodes.VideoFlowSeedanceOneClickProductVideo().generate(
        "产品在干净摄影棚中缓慢旋转", "product.png", 1, 1200
    )

    assert result == ("/output/video-flow/task-1.mp4", "费用已确认")
    assert calls == [
        ("submit", config, "产品在干净摄影棚中缓慢旋转", image, 1),
        ("wait", config, "task-1", 1200),
        ("download", config, "task-1"),
    ]


def test_production_node_key_changes_only_when_version_changes(monkeypatch, tmp_path):
    keys = []

    class FakeClient:
        def __init__(self, _config):
            pass

        def upload_media(self, *_args, **_kwargs):
            return {"assetId": "asset-1"}

        @staticmethod
        def stable_idempotency_key(*_args, **kwargs):
            keys.append(kwargs["generation_version"])
            return f"key-v{kwargs['generation_version']}"

        def receipt_store(self, root):
            return ReceiptStore(root)

        def create_task_with_receipt(self, **kwargs):
            return {"id": f"task-{kwargs['intent_key']}"}

    monkeypatch.setattr(nodes, "VideoFlowClient", FakeClient)
    image = [_Pixels(nodes.np.zeros((2, 2, 3), dtype=nodes.np.float32))]
    config = VideoFlowConfig(
        "https://backend.test",
        "token",
        receipt_dir=str(tmp_path),
        spec_version="approved-v2",
    )
    node = nodes.VideoFlowSeedanceProduction()

    node.submit(config, "prompt", image, 1)
    node.submit(config, "prompt", image, 1)
    node.submit(config, "prompt", image, 2)

    # 同参数同版本沿用同一意图；用户主动加版本才生成新的一版。
    assert keys == [1, 1, 2]


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
    # 替换 ComfyUI 的运行时模块，而不是替换我们自己的目录函数——
    # 否则自定义 output 路径的安装会写错地方却测不出来。
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

    # 输出的是 taskId 本身，LoadResult 才能把它当输入；
    # 把 task JSON 当 taskId 传下去会让下载请求打到错误的地址。
    assert result == ("task-1",)
    assert calls == {"task_id": "task-1", "timeout_seconds": 300}


def test_wait_and_result_nodes_allow_requerying(monkeypatch):
    # ComfyUI 默认会缓存节点输出：没有变化的 IS_CHANGED 会让用户重跑时
    # 拿到旧状态，永远看不到任务已经就绪。
    first = nodes.VideoFlowWaitTask.IS_CHANGED()
    second = nodes.VideoFlowWaitTask.IS_CHANGED()

    assert first != second
    assert nodes.VideoFlowLoadResult.IS_CHANGED() != nodes.VideoFlowWaitTask.IS_CHANGED()


def test_production_node_stays_on_the_original_intent_when_redispatched(monkeypatch, tmp_path):
    creates = []

    class FakeClient:
        def __init__(self, _config):
            self._receipts = {}

        def upload_media(self, *_args, **_kwargs):
            return {"assetId": "asset-1"}

        @staticmethod
        def stable_idempotency_key(*_args, **_kwargs):
            return "stable-intent"

        def receipt_store(self, root):
            return ReceiptStore(root)

        def create_task_with_receipt(self, **kwargs):
            creates.append(kwargs["intent_key"])
            # 回执已经把意图固定住：重复调度只会拿回同一个任务。
            return {"id": "task-1"}

    monkeypatch.setattr(nodes, "VideoFlowClient", FakeClient)
    image = [_Pixels(nodes.np.zeros((2, 2, 3), dtype=nodes.np.float32))]
    config = VideoFlowConfig("https://backend.test", "token", receipt_dir=str(tmp_path))
    node = nodes.VideoFlowSeedanceProduction()

    first = node.submit(config, "prompt", image, 1)
    second = node.submit(config, "prompt", image, 1)

    # 即使节点被再次调度（IS_CHANGED 让 ComfyUI 重跑），也只能是同一个意图。
    assert node.IS_CHANGED() != node.IS_CHANGED()
    assert first == second == ("task-1",)
    assert creates == ["stable-intent", "stable-intent"]


def _load_example(name):
    path = Path(__file__).resolve().parents[1] / "examples" / name
    return json.loads(path.read_text(encoding="utf-8"))


def test_production_example_wires_production_to_wait_to_result():
    workflow = _load_example("seedance-production.json")

    # 本插件的节点必须都已注册（内置节点如 LoadImage 不在此列），
    # 否则示例拖进 ComfyUI 就会缺节点报错。
    for node in workflow.values():
        if node["class_type"].startswith("VideoFlow"):
            assert node["class_type"] in nodes.NODE_CLASS_MAPPINGS

    production = next(n for n in workflow.values() if n["class_type"] == "VideoFlowSeedanceProduction")
    wait = next(n for n in workflow.values() if n["class_type"] == "VideoFlowWaitTask")
    result = next(n for n in workflow.values() if n["class_type"] == "VideoFlowLoadResult")

    # Wait 吃 Production 的 taskId 输出，LoadResult 吃 Wait 的——不用手抄 task id，
    # 也不会把 task JSON 当成 task id 传下去。
    assert wait["inputs"]["task_id"][0] == next(
        key for key, node in workflow.items() if node is production
    )
    assert result["inputs"]["task_id"][0] == next(
        key for key, node in workflow.items() if node is wait
    )
    assert production["inputs"]["generation_version"] == 1


def test_resume_example_reuses_an_existing_task_id():
    workflow = _load_example("seedance-resume.json")

    for node in workflow.values():
        if node["class_type"].startswith("VideoFlow"):
            assert node["class_type"] in nodes.NODE_CLASS_MAPPINGS

    wait = next(n for n in workflow.values() if n["class_type"] == "VideoFlowWaitTask")
    result = next(n for n in workflow.values() if n["class_type"] == "VideoFlowLoadResult")

    # 恢复流程只等待与下载已有任务，不出现任何提交节点。
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

    # 用户自定义了输出目录时，产物必须落在那里，而不是插件目录旁边的 output。
    assert nodes.default_output_dir() == configured / "video-flow"


def test_default_output_dir_falls_back_without_comfyui(monkeypatch):
    monkeypatch.delitem(sys.modules, "folder_paths", raising=False)

    fallback = nodes.default_output_dir()

    assert fallback.name == "video-flow"
    assert fallback.parent.name == "output"


def test_text_to_video_node_creates_only_a_preview_task(monkeypatch):
    calls = {}

    class FakeClient:
        def __init__(self, _config):
            pass

        @staticmethod
        def stable_idempotency_key(*_args, **kwargs):
            calls["key"] = kwargs
            return "text-intent"

        def create_task(self, **kwargs):
            calls["create"] = kwargs
            return {"id": "preview-1"}

    monkeypatch.setattr(nodes, "VideoFlowClient", FakeClient)
    result = nodes.VideoFlowSeedanceTextToVideo().submit(
        VideoFlowConfig("https://backend.test", "token"), "a product rotates", 2
    )

    assert result == ("preview-1",)
    assert calls["create"] == {
        "idempotency_key": "text-intent",
        "mode": "preview",
        "payload": {
            "workflowKey": "seedance.text-to-video.v1",
            "prompt": {"positive": "a product rotates"},
            "generation": {"duration": 5, "ratio": "16:9", "resolution": "720p"},
            "media": [],
        },
    }
    assert calls["key"]["workflow_key"] == "seedance.text-to-video.v1"
