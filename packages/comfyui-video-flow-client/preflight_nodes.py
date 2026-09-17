"""One connected graph: local media -> server preflight -> confirmed submission.

Node IDs are namespaced to avoid overriding the installed legacy Ark plugin.
"""
import hashlib
import json
import time
from datetime import datetime
from pathlib import Path

try:
    from .client import VideoFlowClient, server_error_detail
    from .config import VideoFlowConfig
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
    from client import VideoFlowClient, server_error_detail
    from config import VideoFlowConfig
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
    """预检失败时把服务端给的原因完整带出来。

    只读 `message` 会丢掉 `code`（例如 `WORKFLOW_NOT_ENABLED`）——那是用户报障、我们定位
    时最有用的一项。与 client.raise_for_status_with_reason 用同一套提取逻辑。
    """
    if response.status_code >= 400:
        detail = server_error_detail(response) or '服务器未通过检查'
        raise ValueError(f"服务器预检未通过（HTTP {response.status_code}）：{detail}")


def admission_blockers(record):
    """把服务端给的准入 blockers 写成一行行原因码，供报错指名道姓。

    只说"当前不满足正式提交条件"等于没说：真正有用的是 `WORKFLOW_NOT_ENABLED`
    （这条工作流根本没开放，找管理员）还是 `QUOTE_UNAVAILABLE`（报价算不出来，改参数）。
    服务端在 blocker 的 `message` 里放的是平台原因码，与 `code` 相同时不重复写。
    """
    blockers = (record.get('productionAdmission') or {}).get('blockers')
    if not blockers:
        return []
    lines = []
    for blocker in blockers:
        code = blocker.get('code') or blocker.get('message') or ''
        message = blocker.get('message') or ''
        lines.append(f"{code}({message})" if message and message != code else str(code))
    return lines


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
        # 占位符放第一位且始终保留：见 _file_choices 的说明（模板里存的值必须永远有效）。
        return {"required": {"image": (["请选择产品图"] + images, {"image_upload": True})}}
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
        return {"required": {"media": ("VIDEO_FLOW_LOCAL_MEDIA",), "prompt": ("STRING", {"multiline": True, "tooltip": PROMPT_WRITING_TOOLTIP}),
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


# 提示词写法提示。官方（Seedance 2.5 提示词指南）给的公式是：
# 素材指代 → 一句话概述（主体+地点+事件+题材/风格+特殊运镜）→ 具体情节（用时间戳或
# 「镜头 N」切分）→ 结尾补充（机位/环境/声音/氛围），并明确"尽量使用正向描述"；
# 反向描述只支持字幕与音频两类。长度上官方建议中文不超过 500 字（过长会漏元素）。
PROMPT_WRITING_TOOLTIP = (
    "写法：主体+地点+事件+风格+运镜 → 分镜（用时间戳或「镜头 N」逐段写）→ 结尾补机位/环境/声音/氛围。"
    "景别写远景/全景/中景/近景/特写，运镜写推/拉/摇/移/跟/环绕等，这些都是模型认识的词。"
    "中文建议 ≤500 字，过长模型会漏元素；「不要字幕」「无 bgm」这类反向描述只对字幕和音频有效，其余请写正向。"
)


# 全模态参考多一条：提示词必须写成「参考/生成」意图，否则模型会判成编辑/延长任务而异步失败。
MULTI_REFERENCE_PROMPT_TOOLTIP = (
    PROMPT_WRITING_TOOLTIP
    + " 另外：这条工作流请写「参考 / 生成」意图；写「把 X 改成 Y」「延长 N 秒」这类编辑/延长措辞，"
      "会被判成另一类任务，提交成功后异步失败。"
)


class TextRequest:
    DESCRIPTION = "文生视频成片要求：只需要提示词，不需要素材。默认值是一段照官方公式写好的完整示例，改成你要的内容即可。"
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"prompt": ("STRING", {"multiline": True, "tooltip": PROMPT_WRITING_TOOLTIP}),
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
    """固定数量素材的下拉：**占位符始终在列表里，且放第一位**。

    放第一位是为了"没选就不算选"；始终保留是为了模板里存的那个占位符值永远有效——
    否则用户一旦往 input 目录里放了文件，模板中保存的"请选择图片"就不在选项里，
    导入时会被前端判成"输入值不可用"（踩过）。
    """
    import folder_paths
    root = Path(folder_paths.get_input_directory())
    files = sorted(str(p.relative_to(root)) for p in root.rglob('*') if p.is_file() and p.suffix.lower() in suffixes)
    return [empty_label] + files


UNUSED_MEDIA_CHOICE = "（不给素材）"

REFERENCE_SLOT_TOOLTIP = (
    "选一个文件就追加进参考集合；选「不给素材」表示这个槽位不用，不用删连线。"
    "整套至少要有一个参考素材。图片最多 30 张、视频最多 10 段、音频最多 10 段，合计不超过 50 个。"
    "另外：**含真人人脸的图/视频不能直接用**，平台会直接拒绝（重试同一份无效）。"
)


def _reference_choices(suffixes):
    """参考素材下拉：**第一位是"（不给素材）"**，后面才是实际文件。

    放第一位是有意的，因为 ComfyUI 的 COMBO 以列表第一项为默认值——这样"没动过 =
    没用上"，新加的节点、以及模板里多摆的槽位默认都是空，不会悄悄带上第一个文件。
    选中它的节点不读文件、不追加，只把上游列表原样传下去，因此空槽既不需要右键旁路
    节点，也不需要删连线。上限仍由 _append_reference_media 按官方口径拦截。

    官方（火山方舟创建视频生成任务 API）对全模态参考的要求是 content 里**至少有一个**
    role 为 reference_image / reference_video / reference_audio 的素材，图片 0-30 张、
    视频 0-10 段、音频 0-10 段可自由组合；所以只有"一个都没选"才是错的，
    由 MultiReferenceRequest.VALIDATE_INPUTS 在排队前拦下。
    """
    import folder_paths
    root = Path(folder_paths.get_input_directory())
    files = sorted(str(p.relative_to(root)) for p in root.rglob('*') if p.is_file() and p.suffix.lower() in suffixes)
    return [UNUSED_MEDIA_CHOICE] + files


def _reference_spec(suffixes, **extra):
    """图片参考的下拉规格：老式「选项列表 + 附加键」写法。

    与 ComfyUI 自带的 `LoadImage.image` 一致（它用 `{"image_upload": true}`）。**别改成
    V3 的 ("COMBO", {...}) 写法**——图片上传按钮是老式写法下验证可用的，没必要动。
    """
    return (_reference_choices(suffixes), {"tooltip": REFERENCE_SLOT_TOOLTIP, **extra})


def _reference_combo_spec(suffixes, upload_key=None):
    """视频/音频参考的下拉规格：V3 的 ("COMBO", {...}) 写法，`upload_key` 给上传按钮。

    `upload_key` 取 ComfyUI 自带加载节点的同款标志（`LoadVideo.file` 用 `video_upload`）。
    没有它，用户**只能从 ComfyUI/input 目录里挑**，没法把别处的文件传进来——这正是
    "视频不能上传只能选择"的原因。

    **音频不要传 `audio_upload`**：前端那条注入路是写给 LoadAudio 那一族的（它要一个只有
    那一族才有的 `audioUI` widget，我们没有），标志带不来按钮。音频的上传按钮由
    `web/audio_upload.js` 自绘——那里的注释记了完整原因。
    """
    extra = {"options": _reference_choices(suffixes), "multiselect": False,
             "tooltip": REFERENCE_SLOT_TOOLTIP}
    if upload_key:
        extra[upload_key] = True
    return ("COMBO", extra)


# 这几个数字与合同 `media` 一节同源：合同是服务端复验用的真值，客户端这一份只为
# 在本地尽早给出提示。仓库内的 tests/test_contract_alignment.py 会断言两者相等。
REFERENCE_MEDIA_LIMITS = {
    "reference_image": (30, "参考图片最多 30 张"),
    "reference_video": (10, "参考视频最多 10 段"),
    "reference_audio": (10, "参考音频最多 10 段"),
}
REFERENCE_MEDIA_TOTAL_LIMIT = 50


def _validated_reference_media(reference_media):
    media = list(reference_media or [])
    if len(media) > REFERENCE_MEDIA_TOTAL_LIMIT:
        raise ValueError(f"参考素材总数最多 {REFERENCE_MEDIA_TOTAL_LIMIT} 个")
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
    if len(media) >= REFERENCE_MEDIA_TOTAL_LIMIT:
        raise ValueError(f"参考素材总数最多 {REFERENCE_MEDIA_TOTAL_LIMIT} 个")
    media.append(inspect_product(filename, role, f"{role.replace('_', '-')}-{role_count + 1}"))
    return _validated_reference_media(media)


ARK_UNUSED_CHOICE = "（不用素材库素材）"
ARK_LIST_UNAVAILABLE_PREFIX = "（素材库读取失败"
# 只列图片：含真人人脸的素材**只能**走素材库（直传会被方舟输入审核拦），而目前真实验证过的
# 只有图片这一条通路（视频/音频官方有文档但没实测）。放开未验证的角色会让用户花一次钱
# 才发现被拒，所以先不列。
ARK_SUPPORTED_ASSET_TYPE = "Image"
# 槽位提示。**别把「（不给素材）」和「请选择」写进来**：客户端测试用这两个子串识别
# "文件选择器"，撞上就会被要求带上传标志（而这个槽位不该有）。
ARK_SLOT_TOOLTIP = (
    "从方舟私域素材库挑一份素材（虚拟人像等）。清单由服务端给出，本地不读文件。"
    "留在「不用素材库素材」表示这个槽位不用，不用删连线。"
    "含真人人脸的参考素材**只能**走这里——直传会被方舟输入审核拦下。"
)
ARK_CHOICES_TTL_SECONDS = 30.0
_ARK_CHOICES_CACHE = {"at": 0.0, "options": None}


def _ark_client():
    """素材库要用一个客户端，而下拉的选项是在 `INPUT_TYPES()` 里取的——那时候拿不到
    画布上那个 Config 节点，只能从环境变量构造一个。用模块级的名字，测试才好替换。"""
    return VideoFlowClient(VideoFlowConfig.from_env())


def ark_asset_choices():
    """素材库下拉的选项。

    哨兵**永远第一项、永远在**：模板里存过的值必须永远有效，否则导入那张画布时前端会
    判成「输入值不可用」。读不到素材库时也只多一项说明，不改变哨兵的位置——
    下拉是可选项，网络出问题不该让整张画布不能用。

    带 30 秒缓存：ComfyUI 会频繁调 `INPUT_TYPES()`，不该每次都打后端。
    """
    now = time.monotonic()
    if _ARK_CHOICES_CACHE["options"] is not None and now - _ARK_CHOICES_CACHE["at"] < ARK_CHOICES_TTL_SECONDS:
        return _ARK_CHOICES_CACHE["options"]
    try:
        assets = _ark_client().list_ark_assets()
        usable = [
            item for item in assets
            if item.get("assetType") == ARK_SUPPORTED_ASSET_TYPE and item.get("status") == "Active"
        ]
        options = [ARK_UNUSED_CHOICE] + [
            f"{item.get('name') or '未命名'} · {item.get('id')}" for item in usable
        ]
    except Exception as error:  # noqa: BLE001 - 任何失败都只能降级成"读不到"，不能抛
        options = [ARK_UNUSED_CHOICE, f"{ARK_LIST_UNAVAILABLE_PREFIX}，稍后重试：{error}）"]
    _ARK_CHOICES_CACHE.update(at=now, options=options)
    return options


def _ark_asset_id_of(choice):
    """从下拉项里取回素材 ID。

    下拉项是给人看的（`名称 · asset-…`），但 ID 的形状是合同钉死的，按分隔符取最后一段即可。
    """
    candidate = choice.rsplit(" · ", 1)[-1].strip()
    if not candidate.startswith("asset-"):
        raise ValueError("这个槽位里存的不是素材库素材，请重新选一个")
    return candidate


def _append_ark_reference_media(reference_media, ark_asset_id):
    media = _validated_reference_media(reference_media)
    role = "reference_image"
    role_count = sum(1 for item in media if item.get("descriptor", {}).get("role") == role)
    maximum, message = REFERENCE_MEDIA_LIMITS[role]
    if role_count >= maximum:
        raise ValueError(message)
    if len(media) >= REFERENCE_MEDIA_TOTAL_LIMIT:
        raise ValueError(f"参考素材总数最多 {REFERENCE_MEDIA_TOTAL_LIMIT} 个")

    # 登记把字节取回来检查并留一份副本，这几个字段就是**我方 Asset 行的真值**——
    # descriptor 必须与它逐字段一致，否则正式提交会被 PREFLIGHT_ACTUAL_CONTENT_MISMATCH 拒掉。
    registered = _ark_client().register_ark_asset(ark_asset_id)
    for key in ("sha256", "mimeType", "sizeBytes", "metadata", "arkAssetId", "assetId"):
        if registered.get(key) in (None, ""):
            raise ValueError(f"服务器登记素材时没有返回 {key}，这个槽位没法用")
    media.append({
        # 这两项是"这份素材不在本机上"的标记：正式提交时跳过上传，直接绑定它。
        "ark_asset_id": registered["arkAssetId"],
        "asset_id": registered["assetId"],
        "filename": registered["arkAssetId"],
        "descriptor": {
            "slotId": f"{role.replace('_', '-')}-{role_count + 1}",
            "role": role,
            "sha256": registered["sha256"],
            "mimeType": registered["mimeType"],
            "sizeBytes": registered["sizeBytes"],
            "metadata": registered["metadata"],
            "arkAssetId": registered["arkAssetId"],
        },
    })
    return _validated_reference_media(media)


def _append_published_media(reference_media, filename):
    """把本机的一份文件上传到方舟私域素材库，产出可以直接用的素材库素材。

    复用既有的上传链路：本机文件 → 我方对象存储（上传票据）→ 推给方舟入库。
    之后生成时用的是 `asset://`，含真人人脸的素材**只有**这条路能走。
    """
    media = _validated_reference_media(reference_media)
    role = "reference_image"
    role_count = sum(1 for item in media if item.get("descriptor", {}).get("role") == role)
    maximum, message = REFERENCE_MEDIA_LIMITS[role]
    if role_count >= maximum:
        raise ValueError(message)
    if len(media) >= REFERENCE_MEDIA_TOTAL_LIMIT:
        raise ValueError(f"参考素材总数最多 {REFERENCE_MEDIA_TOTAL_LIMIT} 个")

    inspected = inspect_product(filename, role, f"{role.replace('_', '-')}-{role_count + 1}")
    client = _ark_client()
    # 已有内容寻址：同一个文件重复 Queue 会复用同一条 Asset；publish 也是幂等的，
    # 所以再次 Queue 不会在素材库里灌出重复素材。
    uploaded = client.upload_media(
        read_verified_media(inspected),
        filename=inspected["filename"],
        mime_type=inspected["descriptor"]["mimeType"],
    )
    published = client.publish_ark_asset(uploaded["assetId"])
    if not published.get("arkAssetId"):
        raise ValueError("服务器没有返回入库后的素材 ID，这个槽位没法用")

    media.append({
        "ark_asset_id": published["arkAssetId"],
        "asset_id": uploaded["assetId"],
        "filename": inspected["filename"],
        "descriptor": {**inspected["descriptor"], "arkAssetId": published["arkAssetId"]},
    })
    return _validated_reference_media(media)


class ArkUploadInput:
    """把本机文件上传到方舟私域素材库，产出一份可以直接用的素材库素材。

    为什么入库这一步在客户端也要有入口：含真人人脸的参考素材**只能**走素材库
    （直传 URL 会被方舟输入审核拦下），没有这个入口，创意就只能先去控制台传一次。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"image": _reference_spec(('.png', '.jpg', '.jpeg', '.webp'), image_upload=True)},
            "optional": {"reference_media": ("VIDEO_FLOW_LOCAL_MEDIA_LIST",)},
        }
    DESCRIPTION = ("把本机这张图**上传到方舟私域素材库**，再追加进参考集合。"
                   "上传后它会出现在「素材库素材」的下拉里，之后可以直接复用；"
                   "生成时走 asset://——含真人人脸的素材只有这样送才不会被拦。"
                   "留在「不给素材」表示这个槽位不用。")
    RETURN_TYPES = ("VIDEO_FLOW_LOCAL_MEDIA_LIST",)
    RETURN_NAMES = ("reference_media",)
    FUNCTION = "inspect"
    CATEGORY = "Video Flow/Seedance"
    @classmethod
    def IS_CHANGED(cls, **kwargs): return float('nan')
    def inspect(self, image, reference_media=None):
        if image == UNUSED_MEDIA_CHOICE:
            return (_validated_reference_media(reference_media),)
        return (_append_published_media(reference_media, image),)


class ArkAssetInput:
    """从方舟私域素材库挑一份素材（虚拟人像等），而不是从本机 input 目录里挑。

    含真人人脸的参考素材**只能**这样送：直传 URL 会被方舟输入审核拦下。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            # **不收画布上的 Config**：下拉的选项必须在节点定义时就取好，而那一刻拿不到
            # Config 节点的值，只能走环境变量。要是这里再收一个 Config，就会出现"列表来自
            # 环境变量、登记走画布配置"的分裂。两边都用 from_env()，至少是一致的。
            "required": {"ark_asset": (ark_asset_choices(), {"tooltip": ARK_SLOT_TOOLTIP})},
            "optional": {"reference_media": ("VIDEO_FLOW_LOCAL_MEDIA_LIST",)},
        }
    DESCRIPTION = ("把上游节点的 reference_media 接进来，再追加一份**素材库素材**"
                   "（在方舟控制台或上传入口入库过的虚拟人像等）。槽位可以留在"
                   "「不用素材库素材」；列里每份素材的元信息由服务端给出，本地不读文件，"
                   "也不会上传——字节在登记那一步就已经进了我方存储。")
    RETURN_TYPES = ("VIDEO_FLOW_LOCAL_MEDIA_LIST",)
    RETURN_NAMES = ("reference_media",)
    FUNCTION = "inspect"
    CATEGORY = "Video Flow/Seedance"
    @classmethod
    def IS_CHANGED(cls, **kwargs): return float('nan')
    def inspect(self, ark_asset, reference_media=None):
        if ark_asset == ARK_UNUSED_CHOICE:
            return (_validated_reference_media(reference_media),)
        if ark_asset.startswith(ARK_LIST_UNAVAILABLE_PREFIX):
            raise ValueError(f"读不到素材库，这个槽位用不了：{ark_asset}")
        return (_append_ark_reference_media(reference_media, _ark_asset_id_of(ark_asset)),)


class ReferenceImageInput:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"image": _reference_spec(('.png', '.jpg', '.jpeg', '.webp'), image_upload=True)},
            "optional": {"reference_media": ("VIDEO_FLOW_LOCAL_MEDIA_LIST",)},
        }
    DESCRIPTION = ("把上游节点的 reference_media 接进来，再追加这张参考图。"
                   "槽位可以留在「不给素材」——不需要删除连线，也不需要旁路节点。")
    RETURN_TYPES = ("VIDEO_FLOW_LOCAL_MEDIA_LIST",)
    RETURN_NAMES = ("reference_media",)
    FUNCTION = "inspect"
    CATEGORY = "Video Flow/Seedance"
    @classmethod
    def IS_CHANGED(cls, **kwargs): return float('nan')
    def inspect(self, image, reference_media=None):
        if image == UNUSED_MEDIA_CHOICE:
            return (_validated_reference_media(reference_media),)
        return (_append_reference_media(reference_media, image, "reference_image"),)


