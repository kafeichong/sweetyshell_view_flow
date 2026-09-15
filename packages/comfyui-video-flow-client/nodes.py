import itertools
import time
from pathlib import Path

try:
    from .client import VideoFlowClient
    from .config import VideoFlowConfig
except ImportError:  # Support ComfyUI's direct module loader.
    from client import VideoFlowClient
    from config import VideoFlowConfig

_requery_counter = itertools.count()


def requery_nonce() -> str:
    """Force ComfyUI to re-query remote state instead of using cached output."""
    return f"{time.time_ns()}-{next(_requery_counter)}"


class VideoFlowConfigNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "backend_url": (
                    "STRING",
                    {"default": VideoFlowConfig.from_env().backend_url},
                ),
                "protocol_version": ("STRING", {"default": "1"}),
            }
        }

    RETURN_TYPES = ("VIDEO_FLOW_CONFIG",)
    FUNCTION = "configure"
    CATEGORY = "Video Flow"

    def configure(self, backend_url, protocol_version):
        return (
            VideoFlowConfig(
                backend_url.rstrip("/"),
                VideoFlowConfig.from_env().token,
                protocol_version,
            ),
        )


class VideoFlowWaitTask:
    """Wait for an existing Task; never creates or resubmits one."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "config": ("VIDEO_FLOW_CONFIG",),
                "task_id": ("STRING",),
                "timeout_seconds": (
                    "INT",
                    {"default": 1200, "min": 30, "max": 7200},
                ),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("task_id",)
    FUNCTION = "wait"
    CATEGORY = "Video Flow"

    @classmethod
    def IS_CHANGED(cls, *args, **kwargs):
        return requery_nonce()

    def wait(self, config, task_id, timeout_seconds=1200):
        client = VideoFlowClient(config)
        summary = client.wait_for_task(
            str(task_id),
            timeout_seconds=int(timeout_seconds),
        )
        print(f"[video-flow] task {task_id} ready; {client.cost_note(summary)}")
        return (str(task_id),)


def default_output_dir() -> Path:
    """Use the configured ComfyUI output directory when available."""
    try:
        import folder_paths
    except ImportError:
        return Path(__file__).resolve().parents[2] / "output" / "video-flow"

    return Path(folder_paths.get_output_directory()) / "video-flow"


class VideoFlowLoadResult:
    """Download an existing Task by ID; this is the standalone recovery path."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "config": ("VIDEO_FLOW_CONFIG",),
                "task_id": ("STRING",),
            }
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("local_video_path", "cost_status")
    OUTPUT_NODE = True
    FUNCTION = "download"
    CATEGORY = "Video Flow"

    @classmethod
    def IS_CHANGED(cls, *args, **kwargs):
        return requery_nonce()

    def download(self, config, task_id):
        client = VideoFlowClient(config)
        result = client.download_task_result(str(task_id), default_output_dir())
        note = client.cost_note(result)
        print(
            f"[video-flow] task {task_id} downloaded to "
            f"{result['localPath']}; {note}"
        )
        return (result["localPath"], note)


NODE_CLASS_MAPPINGS = {
    "VideoFlowConfig": VideoFlowConfigNode,
    "VideoFlowWaitTask": VideoFlowWaitTask,
    "VideoFlowLoadResult": VideoFlowLoadResult,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "VideoFlowConfig": "Video Flow Config",
    "VideoFlowWaitTask": "Wait Video Flow Task",
    "VideoFlowLoadResult": "Load Video Flow Result",
}

try:
    from .preflight_nodes import CLASSES, NAMES
except ImportError:
    from preflight_nodes import CLASSES, NAMES

NODE_CLASS_MAPPINGS.update(CLASSES)
NODE_DISPLAY_NAME_MAPPINGS.update(NAMES)
