from pathlib import Path

import nodes
from config import VideoFlowConfig


class _Pixels:
    def __init__(self, value):
        self.value = value

    def cpu(self):
        return self

    def numpy(self):
        return self.value


def test_production_node_explicitly_submits_production(monkeypatch):
    calls = {}

    class FakeClient:
        def __init__(self, _config):
            pass

        def upload_media(self, *_args, **_kwargs):
            return {"assetId": "asset-1"}

        @staticmethod
        def stable_idempotency_key(*_args, **kwargs):
            calls["key_params"] = kwargs
            return "base-key"

        def create_task(self, **kwargs):
            calls["create"] = kwargs
            return {"id": "task-production"}

    monkeypatch.setattr(nodes, "VideoFlowClient", FakeClient)
    image = [_Pixels(nodes.np.zeros((2, 2, 3), dtype=nodes.np.float32))]

    result = nodes.VideoFlowSeedanceProduction().submit(
        VideoFlowConfig("https://backend.test", "token"),
        "prompt",
        image,
        10,
        "9:16",
    )

    assert result == ("task-production",)
    assert calls["create"]["mode"] == "production"
    assert calls["create"]["payload"]["params"]["duration"] == 10
    assert calls["key_params"] == {
        "profile": "seedance",
        "duration": 10,
        "ratio": "9:16",
    }


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