class ReferenceVideoInput:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"video": _reference_combo_spec(('.mp4', '.mov'), "video_upload")},
            "optional": {"reference_media": ("VIDEO_FLOW_LOCAL_MEDIA_LIST",)},
        }
    DESCRIPTION = ("把上游节点的 reference_media 接进来，再追加这段参考视频。"
                   "槽位可以留在「不给素材」；单个视频 2–30 秒，所有参考视频总时长不超过 30 秒。")
    RETURN_TYPES = ("VIDEO_FLOW_LOCAL_MEDIA_LIST",)
    RETURN_NAMES = ("reference_media",)
    FUNCTION = "inspect"
    CATEGORY = "Video Flow/Seedance"
    @classmethod
    def IS_CHANGED(cls, **kwargs): return float('nan')
    def inspect(self, video, reference_media=None):
        if video == UNUSED_MEDIA_CHOICE:
            return (_validated_reference_media(reference_media),)
        return (_append_reference_media(reference_media, video, "reference_video"),)


class ReferenceAudioInput:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            # 音频刻意不带 audio_upload：前端那条注入路会取我们节点上没有的 audioUI 后抛错，
            # 按钮由 web/audio_upload.js 自绘（见那里的注释）。
            "required": {"audio": _reference_combo_spec(('.wav', '.mp3'))},
            "optional": {"reference_media": ("VIDEO_FLOW_LOCAL_MEDIA_LIST",)},
        }
    DESCRIPTION = ("把上游节点的 reference_media 接进来，再追加这段参考音频。"
                   "槽位可以留在「不给素材」；单个音频 2–30 秒，所有参考音频总时长不超过 30 秒。")
    RETURN_TYPES = ("VIDEO_FLOW_LOCAL_MEDIA_LIST",)
    RETURN_NAMES = ("reference_media",)
    FUNCTION = "inspect"
    CATEGORY = "Video Flow/Seedance"
    @classmethod
    def IS_CHANGED(cls, **kwargs): return float('nan')
    def inspect(self, audio, reference_media=None):
        if audio == UNUSED_MEDIA_CHOICE:
            return (_validated_reference_media(reference_media),)
        return (_append_reference_media(reference_media, audio, "reference_audio"),)


