"""One connected graph: local media -> server preflight -> confirmed submission.

Node IDs are namespaced to avoid overriding the installed legacy Ark plugin.
"""
import hashlib
import json
import time
from datetime import datetime
from pathlib import Path

try:
    from .client import VideoFlowClient
    from .media_inspection import inspect_media, read_verified_media
    from .receipts import ReceiptStore, credential_namespace
except ImportError:
    from client import VideoFlowClient
    from media_inspection import inspect_media, read_verified_media
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


def inspect_product(filename, role="reference_image", slot_id=None):
    import folder_paths
    root = Path(folder_paths.get_input_directory()).resolve()
    path = Path(folder_paths.get_annotated_filepath(filename)).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise ValueError("素材不存在或不在 ComfyUI input 目录")
    return inspect_media(path, role, slot_id or role.replace('_', '-'))


def generation_request(duration, ratio, resolution):
    return {"duration": duration, "ratio": ratio, "resolution": resolution,
            "generateAudio": True, "watermark": False, "outputFormat": "mp4"}


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
            "duration": (list(range(4, 31)),), "ratio": (["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],),
            "resolution": (["480p", "720p", "1080p"],)}}
    RETURN_TYPES = ("VIDEO_FLOW_PREFLIGHT_REQUEST",)
    RETURN_NAMES = ("request",)
    FUNCTION = "build"
    CATEGORY = "Video Flow/Seedance"
    def build(self, media, prompt, duration=5, ratio="16:9", resolution="720p"):
        if not prompt.strip() or len(prompt.strip()) > 4000:
            raise ValueError("提示词不能为空，且不超过 4000 字符")
        intent = {"contractVersion": 2, "workflowKey": "seedance.reference-image-to-video.v1", "prompt": {"positive": prompt.strip()},
            "generation": generation_request(duration, ratio, resolution), "media": [media["descriptor"]]}
        return ({"intent": intent, "media": media},)


class TextRequest:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"prompt": ("STRING", {"multiline": True}),
            "duration": (list(range(4, 31)),), "ratio": (["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],),
            "resolution": (["480p", "720p", "1080p"],)}}
    RETURN_TYPES = ("VIDEO_FLOW_PREFLIGHT_REQUEST",)
    RETURN_NAMES = ("request",)
    FUNCTION = "build"
    CATEGORY = "Video Flow/Seedance"
    def build(self, prompt, duration=5, ratio="16:9", resolution="720p"):
        if not prompt.strip() or len(prompt.strip()) > 4000:
            raise ValueError("提示词不能为空，且不超过 4000 字符")
        return ({"intent": {"contractVersion": 2, "workflowKey": "seedance.text-to-video.v1", "prompt": {"positive": prompt.strip()},
            "generation": generation_request(duration, ratio, resolution), "media": []}},)


def _image_choices():
    import folder_paths
    root = Path(folder_paths.get_input_directory())
    return sorted(str(p.relative_to(root)) for p in root.rglob('*') if p.is_file() and p.suffix.lower() in ('.png', '.jpg', '.jpeg', '.webp')) or ["请选择图片"]


class MultiReferenceInput:
    @classmethod
    def INPUT_TYPES(cls):
        choices = ["不使用"] + [item for item in _image_choices() if item != "请选择图片"]
        return {"required": {"image_1": (choices, {"image_upload": True}), "image_2": (choices, {"image_upload": True}), "image_3": (choices, {"image_upload": True})}}
    RETURN_TYPES = ("VIDEO_FLOW_LOCAL_MEDIA_LIST",)
    RETURN_NAMES = ("reference_media",)
    FUNCTION = "inspect"
    CATEGORY = "Video Flow/Seedance"
    @classmethod
    def IS_CHANGED(cls, **kwargs): return float('nan')
    def inspect(self, image_1="不使用", image_2="不使用", image_3="不使用"):
        selected = [item for item in (image_1, image_2, image_3) if item and item != "不使用"]
        if not selected: raise ValueError("至少选择一张参考图")
        return ([inspect_product(item, "reference_image", f"reference-image-{index}") for index, item in enumerate(selected, 1)],)


