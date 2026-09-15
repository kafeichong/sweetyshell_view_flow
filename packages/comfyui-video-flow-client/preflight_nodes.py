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
    from .execution_slot import normalize_execution_slot_id
    from .media_inspection import inspect_media, read_verified_media, validate_media_collection
    from .receipts import ReceiptStore, credential_namespace
    from .submission_state import (
        begin_submission_round,
        load_verified_local_delivery,
        record_confirmed,
        record_downloaded,
        recover_current,
    )
except ImportError:
    from client import VideoFlowClient
    from execution_slot import normalize_execution_slot_id
    from media_inspection import inspect_media, read_verified_media, validate_media_collection
    from receipts import ReceiptStore, credential_namespace
    from submission_state import (
        begin_submission_round,
        load_verified_local_delivery,
        record_confirmed,
        record_downloaded,
        recover_current,
    )


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


def preflight_is_current(record):
    if not isinstance(record, dict) or not record.get("preflightId") or not record.get("expiresAt"):
        return False
    try:
        expires = datetime.fromisoformat(record["expiresAt"].replace('Z', '+00:00')).timestamp()
    except (TypeError, ValueError):
        return False
    return time.time() < expires


def valid_policy(policy):
    if not isinstance(policy, dict) or policy.get("mode") not in ("preview", "production"):
        raise ValueError("运行方式无效，请重新选择 Preview")
    return policy["mode"]


def preflight_report(record, message):
    """Render only the server-authoritative request and Preview side effects."""
    return {
        "message": message,
        "effectiveRequest": record.get("effectiveRequest"),
        "requestCheck": record.get("requestCheck"),
        "mediaTransfer": {
            "uploaded": False,
            "willUploadDuringPreview": False,
        },
        "quote": record.get("quote"),
        "productionAdmission": record.get("productionAdmission"),
        "expiresAt": record.get("expiresAt"),
    }


def task_notice(task, result):
    """一行给用户看的提交摘要。

    ComfyUI 只在节点返回 `ui` 键时才发 `executed` 事件，所以这条摘要是用户看到
    taskId 的唯一通道——而报障、查询和重新取片都要用到它。

    默认脱敏：只给任务标识、执行槽和预占金额；不含提示词、签名 URL 或凭证。
    金额明确写成"预占"，它是内部预算依据，不是 Provider 账单。
    """
    plan = task.get('executionPlan') or {}
    parts = [f"正式任务 {result['task_id']}"]
    if result.get('execution_slot_id'):
        parts.append(f"执行槽 {result['execution_slot_id']}")
    reserved = plan.get('reserveCny')
    if reserved:
        parts.append(f"预占 {reserved} 元（最终按实际用量结算，不是账单）")
    if result.get('recovered'):
        parts.append('沿用原任务')
    parts.append('已提交，等待生成')
    return '；'.join(parts)


class ExecutionPolicy:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"mode": (["preview", "production"], {"default": "preview"})}}
    RETURN_TYPES = ("VIDEO_FLOW_EXECUTION_POLICY",)
    RETURN_NAMES = ("execution_policy",)
    FUNCTION = "execute"
    CATEGORY = "Video Flow/Seedance"
    def execute(self, mode="preview"):
        policy = {"mode": mode}
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
    return _file_choices(('.png', '.jpg', '.jpeg', '.webp'), "请选择图片")


def _file_choices(suffixes, empty_label):
    import folder_paths
    root = Path(folder_paths.get_input_directory())
    return sorted(str(p.relative_to(root)) for p in root.rglob('*') if p.is_file() and p.suffix.lower() in suffixes) or [empty_label]


REFERENCE_MEDIA_LIMITS = {
    "reference_image": (30, "参考图片最多 30 张"),
    "reference_video": (10, "参考视频最多 10 段"),
    "reference_audio": (10, "参考音频最多 10 段"),
}


def _validated_reference_media(reference_media):
    media = list(reference_media or [])
    if len(media) > 50:
        raise ValueError("参考素材总数最多 50 个")
    for role, (maximum, message) in REFERENCE_MEDIA_LIMITS.items():
        if sum(item.get("descriptor", {}).get("role") == role for item in media) > maximum:
            raise ValueError(message)
    try:
        validate_media_collection(media)
    except ValueError as error:
        raise ValueError(str(error)) from error
    return media


def _append_reference_media(reference_media, filename, role):
    media = _validated_reference_media(reference_media)
    role_count = sum(item.get("descriptor", {}).get("role") == role for item in media)
    maximum, message = REFERENCE_MEDIA_LIMITS[role]
    if role_count >= maximum:
        raise ValueError(message)
    if len(media) >= 50:
        raise ValueError("参考素材总数最多 50 个")
    media.append(inspect_product(filename, role, f"{role.replace('_', '-')}-{role_count + 1}"))
    return _validated_reference_media(media)


