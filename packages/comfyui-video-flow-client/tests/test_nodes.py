from pathlib import Path

import nodes
from config import VideoFlowConfig
from receipts import ReceiptStore


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
        10,
        "9:16",
    )

    assert result == ("task-production",)
    assert calls["create"]["mode"] == "production"
    assert calls["create"]["payload"]["params"]["duration"] == 10
    # 模板显式带版本，稳定键纳入版本与规格版本。
    assert calls["key_params"] == {
        "profile": "seedance",
        "duration": 10,
        "ratio": "9:16",
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
    assert set(calls["create"]["payload"]) == {"capability", "profile", "params"}


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

    node.submit(config, "prompt", image, 10, "9:16", 1)
    node.submit(config, "prompt", image, 10, "9:16", 1)
    node.submit(config, "prompt", image, 10, "9:16", 2)

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
            return {"localPath": str(Path(output_dir) / "result.mp4")}

    monkeypatch.setattr(nodes, "VideoFlowClient", FakeClient)
    monkeypatch.setattr(nodes, "default_output_dir", lambda: tmp_path)

    result = nodes.VideoFlowLoadResult().download(
        VideoFlowConfig("https://backend.test", "token"),
        "task-1",
    )

    assert result == (str(tmp_path / "result.mp4"),)
    assert calls == {"task_id": "task-1", "output_dir": tmp_path}