class MultiReferenceRequest:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"reference_media": ("VIDEO_FLOW_LOCAL_MEDIA_LIST",), "prompt": ("STRING", {"multiline": True}),
            "duration": (list(range(4, 31)),), "ratio": (["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],),
            "resolution": (["480p", "720p", "1080p"],)}}
    RETURN_TYPES = ("VIDEO_FLOW_PREFLIGHT_REQUEST",)
    RETURN_NAMES = ("request",)
    FUNCTION = "build"
    CATEGORY = "Video Flow/Seedance"
    def build(self, reference_media, prompt, duration=5, ratio="16:9", resolution="720p"):
        if not prompt.strip() or len(prompt.strip()) > 4000: raise ValueError("提示词不能为空，且不超过 4000 字符")
        if not reference_media: raise ValueError("至少需要一张参考图")
        return ({"intent": {"contractVersion": 2, "workflowKey": "seedance.omni-reference.v1", "prompt": {"positive": prompt.strip()},
            "generation": generation_request(duration, ratio, resolution),
            "media": [item["descriptor"] for item in reference_media]}, "media": reference_media},)


class FirstFrameInput:
    @classmethod
    def INPUT_TYPES(cls): return {"required": {"image": (_image_choices(), {"image_upload": True})}}
    RETURN_TYPES = ("VIDEO_FLOW_LOCAL_MEDIA",)
    RETURN_NAMES = ("first_frame",)
    FUNCTION = "inspect"
    CATEGORY = "Video Flow/Seedance"
    @classmethod
    def IS_CHANGED(cls, **kwargs): return float('nan')
    def inspect(self, image): return (inspect_product(image, "first_frame", "first-frame"),)


class FirstLastFrameInput:
    @classmethod
    def INPUT_TYPES(cls): return {"required": {"first_image": (_image_choices(), {"image_upload": True}), "last_image": (_image_choices(), {"image_upload": True})}}
    RETURN_TYPES = ("VIDEO_FLOW_LOCAL_MEDIA", "VIDEO_FLOW_LOCAL_MEDIA")
    RETURN_NAMES = ("first_frame", "last_frame")
    FUNCTION = "inspect"
    CATEGORY = "Video Flow/Seedance"
    @classmethod
    def IS_CHANGED(cls, **kwargs): return float('nan')
    def inspect(self, first_image, last_image): return (inspect_product(first_image, "first_frame", "first-frame"), inspect_product(last_image, "last_frame", "last-frame"))


class FirstFrameRequest:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"media": ("VIDEO_FLOW_LOCAL_MEDIA",), "prompt": ("STRING", {"multiline": True}),
            "duration": (list(range(4, 31)),), "ratio": (["adaptive"],), "resolution": (["480p", "720p", "1080p"],)}}
    RETURN_TYPES = ("VIDEO_FLOW_PREFLIGHT_REQUEST",)
    RETURN_NAMES = ("request",)
    FUNCTION = "build"
    CATEGORY = "Video Flow/Seedance"
    def build(self, media, prompt, duration=5, ratio="adaptive", resolution="720p"):
        if not prompt.strip() or len(prompt.strip()) > 4000: raise ValueError("提示词不能为空，且不超过 4000 字符")
        return ({"intent": {"contractVersion": 2, "workflowKey": "seedance.first-frame-to-video.v1", "prompt": {"positive": prompt.strip()},
            "generation": generation_request(duration, ratio, resolution), "media": [media["descriptor"]]},
            "media": [media]},)