class ReferenceImageInput:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"image": (_image_choices(), {"image_upload": True})},
            "optional": {"reference_media": ("VIDEO_FLOW_LOCAL_MEDIA_LIST",)},
        }
    RETURN_TYPES = ("VIDEO_FLOW_LOCAL_MEDIA_LIST",)
    RETURN_NAMES = ("reference_media",)
    FUNCTION = "inspect"
    CATEGORY = "Video Flow/Seedance"
    @classmethod
    def IS_CHANGED(cls, **kwargs): return float('nan')
    def inspect(self, image, reference_media=None):
        return (_append_reference_media(reference_media, image, "reference_image"),)


class ReferenceVideoInput:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"video": (_file_choices(('.mp4', '.mov'), "请选择视频"),)},
            "optional": {"reference_media": ("VIDEO_FLOW_LOCAL_MEDIA_LIST",)},
        }
    RETURN_TYPES = ("VIDEO_FLOW_LOCAL_MEDIA_LIST",)
    RETURN_NAMES = ("reference_media",)
    FUNCTION = "inspect"
    CATEGORY = "Video Flow/Seedance"
    @classmethod
    def IS_CHANGED(cls, **kwargs): return float('nan')
    def inspect(self, video, reference_media=None):
        return (_append_reference_media(reference_media, video, "reference_video"),)


class ReferenceAudioInput:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"audio": (_file_choices(('.wav', '.mp3'), "请选择音频"),)},
            "optional": {"reference_media": ("VIDEO_FLOW_LOCAL_MEDIA_LIST",)},
        }
    RETURN_TYPES = ("VIDEO_FLOW_LOCAL_MEDIA_LIST",)
    RETURN_NAMES = ("reference_media",)
    FUNCTION = "inspect"
    CATEGORY = "Video Flow/Seedance"
    @classmethod
    def IS_CHANGED(cls, **kwargs): return float('nan')
    def inspect(self, audio, reference_media=None):
        return (_append_reference_media(reference_media, audio, "reference_audio"),)


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
        if not reference_media: raise ValueError("至少需要一个参考图片、视频或音频")
        reference_media = _validated_reference_media(reference_media)
        return ({"intent": {"contractVersion": 2, "workflowKey": "seedance.omni-reference.v1", "prompt": {"positive": prompt.strip()},
            "generation": generation_request(duration, ratio, resolution),
            "media": [item["descriptor"] for item in reference_media]}, "media": reference_media},)


class VideoEditRequest:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "reference_media": ("VIDEO_FLOW_LOCAL_MEDIA_LIST",),
            "prompt": ("STRING", {"multiline": True}),
            "resolution": (["480p", "720p", "1080p"],),
        }}
    RETURN_TYPES = ("VIDEO_FLOW_PREFLIGHT_REQUEST",)
    RETURN_NAMES = ("request",)
    FUNCTION = "build"
    CATEGORY = "Video Flow/Seedance"
    def build(self, reference_media, prompt, resolution="720p"):
        if not prompt.strip() or len(prompt.strip()) > 4000:
            raise ValueError("提示词不能为空，且不超过 4000 字符")
        reference_media = _validated_reference_media(reference_media)
        videos = [
            item for item in reference_media
            if item.get("descriptor", {}).get("role") == "reference_video"
        ]
        if not videos:
            raise ValueError("视频编辑至少需要一段参考视频")
        if any(
            not 4 <= item.get("descriptor", {}).get("metadata", {}).get("durationSeconds", 0) <= 30
            for item in videos
        ):
            raise ValueError("编辑输入视频时长必须为 4–30 秒")
        generation = generation_request(-1, "adaptive", resolution)
        generation["outputFormat"] = "mov"
        return ({"intent": {
            "contractVersion": 2,
            "workflowKey": "seedance.video-edit.v1",
            "prompt": {"positive": prompt.strip()},
            "generation": generation,
            "media": [item["descriptor"] for item in reference_media],
        }, "media": reference_media},)


