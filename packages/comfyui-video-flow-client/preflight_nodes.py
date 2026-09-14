"""One connected graph: local media -> server preflight -> confirmed submission.

Node IDs are namespaced to avoid overriding the installed legacy Ark plugin.
"""
import hashlib
import json
import time
from datetime import datetime
from io import BytesIO
from pathlib import Path

from PIL import Image
try:
    from .client import VideoFlowClient
    from .receipts import ReceiptStore, credential_namespace
except ImportError:
    from client import VideoFlowClient
    from receipts import ReceiptStore, credential_namespace


def require_server_success(response):
    if response.status_code >= 400:
        try:
            message = response.json().get('message', '服务器未通过检查')
        except (ValueError, AttributeError):
            message = '服务器未返回有效检查报告'
        raise ValueError(f"服务器预检未通过（HTTP {response.status_code}）：{message}")


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def inspect_product(filename):
    import folder_paths
    root = Path(folder_paths.get_input_directory()).resolve()
    path = Path(folder_paths.get_annotated_filepath(filename)).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise ValueError("产品图不存在或不在 ComfyUI input 目录")
    if not 0 < path.stat().st_size < 30 * 1024 * 1024:
        raise ValueError("产品图必须小于 30 MB")
    data = path.read_bytes()
    with Image.open(BytesIO(data)) as im:
        im.load()
        mime = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp"}.get(im.format)
        w, h = im.size
        if not mime or getattr(im, "n_frames", 1) != 1:
            raise ValueError("首条工作流支持静态 PNG、JPEG、WebP 产品图")
        if not (300 <= w <= 6000 and 300 <= h <= 6000 and .4 <= w / h <= 2.5):
            raise ValueError("图片边长须为 300–6000 像素，宽高比须为 0.4–2.5")
    return {"data": data, "filename": path.name, "descriptor": {
        "sha256": hashlib.sha256(data).hexdigest(), "role": "reference_image",
        "mimeType": mime, "sizeBytes": len(data), "metadata": {"kind": "image", "width": w, "height": h},
    }}


def store(config):
    return ReceiptStore(Path(config.receipt_dir).expanduser() / "preflights", credential_namespace(config.backend_url, config.token))


def valid_policy(policy):
    if not isinstance(policy, dict) or policy.get("mode") not in ("preview", "production"):
        raise ValueError("运行方式无效，请重新选择 Preview")
    if policy["mode"] == "production" and policy.get("confirmed") is not True:
        raise ValueError("正式生成需要明确确认")
    return policy["mode"]


class ExecutionPolicy:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"mode": (["preview", "production"], {"default": "preview"}), "confirm_live_submission": ("BOOLEAN", {"default": False})}}
    RETURN_TYPES = ("VIDEO_FLOW_EXECUTION_POLICY",)
    RETURN_NAMES = ("execution_policy",)
    FUNCTION = "execute"
    CATEGORY = "Video Flow/Seedance"
    def execute(self, mode="preview", confirm_live_submission=False):
        policy = {"mode": mode, "confirmed": confirm_live_submission}
        valid_policy(policy)
        return (policy,)


class ProductInput:
    @classmethod
    def INPUT_TYPES(cls):
        import folder_paths
        root = Path(folder_paths.get_input_directory())
        images = sorted(str(p.relative_to(root)) for p in root.rglob('*') if p.is_file() and p.suffix.lower() in ('.png', '.jpg', '.jpeg', '.webp'))
        return {"required": {"image": (images or ["请选择产品图"], {"image_upload": True})}}
    RETURN_TYPES = ("VIDEO_FLOW_LOCAL_MEDIA",)
    RETURN_NAMES = ("media",)
    FUNCTION = "inspect"
    CATEGORY = "Video Flow/Seedance"
    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float('nan')  # Re-read bytes even if the filename stays the same.
    def inspect(self, image):
        return (inspect_product(image),)


