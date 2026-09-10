from io import BytesIO

import numpy as np
from PIL import Image

from .client import VideoFlowClient
from .config import VideoFlowConfig


class VideoFlowConfigNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"backend_url": ("STRING", {"default": "http://localhost:3100"}), "token": ("STRING", {"default": "", "multiline": False}), "protocol_version": ("STRING", {"default": "1"})}}

    RETURN_TYPES = ("VIDEO_FLOW_CONFIG",)
    FUNCTION = "configure"
    CATEGORY = "Video Flow"

    def configure(self, backend_url, token, protocol_version):
        return (VideoFlowConfig(backend_url.rstrip("/"), token, protocol_version),)


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


NODE_CLASS_MAPPINGS = {
    "VideoFlowConfig": VideoFlowConfigNode,
    "VideoFlowSeedancePreview": VideoFlowSeedancePreview,
    "VideoFlowWaitTask": VideoFlowWaitTask,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "VideoFlowConfig": "Video Flow Config",
    "VideoFlowSeedancePreview": "Seedance Preview",
    "VideoFlowWaitTask": "Wait Video Flow Task",
}
