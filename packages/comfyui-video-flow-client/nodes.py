import itertools
import time
from io import BytesIO
from pathlib import Path

import numpy as np
from PIL import Image

try:
    from .client import VideoFlowClient
    from .config import VideoFlowConfig
    from .receipts import ReceiptStore
except ImportError:  # Support ComfyUI's direct module loader.
    from client import VideoFlowClient
    from config import VideoFlowConfig
    from receipts import ReceiptStore

_requery_counter = itertools.count()


def requery_nonce() -> str:
    """给 IS_CHANGED 用的单调递增值。

    只用 time.time_ns() 不够：连续两次调用可能落在同一个时钟刻度上，
    ComfyUI 会认为节点没变化而复用缓存，用户重跑就看不到最新状态。
    """
    return f"{time.time_ns()}-{next(_requery_counter)}"


class VideoFlowConfigNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"backend_url": ("STRING", {"default": "http://localhost:3100"}), "protocol_version": ("STRING", {"default": "1"})}}

    RETURN_TYPES = ("VIDEO_FLOW_CONFIG",)
    FUNCTION = "configure"
    CATEGORY = "Video Flow"

    def configure(self, backend_url, protocol_version):
        return (VideoFlowConfig(backend_url.rstrip("/"), VideoFlowConfig.from_env().token, protocol_version),)


class VideoFlowSeedancePreview:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"config": ("VIDEO_FLOW_CONFIG",), "prompt": ("STRING", {"multiline": True}), "image": ("IMAGE",)}}

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("task_id", "request_summary")
    FUNCTION = "submit"
    CATEGORY = "Video Flow"

    def submit(self, config, prompt, image):
        client = VideoFlowClient(config)
        pixels = np.clip(image[0].cpu().numpy() * 255, 0, 255).astype(np.uint8)
        buffer = BytesIO()
        Image.fromarray(pixels).save(buffer, format="PNG")
        image_bytes = buffer.getvalue()
        uploaded = client.upload_media(image_bytes, filename="reference.png", mime_type="image/png")
        summary = {"mode": "preview", "capability": "IMAGE_TO_VIDEO", "prompt": prompt, "input": "reference.png"}
        task = client.create_task(
            idempotency_key=client.stable_idempotency_key(prompt, image_bytes),
            payload={"capability": "IMAGE_TO_VIDEO", "profile": "seedance", "params": {"prompt": prompt, "image_asset_id": uploaded["assetId"]}},
        )
        return (str(task["id"]), str(summary))


class VideoFlowSeedanceProduction:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "config": ("VIDEO_FLOW_CONFIG",),
                "prompt": ("STRING", {"multiline": True}),
                "image": ("IMAGE",),
                "duration": ("INT", {"default": 5, "min": 1, "max": 60}),
                "ratio": (["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],),
                "generation_version": ("INT", {"default": 1, "min": 1, "max": 9999}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("task_id",)
    FUNCTION = "submit"
    CATEGORY = "Video Flow"

    @classmethod
    def IS_CHANGED(cls, *args, **kwargs):
        # 即使再次被调度，submit 也只能沿用回执里的原意图：重新调度不会
        # 变成第二次付费生成，用户主动改 generation_version 才会。
        return requery_nonce()

    def submit(self, config, prompt, image, duration, ratio, generation_version=1):
        client = VideoFlowClient(config)
        pixels = np.clip(image[0].cpu().numpy() * 255, 0, 255).astype(np.uint8)
        buffer = BytesIO()
        Image.fromarray(pixels).save(buffer, format="PNG")
        image_bytes = buffer.getvalue()
        uploaded = client.upload_media(
            image_bytes,
            filename="reference.png",
            mime_type="image/png",
        )
        # 稳定键显式带上 generation_version 与规格版本：同参数同版本重复执行
        # 命中同一个任务，用户主动提升版本号才表示再生成一版。
        intent_key = client.stable_idempotency_key(
            prompt,
            image_bytes,
            profile="seedance",
            duration=duration,
            ratio=ratio,
            generation_version=generation_version,
            spec_version=config.spec_version,
        )
        task = client.create_task_with_receipt(
            idempotency_key=intent_key,
            mode="production",
            payload={
                "capability": "IMAGE_TO_VIDEO",
                "profile": "seedance",
                "params": {
                    "prompt": prompt,
                    "image_asset_id": uploaded["assetId"],
                    "duration": duration,
                    "ratio": ratio,
                },
            },
            intent_key=intent_key,
            # 回执按后端地址与凭证分命名空间：换账号不会误用上一个人的 taskId。
            receipt_store=client.receipt_store(config.receipt_dir),
        )
        return (str(task["id"]),)


class VideoFlowWaitTask:
    """等到任务真的可交付为止，输出 taskId 供 LoadResult 使用。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "config": ("VIDEO_FLOW_CONFIG",),
                "task_id": ("STRING",),
                "timeout_seconds": ("INT", {"default": 1200, "min": 30, "max": 7200}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("task_id",)
    FUNCTION = "wait"
    CATEGORY = "Video Flow"

    @classmethod
    def IS_CHANGED(cls, *args, **kwargs):
        # 每次都重新查询：用户重跑工作流是要拿最新状态，不是要 ComfyUI 缓存的旧结果。
        return requery_nonce()

    def wait(self, config, task_id, timeout_seconds=1200):
        client = VideoFlowClient(config)
        summary = client.wait_for_task(str(task_id), timeout_seconds=int(timeout_seconds))
        print(f"[video-flow] task {task_id} ready; {client.cost_note(summary)}")
        return (str(task_id),)


def default_output_dir() -> Path:
    """产物落盘目录：优先用 ComfyUI 自己配置的输出目录。

    直接猜 <ComfyUI>/output 在自定义输出路径的安装里会写错地方，用户也会在
    自己配置的目录里找不到片。只有在 ComfyUI 之外运行时才退回插件相对目录。
    """
    try:
        import folder_paths  # ComfyUI 运行时模块
    except ImportError:
        return Path(__file__).resolve().parents[2] / "output" / "video-flow"

    return Path(folder_paths.get_output_directory()) / "video-flow"


class VideoFlowLoadResult:
    """下载已就绪的产物；接收 Wait 输出的 taskId，不接受 task JSON。"""

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
        # 允许重新查询/重新下载，而不是复用 ComfyUI 缓存的旧路径。
        return requery_nonce()

    def download(self, config, task_id):
        client = VideoFlowClient(config)
        result = client.download_task_result(str(task_id), default_output_dir())
        note = client.cost_note(result)
        print(f"[video-flow] task {task_id} downloaded to {result['localPath']}; {note}")
        return (result["localPath"], note)


NODE_CLASS_MAPPINGS = {
    "VideoFlowConfig": VideoFlowConfigNode,
    "VideoFlowSeedancePreview": VideoFlowSeedancePreview,
    "VideoFlowSeedanceProduction": VideoFlowSeedanceProduction,
    "VideoFlowWaitTask": VideoFlowWaitTask,
    "VideoFlowLoadResult": VideoFlowLoadResult,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "VideoFlowConfig": "Video Flow Config",
    "VideoFlowSeedancePreview": "Seedance Preview",
    "VideoFlowSeedanceProduction": "Seedance Production",
    "VideoFlowWaitTask": "Wait Video Flow Task",
    "VideoFlowLoadResult": "Load Video Flow Result",
}