class ProductRequest:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"media": ("VIDEO_FLOW_LOCAL_MEDIA",), "prompt": ("STRING", {"multiline": True}),
            "duration": ([5],), "ratio": (["16:9"],), "resolution": (["720p"],)}}
    RETURN_TYPES = ("VIDEO_FLOW_PREFLIGHT_REQUEST",)
    RETURN_NAMES = ("request",)
    FUNCTION = "build"
    CATEGORY = "Video Flow/Seedance"
    def build(self, media, prompt, duration=5, ratio="16:9", resolution="720p"):
        if not prompt.strip() or len(prompt.strip()) > 4000:
            raise ValueError("提示词不能为空，且不超过 4000 字符")
        intent = {"workflowKey": "seedance.reference-image-to-video.v1", "prompt": {"positive": prompt.strip()},
            "generation": {"duration": duration, "ratio": ratio, "resolution": resolution}, "media": [media["descriptor"]]}
        return ({"intent": intent, "media": media},)


class RequestPreview:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"config": ("VIDEO_FLOW_CONFIG",), "execution_policy": ("VIDEO_FLOW_EXECUTION_POLICY",), "request": ("VIDEO_FLOW_PREFLIGHT_REQUEST",)}}
    RETURN_TYPES = ("VIDEO_FLOW_CHECKED_REQUEST",)
    RETURN_NAMES = ("checked_request",)
    FUNCTION = "check"
    CATEGORY = "Video Flow/Seedance"
    OUTPUT_NODE = True
    @classmethod
    def IS_CHANGED(cls, **kwargs): return float('nan')
    def check(self, config, execution_policy, request):
        mode = valid_policy(execution_policy)
        key = fingerprint(request["intent"])
        receipts = store(config)
        if mode == "preview":
            # Erase stale green state before any network operation can fail.
            receipts.save(key, {"status": "checking"})
            client = VideoFlowClient(config)
            response = client.client.post(f"{config.backend_url}/api/v1/tasks/preflight", headers=client._headers(), json=request["intent"])
            require_server_success(response)
            record = response.json()
            if not record.get("preflightId") or record.get("willCallProvider") is not False or record.get("willUploadMedia") is not False:
                raise ValueError("服务器预检返回不完整，禁止正式生成")
            receipts.save(key, record)
        else:
            record = receipts.load(key) or {}
        if not record.get("preflightId"):
            raise ValueError("本次内容尚未通过 Preview，请先切回 Preview 检查")
        expires = datetime.fromisoformat(record["expiresAt"].replace('Z', '+00:00')).timestamp()
        if time.time() >= expires:
            raise ValueError("预检已过期，请重新运行 Preview")
        if mode == 'production':
            client = VideoFlowClient(config)
            response = client.client.get(f"{config.backend_url}/api/v1/tasks/preflight/{record['preflightId']}/check", headers=client._headers())
            require_server_success(response)
            if response.json().get('valid') is not True: raise ValueError("服务器预检记录已失效")
        result = {**request, "record": record, "mode": mode, "intent_key": key}
        report = {"message": "预检通过，未上传素材、未生成视频" if mode == 'preview' else "已读取本次预检，正式提交时服务器再次核对",
            "request": request["intent"], "effectiveSpec": record.get("effectiveSpec"), "checks": record.get("checks"), "expiresAt": record["expiresAt"]}
        return {"ui": {"text": [json.dumps(report, ensure_ascii=False, indent=2)]}, "result": (result,)}