class VideoExtendRequest:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "reference_media": ("VIDEO_FLOW_LOCAL_MEDIA_LIST",),
            "prompt": ("STRING", {"multiline": True}),
            "duration": (list(range(4, 31)),),
            "resolution": (["480p", "720p", "1080p"],),
        }}
    RETURN_TYPES = ("VIDEO_FLOW_PREFLIGHT_REQUEST",)
    RETURN_NAMES = ("request",)
    FUNCTION = "build"
    CATEGORY = "Video Flow/Seedance"
    def build(self, reference_media, prompt, duration=5, resolution="720p"):
        if not prompt.strip() or len(prompt.strip()) > 4000:
            raise ValueError("提示词不能为空，且不超过 4000 字符")
        if not isinstance(duration, int) or isinstance(duration, bool) or not 4 <= duration <= 30:
            raise ValueError("延长输出时长必须为 4–30 秒整数")
        reference_media = _validated_reference_media(reference_media)
        if not any(
            item.get("descriptor", {}).get("role") == "reference_video"
            for item in reference_media
        ):
            raise ValueError("视频延长至少需要一段参考视频")
        generation = generation_request(duration, "adaptive", resolution)
        generation["outputFormat"] = "mov"
        return ({"intent": {
            "contractVersion": 2,
            "workflowKey": "seedance.video-extend.v1",
            "prompt": {"positive": prompt.strip()},
            "generation": generation,
            "media": [item["descriptor"] for item in reference_media],
        }, "media": reference_media},)


class AudioReferenceRequest:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "reference_media": ("VIDEO_FLOW_LOCAL_MEDIA_LIST",),
            "prompt": ("STRING", {"multiline": True}),
            "duration": (list(range(4, 31)),),
            "ratio": (["21:9", "16:9", "4:3", "1:1", "3:4", "9:16", "adaptive"],),
            "resolution": (["480p", "720p", "1080p"],),
        }}
    RETURN_TYPES = ("VIDEO_FLOW_PREFLIGHT_REQUEST",)
    RETURN_NAMES = ("request",)
    FUNCTION = "build"
    CATEGORY = "Video Flow/Seedance"
    def build(self, reference_media, prompt, duration=5, ratio="16:9", resolution="720p"):
        if not prompt.strip() or len(prompt.strip()) > 4000:
            raise ValueError("提示词不能为空，且不超过 4000 字符")
        reference_media = _validated_reference_media(reference_media)
        if not reference_media:
            raise ValueError("音频参考至少需要一段参考音频")
        if any(
            item.get("descriptor", {}).get("role") != "reference_audio"
            for item in reference_media
        ):
            raise ValueError("音频参考工作流只接受参考音频；组合素材请使用全模态参考")
        return ({"intent": {
            "contractVersion": 2,
            "workflowKey": "seedance.audio-reference-to-video.v1",
            "prompt": {"positive": prompt.strip()},
            "generation": generation_request(duration, ratio, resolution),
            "media": [item["descriptor"] for item in reference_media],
        }, "media": reference_media},)


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
        if mode == "preview":
            if not record.get("preflightId"):
                raise ValueError("服务器没有返回有效 preflightId")
            expires = datetime.fromisoformat(record["expiresAt"].replace('Z', '+00:00')).timestamp()
            if time.time() >= expires:
                raise ValueError("预检已过期，请重新运行 Preview")
        result = {**request, "record": record, "mode": mode, "intent_key": key}
        report = preflight_report(
            record,
            "Preview 已完成，未上传素材、未生成视频"
            if mode == 'preview'
            else "已复验本次预检，正式提交时服务器再次核对",
        )
        return {"ui": {"text": [json.dumps(report, ensure_ascii=False, indent=2)]}, "result": (result,)}


