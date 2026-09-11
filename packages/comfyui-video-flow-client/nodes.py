from io import BytesIO
from pathlib import Path

import numpy as np
from PIL import Image

try:
    from .client import VideoFlowClient
    from .config import VideoFlowConfig
except ImportError:  # Support ComfyUI's direct module loader.
    from client import VideoFlowClient
    from config import VideoFlowConfig


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
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("task_id",)
    FUNCTION = "submit"
    CATEGORY = "Video Flow"

    def submit(self, config, prompt, image, duration, ratio):
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
        task = client.create_task(
            idempotency_key=client.stable_idempotency_key(
                prompt,
                image_bytes,
                profile="seedance",
                duration=duration,
                ratio=ratio,
            ),
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
        )
        return (str(task["id"]),)


class VideoFlowWaitTask:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"config": ("VIDEO_FLOW_CONFIG",), "task_id": ("STRING",)}}

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("task_json",)
    FUNCTION = "wait"
    CATEGORY = "Video Flow"

    def wait(self, config, task_id):
        return (str(VideoFlowClient(config).get_task(task_id)),)


def default_output_dir() -> Path:
    # 安装位置为 <ComfyUI>/custom_nodes/video_flow_client/nodes.py。
    return Path(__file__).resolve().parents[2] / "output" / "video-flow"


class VideoFlowLoadResult:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "config": ("VIDEO_FLOW_CONFIG",),
                "task_id": ("STRING",),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("local_video_path",)
    OUTPUT_NODE = True
    FUNCTION = "download"
    CATEGORY = "Video Flow"

    def download(self, config, task_id):
        result = VideoFlowClient(config).download_task_result(
            task_id,
            default_output_dir(),
        )
        return (result["localPath"],)


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