class CreateTask:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"config": ("VIDEO_FLOW_CONFIG",), "execution_policy": ("VIDEO_FLOW_EXECUTION_POLICY",),
            "checked_request": ("VIDEO_FLOW_CHECKED_REQUEST",), "generation_version": ("INT", {"default": 1, "min": 1})}}
    RETURN_TYPES = ("VIDEO_FLOW_EXECUTION_RESULT",)
    RETURN_NAMES = ("task",)
    FUNCTION = "submit"
    CATEGORY = "Video Flow/Seedance"
    @classmethod
    def IS_CHANGED(cls, **kwargs): return float('nan')
    def submit(self, config, execution_policy, checked_request, generation_version=1):
        mode = valid_policy(execution_policy)
        if mode == "preview": return ({"mode": "preview"},)
        if checked_request.get("mode") != mode: raise ValueError("预检与运行方式不一致")
        client = VideoFlowClient(config)
        request = checked_request
        intent_key = fingerprint([request['intent_key'], generation_version, request['record']['effectiveSpec']])
        receipt_store = client.receipt_store(config.receipt_dir)
        existing = receipt_store.load(intent_key)
        if existing:
            task = client.create_task_with_receipt(intent_key=intent_key, idempotency_key=intent_key, payload={}, mode='production', receipt_store=receipt_store)
        else:
            media = request['media']
            if hashlib.sha256(media['data']).hexdigest() != request['intent']['media'][0]['sha256']:
                raise ValueError("素材与预检不一致，请重新 Preview")
            uploaded = client.upload_media(media['data'], filename=media['filename'], mime_type=media['descriptor']['mimeType'])
            payload = {**request['intent'], 'media': [{'assetId': uploaded['assetId'], 'role': 'reference_image'}],
                'preflightId': request['record']['preflightId'], 'confirmLiveSubmission': True}
            task = client.create_task_with_receipt(intent_key=intent_key, idempotency_key=intent_key, payload=payload, mode='production', receipt_store=receipt_store)
        return ({'mode': 'production', 'task_id': str(task['id'])},)


class WaitTask:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"config": ("VIDEO_FLOW_CONFIG",), "task": ("VIDEO_FLOW_EXECUTION_RESULT",), "timeout_seconds": ("INT", {"default": 1200, "min": 30})}}
    RETURN_TYPES = ("VIDEO_FLOW_EXECUTION_RESULT",)
    RETURN_NAMES = ("task",)
    FUNCTION = 'wait'
    CATEGORY = "Video Flow/Seedance"
    @classmethod
    def IS_CHANGED(cls, **kwargs): return float('nan')
    def wait(self, config, task, timeout_seconds=1200):
        if task['mode'] == 'production': VideoFlowClient(config).wait_for_task(task['task_id'], timeout_seconds=timeout_seconds)
        return (task,)


class DownloadResult:
    @classmethod
    def INPUT_TYPES(cls): return {"required": {"config": ("VIDEO_FLOW_CONFIG",), "task": ("VIDEO_FLOW_EXECUTION_RESULT",)}}
    RETURN_TYPES = ('STRING',)
    RETURN_NAMES = ('local_video_path',)
    OUTPUT_NODE = True
    FUNCTION = 'download'
    CATEGORY = "Video Flow/Seedance"
    @classmethod
    def IS_CHANGED(cls, **kwargs): return float('nan')
    def download(self, config, task):
        if task['mode'] == 'preview':
            return {'ui': {'text': ['Preview 已结束：未生成视频，未执行等待或下载']}, 'result': ('',)}
        import folder_paths
        result = VideoFlowClient(config).download_task_result(task['task_id'], Path(folder_paths.get_output_directory()) / 'video-flow')
        return {'ui': {'text': [result['localPath']]}, 'result': (result['localPath'],)}


CLASSES = {"VideoFlowExecutionPolicy": ExecutionPolicy, "VideoFlowProductInput": ProductInput,
    "VideoFlowProductRequest": ProductRequest, "VideoFlowRequestPreflight": RequestPreview,
    "VideoFlowConfirmedCreate": CreateTask, "VideoFlowPolicyWait": WaitTask, "VideoFlowPolicyDownload": DownloadResult}
NAMES = dict(zip(CLASSES, ["运行方式｜先预检，确认后正式生成", "产品图｜选择与本地检查", "成片要求｜产品参考图生视频", "请求预检｜本地信息与服务器规则", "正式提交｜仅预检通过且确认后", "等待云端任务完成", "下载并保存成片"]))