class MultiReferenceRequest:
    DESCRIPTION = ("全模态参考成片要求：接上任意组合的参考图片 / 视频 / 音频。"
                   "官方要求**至少有一个**参考素材，三类可自由组合。"
                   "提示词请写成「参考 / 生成」意图：写「把视频里的 X 换成 Y」这类编辑措辞、"
                   "或「把视频延长 N 秒」，模型会把任务判定成编辑 / 延长，与我们提交的任务类型冲突，"
                   "任务会在提交成功之后异步失败（钱不白花，但白等一场）——"
                   "要编辑请用视频编辑模板，要延长请用视频延长模板。"
                   "默认示例里提到的 @图像1 / @视频1 要和你实际放进槽位的素材对应；没放视频就把那句删掉。")
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"reference_media": ("VIDEO_FLOW_LOCAL_MEDIA_LIST",),
            "prompt": ("STRING", {"multiline": True, "tooltip": MULTI_REFERENCE_PROMPT_TOOLTIP}),
            "duration": (list(range(4, 31)),), "ratio": (["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],),
            "resolution": (["480p", "720p", "1080p"],)}}
    # **这里故意没有 VALIDATE_INPUTS**。ComfyUI 的校验发生在任何节点执行之前，由连线喂进来的
    # 输入在那一刻还没有值：execution.py 的 get_input_data() 对链接输入走
    # `mark_missing()` / `(None,)` 分支（注释写明"This might be a lazily-evaluated input"），
    # 只有 widget 输入才会把真实值交给自定义校验。所以对 reference_media 做校验必然恒为"空"，
    # 连给了一张图也会报错——踩过一次，别再往回加。"一个都没选"改由 build() 在执行阶段报出。
    RETURN_TYPES = ("VIDEO_FLOW_PREFLIGHT_REQUEST",)
    RETURN_NAMES = ("request",)
    FUNCTION = "build"
    CATEGORY = "Video Flow/Seedance"
    def build(self, reference_media, prompt, duration=5, ratio="16:9", resolution="720p"):
        if not prompt.strip() or len(prompt.strip()) > 4000: raise ValueError("提示词不能为空，且不超过 4000 字符")
        if not reference_media:
            raise ValueError("至少需要一个参考素材：在参考图片 / 视频 / 音频节点的下拉里选一个文件"
                             "（其余槽位可以留在「不给素材」，不用删连线）")
        reference_media = _validated_reference_media(reference_media)
        return ({"intent": {"contractVersion": 2, "workflowKey": "seedance.omni-reference.v1", "prompt": {"positive": prompt.strip()},
            "generation": generation_request(duration, ratio, resolution),
            "media": [item["descriptor"] for item in reference_media]}, "media": reference_media},)


