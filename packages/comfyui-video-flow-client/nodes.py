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


def _available_product_images() -> list[str]:
    """读取 ComfyUI input 目录，供单节点的上传控件使用。"""
    try:
        import folder_paths
        input_dir = folder_paths.get_input_directory()
        files = [
            path.name for path in Path(input_dir).iterdir()
            if path.is_file() and path.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}
        ]
        return sorted(files) or ["上传产品图"]
    except (ImportError, OSError):
        return ["上传产品图"]


def _load_product_image(filename: str):
    """从 ComfyUI input 目录加载一张静态产品图，转换为 IMAGE 张量。"""
    try:
        import folder_paths
        import torch
    except ImportError as error:
        raise RuntimeError("Video Flow 产品图上传仅能在 ComfyUI 中运行") from error

    path = folder_paths.get_annotated_filepath(filename)
    with Image.open(path) as source:
        pixels = np.asarray(source.convert("RGB"), dtype=np.float32) / 255.0
    return torch.from_numpy(pixels)[None,]


class VideoFlowConfigNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"backend_url": ("STRING", {"default": VideoFlowConfig.from_env().backend_url}), "protocol_version": ("STRING", {"default": "1"})}}

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
        summary = {"mode": "preview", "workflowKey": "seedance.reference-image-to-video.v1", "prompt": prompt, "input": "reference.png"}
        task = client.create_task(
            idempotency_key=client.stable_idempotency_key(
                prompt, image_bytes, workflow_key="seedance.reference-image-to-video.v1",
                duration=5, ratio="16:9", resolution="720p",
            ),
            payload={
                "workflowKey": "seedance.reference-image-to-video.v1",
                "prompt": {"positive": prompt},
                "generation": {"duration": 5, "ratio": "16:9", "resolution": "720p"},
                "media": [{"assetId": uploaded["assetId"], "role": "reference_image"}],
            },
        )
        return (str(task["id"]), str(summary))


class VideoFlowSeedanceProduction:
    """已实测的参考图片生视频工作流。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "config": ("VIDEO_FLOW_CONFIG",),
                "prompt": ("STRING", {"multiline": True}),
                "image": ("IMAGE",),
                # 当前生产注册表固定为已验收规格，避免节点暴露会被后端拒绝的假选项。
                "generation_version": ("INT", {"default": 1, "min": 1, "max": 9999}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("task_id",)
    FUNCTION = "submit"
    CATEGORY = "Video Flow/Seedance"

    @classmethod
    def IS_CHANGED(cls, *args, **kwargs):
        return requery_nonce()

    def submit(self, config, prompt, image, generation_version=1):
        client = VideoFlowClient(config)
        pixels = np.clip(image[0].cpu().numpy() * 255, 0, 255).astype(np.uint8)
        buffer = BytesIO()
        Image.fromarray(pixels).save(buffer, format="PNG")
        image_bytes = buffer.getvalue()
        uploaded = client.upload_media(image_bytes, filename="reference.png", mime_type="image/png")
        intent_key = client.stable_idempotency_key(
            prompt, image_bytes, workflow_key="seedance.reference-image-to-video.v1",
            duration=5, ratio="16:9", resolution="720p", generation_version=generation_version,
            spec_version=config.spec_version,
        )
        task = client.create_task_with_receipt(
            idempotency_key=intent_key,
            mode="production",
            payload={
                "workflowKey": "seedance.reference-image-to-video.v1",
                "prompt": {"positive": prompt},
                "generation": {"duration": 5, "ratio": "16:9", "resolution": "720p"},
                "media": [{"assetId": uploaded["assetId"], "role": "reference_image"}],
            },
            intent_key=intent_key,
            receipt_store=client.receipt_store(config.receipt_dir),
        )
        return (str(task["id"]),)


class VideoFlowSeedanceOneClickProductVideo:
    """创意人员的单节点入口：产品图 → 真实出片 → 本地下载。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "prompt": ("STRING", {"multiline": True, "default": "产品置于干净的高级摄影棚背景中，镜头缓慢推进，柔和侧光突出产品材质与轮廓，画面稳定、真实、无文字、无人物。"}),
                "product_image": (_available_product_images(), {"image_upload": True}),
                "generation_version": ("INT", {"default": 1, "min": 1, "max": 9999}),
                "timeout_seconds": ("INT", {"default": 1200, "min": 30, "max": 7200}),
            }
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("local_video_path", "cost_status")
    OUTPUT_NODE = True
    FUNCTION = "generate"
    CATEGORY = "Video Flow/Seedance"

    @classmethod
    def IS_CHANGED(cls, *args, **kwargs):
        return requery_nonce()

    def generate(self, prompt, product_image, generation_version=1, timeout_seconds=1200):
        config = VideoFlowConfig.from_env()
        image = _load_product_image(product_image)
        task_id = VideoFlowSeedanceProduction().submit(
            config, prompt, image, generation_version
        )[0]
        task_id = VideoFlowWaitTask().wait(
            config, task_id, timeout_seconds
        )[0]
        return VideoFlowLoadResult().download(config, task_id)


class VideoFlowSeedanceTextToVideo:
    """文本生视频节点。后端当前只允许预览，Production 会明确拒绝。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "config": ("VIDEO_FLOW_CONFIG",),
                "prompt": ("STRING", {"multiline": True}),
                "generation_version": ("INT", {"default": 1, "min": 1, "max": 9999}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("preview_task_id",)
    FUNCTION = "submit"
    CATEGORY = "Video Flow/Seedance"

    def submit(self, config, prompt, generation_version=1):
        client = VideoFlowClient(config)
        intent_key = client.stable_idempotency_key(
            prompt, workflow_key="seedance.text-to-video.v1", duration=5,
            ratio="16:9", resolution="720p", generation_version=generation_version,
            spec_version=config.spec_version,
        )
        task = client.create_task(
            idempotency_key=intent_key,
            mode="preview",
            payload={
                "workflowKey": "seedance.text-to-video.v1",
                "prompt": {"positive": prompt},
                "generation": {"duration": 5, "ratio": "16:9", "resolution": "720p"},
                "media": [],
            },
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
    "VideoFlowSeedanceOneClickProductVideo": VideoFlowSeedanceOneClickProductVideo,
    "VideoFlowSeedanceTextToVideo": VideoFlowSeedanceTextToVideo,
    "VideoFlowWaitTask": VideoFlowWaitTask,
    "VideoFlowLoadResult": VideoFlowLoadResult,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "VideoFlowConfig": "Video Flow Config",
    "VideoFlowSeedancePreview": "Seedance Preview",
    "VideoFlowSeedanceProduction": "Seedance Reference Image to Video",
    "VideoFlowSeedanceOneClickProductVideo": "Seedance Product Video (One Click)",
    "VideoFlowSeedanceTextToVideo": "Seedance Text to Video (Preview)",
    "VideoFlowWaitTask": "Wait Video Flow Task",
    "VideoFlowLoadResult": "Load Video Flow Result",
}