class CreateTask:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"config": ("VIDEO_FLOW_CONFIG",), "execution_policy": ("VIDEO_FLOW_EXECUTION_POLICY",),
            "checked_request": ("VIDEO_FLOW_CHECKED_REQUEST",),
            "execution_slot_id": ("STRING", {"default": ""}),
            "generation_version": ("INT", {"default": 1, "min": 1})}}
    RETURN_TYPES = ("VIDEO_FLOW_EXECUTION_RESULT",)
    RETURN_NAMES = ("task",)
    FUNCTION = "submit"
    CATEGORY = "Video Flow/Seedance"
    OUTPUT_NODE = True
    @classmethod
    def IS_CHANGED(cls, **kwargs): return float('nan')
    def submit(self, config, execution_policy, checked_request, execution_slot_id="", generation_version=1):
        mode = valid_policy(execution_policy)
        if mode == "preview": return ({"mode": "preview"},)
        client = VideoFlowClient(config)
        slot_id = normalize_execution_slot_id(execution_slot_id)
        receipt_store = client.receipt_store(config.receipt_dir)
        recovered = recover_current(client, slot_id, receipt_store)
        if recovered is not None:
            # 恢复路径同样要带 ui：否则"沿用原任务"时用户看不到 taskId。
            return {'ui': {'text': [task_notice({}, recovered)]}, 'result': (recovered,)}

        if checked_request.get("mode") != mode: raise ValueError("预检与运行方式不一致")
        request = checked_request
        record = request.get('record') or {}
        if not preflight_is_current(record):
            preflight_store = store(config)
            preflight_store.save(request['intent_key'], {"status": "checking"})
            response = client.client.post(
                f"{config.backend_url}/api/v1/tasks/preflight",
                headers=client._headers(),
                json=request['intent'],
            )
            require_server_success(response)
            record = response.json()
            if (
                not preflight_is_current(record)
                or record.get("willCallProvider") is not False
                or record.get("willUploadMedia") is not False
            ):
                raise ValueError("服务器预检返回不完整，禁止正式生成")
            preflight_store.save(request['intent_key'], record)
            message = "Production 模式已完成 Preview：未上传、未生成；请检查报告后再次 Queue 正式提交"
            return {
                'ui': {'text': [json.dumps(preflight_report(record, message), ensure_ascii=False, indent=2)]},
                'result': ({
                    'mode': 'preview',
                    'execution_slot_id': slot_id,
                    'preflight_id': record['preflightId'],
                    'requires_second_queue': True,
                },),
            }
        response = client.client.get(
            f"{config.backend_url}/api/v1/tasks/preflight/{record['preflightId']}/check",
            headers=client._headers(),
        )
        require_server_success(response)
        record = response.json()
        if record.get('requestCheck', {}).get('status') != 'passed':
            raise ValueError("服务器预检记录已失效")
        if record.get('productionAdmission', {}).get('canSubmit') is not True:
            raise ValueError("当前不满足正式提交条件")
        request = {**request, 'record': record}
        local_media = request.get('media', [])
        if isinstance(local_media, dict):
            local_media = [local_media]
        uploaded_media = []
        for index, media in enumerate(local_media):
            expected = request['intent']['media'][index]
            data = read_verified_media(media)
            uploaded = client.upload_media(data, filename=media['filename'], mime_type=media['descriptor']['mimeType'])
            uploaded_media.append({'slotId': expected['slotId'], 'assetId': uploaded['assetId']})
        payload = {
            'preflightId': record['preflightId'],
            'executionSlotId': slot_id,
            'media': uploaded_media,
        }
        receipt_key, idempotency_key = begin_submission_round(
            client,
            receipt_store,
            slot_id,
            request['intent'],
            payload,
        )
        task = client.create_task_with_receipt(
            intent_key=receipt_key,
            idempotency_key=idempotency_key,
            payload=payload,
            mode='production',
            receipt_store=receipt_store,
        )
        result = {
            'mode': 'production',
            'task_id': str(task['id']),
            'execution_slot_id': slot_id,
            'recovered': False,
        }
        return {'ui': {'text': [task_notice(task, result)]}, 'result': (result,)}


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
        client = VideoFlowClient(config)
        receipts = client.receipt_store(config.receipt_dir)
        result = load_verified_local_delivery(
            receipts,
            task['execution_slot_id'],
            task['task_id'],
        )
        if result is None:
            result = client.download_task_result(
                task['task_id'],
                Path(folder_paths.get_output_directory()) / 'video-flow',
            )
            record_downloaded(
                receipts,
                task['execution_slot_id'],
                task['task_id'],
                result,
            )
        client.confirm_client_delivery(task['task_id'])
        record_confirmed(receipts, task['execution_slot_id'], task['task_id'])
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
    "VideoFlowFirstLastFrameRequest": FirstLastFrameRequest, "VideoFlowReferenceImageInput": ReferenceImageInput,
    "VideoFlowReferenceVideoInput": ReferenceVideoInput, "VideoFlowReferenceAudioInput": ReferenceAudioInput,
    "VideoFlowMultiReferenceRequest": MultiReferenceRequest, "VideoFlowVideoEditRequest": VideoEditRequest,
    "VideoFlowVideoExtendRequest": VideoExtendRequest,
    "VideoFlowAudioReferenceRequest": AudioReferenceRequest,
    "VideoFlowRequestPreflight": RequestPreview,
    "VideoFlowConfirmedCreate": CreateTask, "VideoFlowPolicyWait": WaitTask, "VideoFlowPolicyDownload": DownloadResult,
    "VideoFlowPolicyPreview": PolicyPreview}
NAMES = dict(zip(CLASSES, ["运行方式｜Preview / Production", "产品图｜选择与本地检查", "成片要求｜产品参考图生视频", "文生视频要求｜Prompt 生视频", "首帧图｜选择与本地检查", "首尾帧图｜选择与本地检查", "首帧成片要求｜首帧图生视频", "首尾帧成片要求｜两帧图生视频", "参考图片｜追加到全模态集合", "参考视频｜追加到全模态集合", "参考音频｜追加到全模态集合", "全模态参考成片要求", "视频编辑要求｜保持原时长", "视频延长要求｜4–30 秒", "音频参考成片要求", "请求预检｜本地信息与服务器规则", "正式提交｜恢复优先，按槽顺序生成", "等待云端任务完成", "下载并保存成片", "成片预览｜本地播放"]))