# 编辑任务与"从零生成"的写法不同：官方要求明确修改范围、说明 A→B 的变化过程，
# 并支持用时间戳指定生效时段；比例固定 adaptive、时长由输入视频决定，输出用 mov。
EDIT_PROMPT_TOOLTIP = (
    "写法：说清「改什么、从什么变成什么」，并保持画面其余部分不变——"
    "官方示例：「将两人武打素版视频 @视频1 替换为冷兵器对决前的空手试探风」。"
    "可以用时间戳指定改动生效的时段（如「0s-3s：旧杯子逐渐变成新杯子」）。"
    "时长由输入视频决定（这里没有时长选项），输出固定 mov。"
)


class VideoEditRequest:
    DESCRIPTION = ("视频编辑：接一段参考视频，用提示词改画面。比例跟随输入视频、时长由输入决定，"
                   "默认值是一段照官方写法写好的完整示例。")
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "reference_media": ("VIDEO_FLOW_LOCAL_MEDIA_LIST",),
            "prompt": ("STRING", {"multiline": True, "tooltip": EDIT_PROMPT_TOOLTIP}),
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


# 延长是"接着原视频续写"，写法与从零生成不同：官方示例是
# 「在 @视频1 的基础上续写 5 秒的视频，<续写部分的内容>」，不用时间戳分镜。
EXTEND_PROMPT_TOOLTIP = (
    "写法：在 @视频1 的基础上（向前/向后）续写 N 秒，接着描述续写部分的内容——"
    "官方示例：「在 @视频1 的基础上续写 5 秒的视频，讲一只蜜蜂飞来落在画上……」。"
    "不要写「0s-3s」这类时间戳（那是从零生成时的分镜写法）。"
    "比例与时长跟随输入视频，画幅由输入决定，所以这里没有比例选项。"
)