class FirstLastFrameRequest:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"first_frame": ("VIDEO_FLOW_LOCAL_MEDIA",), "last_frame": ("VIDEO_FLOW_LOCAL_MEDIA",), "prompt": ("STRING", {"multiline": True}),
            "duration": (list(range(4, 31)),), "ratio": (["adaptive"],), "resolution": (["480p", "720p", "1080p"],)}}
    RETURN_TYPES = ("VIDEO_FLOW_PREFLIGHT_REQUEST",)
    RETURN_NAMES = ("request",)
    FUNCTION = "build"
    CATEGORY = "Video Flow/Seedance"
    def build(self, first_frame, last_frame, prompt, duration=5, ratio="adaptive", resolution="720p"):
        if not prompt.strip() or len(prompt.strip()) > 4000: raise ValueError("提示词不能为空，且不超过 4000 字符")
        return ({"intent": {"contractVersion": 2, "workflowKey": "seedance.first-last-frame-to-video.v1", "prompt": {"positive": prompt.strip()},
            "generation": generation_request(duration, ratio, resolution),
            "media": [first_frame["descriptor"], last_frame["descriptor"]]},
            "media": [first_frame, last_frame]},)


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
            record = response.json()
            if record.get('requestCheck', {}).get('status') != 'passed': raise ValueError("服务器预检记录已失效")
            if record.get('productionAdmission', {}).get('canSubmit') is not True: raise ValueError("当前不满足正式提交条件")
        result = {**request, "record": record, "mode": mode, "intent_key": key}
        report = {"message": "Preview 已完成，未上传素材、未生成视频" if mode == 'preview' else "已复验本次预检，正式提交时服务器再次核对",
            "request": request["intent"], "effectiveRequest": record.get("effectiveRequest"),
            "requestCheck": record.get("requestCheck"), "productionAdmission": record.get("productionAdmission"),
            "quote": record.get("quote"), "expiresAt": record["expiresAt"]}
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
        intent_key = fingerprint([
            request['intent_key'], generation_version, request['record'].get('intentDigest'),
            request['record'].get('quote', {}).get('quoteDigest'),
        ])
        receipt_store = client.receipt_store(config.receipt_dir)
        existing = receipt_store.load(intent_key)
        if existing:
            task = client.create_task_with_receipt(intent_key=intent_key, idempotency_key=intent_key, payload={}, mode='production', receipt_store=receipt_store)
        else:
            local_media = request.get('media', [])
            if isinstance(local_media, dict):
                local_media = [local_media]
            uploaded_media = []
            for index, media in enumerate(local_media):
                expected = request['intent']['media'][index]
                data = read_verified_media(media)
                uploaded = client.upload_media(data, filename=media['filename'], mime_type=media['descriptor']['mimeType'])
                uploaded_media.append({'assetId': uploaded['assetId'], 'role': expected['role']})
            payload = {**request['intent'], 'media': uploaded_media,
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


class PolicyPreview:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"local_video_path": ("STRING", {"default": "", "multiline": False})}}
    RETURN_TYPES = ('STRING',)
    RETURN_NAMES = ('local_video_path',)
    OUTPUT_NODE = True
    FUNCTION = 'preview'
    CATEGORY = "Video Flow/Seedance"
    @classmethod
    def IS_CHANGED(cls, **kwargs): return float('nan')
    def preview(self, local_video_path):
        if not local_video_path:
            return {'ui': {'text': ['Preview 未生成视频，当前没有可预览的文件']}, 'result': ('',)}
        import folder_paths
        output_root = Path(folder_paths.get_output_directory()).resolve()
        path = Path(local_video_path).expanduser().resolve()
        if not path.is_file() or not path.is_relative_to(output_root):
            raise ValueError("视频必须存在于 ComfyUI output 目录")
        relative = path.relative_to(output_root)
        subfolder = '' if str(relative.parent) == '.' else str(relative.parent)
        # ComfyUI 0.35.x 的前端沿用旧 Seedance 节点的兼容格式：MP4
        # 作为 animated image 结果返回。单独返回 ui.videos 在该前端不会显示。
        return {'ui': {'images': [{'filename': relative.name, 'subfolder': subfolder, 'type': 'output'}],
                       'animated': (True,)},
                'result': (str(path),)}


CLASSES = {"VideoFlowExecutionPolicy": ExecutionPolicy, "VideoFlowProductInput": ProductInput,
    "VideoFlowProductRequest": ProductRequest, "VideoFlowTextRequest": TextRequest, "VideoFlowFirstFrameInput": FirstFrameInput,
    "VideoFlowFirstLastFrameInput": FirstLastFrameInput, "VideoFlowFirstFrameRequest": FirstFrameRequest,
    "VideoFlowFirstLastFrameRequest": FirstLastFrameRequest, "VideoFlowMultiReferenceInput": MultiReferenceInput,
    "VideoFlowMultiReferenceRequest": MultiReferenceRequest, "VideoFlowRequestPreflight": RequestPreview,
    "VideoFlowConfirmedCreate": CreateTask, "VideoFlowPolicyWait": WaitTask, "VideoFlowPolicyDownload": DownloadResult,
    "VideoFlowPolicyPreview": PolicyPreview}
NAMES = dict(zip(CLASSES, ["运行方式｜先预检，确认后正式生成", "产品图｜选择与本地检查", "成片要求｜产品参考图生视频", "文生视频要求｜Prompt 生视频", "首帧图｜选择与本地检查", "首尾帧图｜选择与本地检查", "首帧成片要求｜首帧图生视频", "首尾帧成片要求｜两帧图生视频", "多参考图｜最多三张本地图片", "多参考成片要求｜文+参考图", "请求预检｜本地信息与服务器规则", "正式提交｜仅预检通过且确认后", "等待云端任务完成", "下载并保存成片", "成片预览｜本地播放"]))