class VideoExtendRequest:
    DESCRIPTION = ("视频延长：接一段参考视频，向后或向前延长 N 秒。"
                   "输出比例自动跟随输入视频；默认值是一段照官方写法写好的完整示例，改成你的内容即可。")
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "reference_media": ("VIDEO_FLOW_LOCAL_MEDIA_LIST",),
            "prompt": ("STRING", {"multiline": True, "tooltip": EXTEND_PROMPT_TOOLTIP}),
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
    DESCRIPTION = ("音频参考成片：接 1–2 段参考音频，让画面跟随音频的节奏与情绪。"
                   "默认值是一段照官方公式写好的完整示例。")
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "reference_media": ("VIDEO_FLOW_LOCAL_MEDIA_LIST",),
            "prompt": ("STRING", {"multiline": True, "tooltip": PROMPT_WRITING_TOOLTIP}),
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
        return {"required": {"media": ("VIDEO_FLOW_LOCAL_MEDIA",), "prompt": ("STRING", {"multiline": True, "tooltip": PROMPT_WRITING_TOOLTIP}),
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
        return {"required": {"first_frame": ("VIDEO_FLOW_LOCAL_MEDIA",), "last_frame": ("VIDEO_FLOW_LOCAL_MEDIA",), "prompt": ("STRING", {"multiline": True, "tooltip": PROMPT_WRITING_TOOLTIP}),
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
            reasons = admission_blockers(record)
            raise ValueError(
                "当前不满足正式提交条件"
                + (f"：{'、'.join(reasons)}" if reasons else "")
            )
        request = {**request, 'record': record}
        local_media = request.get('media', [])
        if isinstance(local_media, dict):
            local_media = [local_media]
        uploaded_media = []
        for index, media in enumerate(local_media):
            expected = request['intent']['media'][index]
            if media.get('ark_asset_id'):
                # 素材库素材：字节在登记那一步就已经进了我方存储，这里**没有本地文件可读**，
                # 也不该再传一次。直接绑定登记时给的那条 Asset；服务端会向方舟复验它还活着、
                # 并且在同一个项目里。
                uploaded_media.append({'slotId': expected['slotId'], 'assetId': media['asset_id']})
                continue
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
    "VideoFlowArkAssetInput": ArkAssetInput, "VideoFlowArkUploadInput": ArkUploadInput,
    "VideoFlowMultiReferenceRequest": MultiReferenceRequest, "VideoFlowVideoEditRequest": VideoEditRequest,
    "VideoFlowVideoExtendRequest": VideoExtendRequest,
    "VideoFlowAudioReferenceRequest": AudioReferenceRequest,
    "VideoFlowRequestPreflight": RequestPreview,
    "VideoFlowConfirmedCreate": CreateTask, "VideoFlowPolicyWait": WaitTask, "VideoFlowPolicyDownload": DownloadResult,
    "VideoFlowPolicyPreview": PolicyPreview}
NAMES = dict(zip(CLASSES, ["运行方式｜Preview / Production", "产品图｜选择与本地检查", "成片要求｜产品参考图生视频", "文生视频要求｜Prompt 生视频", "首帧图｜选择与本地检查", "首尾帧图｜选择与本地检查", "首帧成片要求｜首帧图生视频", "首尾帧成片要求｜两帧图生视频", "参考图片｜追加到全模态集合", "参考视频｜追加到全模态集合", "参考音频｜追加到全模态集合", "素材库素材｜追加到全模态集合", "上传素材到素材库", "全模态参考成片要求", "视频编辑要求｜保持原时长", "视频延长要求｜4–30 秒", "音频参考成片要求", "请求预检｜本地信息与服务器规则", "正式提交｜恢复优先，按槽顺序生成", "等待云端任务完成", "下载并保存成片", "成片预览｜本地播放"]))
