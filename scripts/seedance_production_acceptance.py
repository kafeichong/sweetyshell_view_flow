"""单次真实 Production 验收（会产生火山引擎费用，需事先批准）。

它走的是 ComfyUI 客户端将来要走的同一条链路：
    本地素材 -> 上传票据 -> OSS 直传 -> 登记 Asset
             -> production 任务(带 image_asset_id)
             -> Worker 领取 -> 火山 Seedance -> 视频回写 OSS -> Asset 登记

运行：
    VIDEO_FLOW_TOKEN=$(cat ~/.video-flow/token) \
    VIDEO_FLOW_BACKEND_URL=http://localhost:3100 \
    IMAGE_PATH=/path/to/product.png \
    /Volumes/lvmac/ai/ComfyUI/ComfyUI/.venv/bin/python scripts/seedance_production_acceptance.py

注意：本脚本不会自动重试。若任务进入 requires_review，必须人工确认火山侧
是否已受理，绝不能直接重跑，否则可能重复计费。
"""

import mimetypes
import os
import sys
import time
from pathlib import Path

CLIENT_DIR = os.environ.get(
    "VIDEO_FLOW_CLIENT_DIR",
    "/Users/steven/works/20260909video_flow/packages/comfyui-video-flow-client",
)
sys.path.insert(0, CLIENT_DIR)

from client import VideoFlowClient  # noqa: E402
from config import VideoFlowConfig  # noqa: E402

IMAGE_PATH = os.environ.get("IMAGE_PATH", "")
PROMPT = os.environ.get(
    "PROMPT",
    "产品瓶身缓慢旋转，柔和影棚灯光，纯白背景，镜头平滑推进，商业广告质感",
)
DURATION = int(os.environ.get("DURATION", "5"))
IDEMPOTENCY_KEY = os.environ.get("IDEMPOTENCY_KEY", "")
POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL", "10"))
MAX_POLLS = int(os.environ.get("MAX_POLLS", "60"))
TERMINAL = {"completed", "failed", "cancelled", "requires_review"}


def main() -> int:
    if not IMAGE_PATH:
        print("FAIL: 必须设置 IMAGE_PATH 指向一张真实参考图")
        return 2

    image_path = Path(IMAGE_PATH).expanduser()
    if not image_path.is_file():
        print(f"FAIL: 找不到图片 {image_path}")
        return 2

    config = VideoFlowConfig.from_env()
    if not config.token:
        print("FAIL: 未找到凭证（VIDEO_FLOW_TOKEN 或 ~/.video-flow/token）")
        return 2

    image_bytes = image_path.read_bytes()
    mime = mimetypes.guess_type(str(image_path))[0] or "image/png"
    if not mime.startswith("image/"):
        print(f"FAIL: 不支持的媒体类型 {mime}")
        return 2

    # 幂等键固定：重复执行不会创建第二条付费任务。
    idem = IDEMPOTENCY_KEY or f"paid-acceptance-{int(time.time())}"

    client = VideoFlowClient(config)

    print(f"[1/4] 上传参考图 {image_path.name} ({len(image_bytes)} bytes, {mime})")
    uploaded = client.upload_media(image_bytes, filename=image_path.name, mime_type=mime)
    asset_id = uploaded["assetId"]
    print(f"      asset_id={asset_id}")

    print(f"[2/4] 提交 production 任务（幂等键 {idem}）")
    task = client.create_task(
        idempotency_key=idem,
        mode="production",
        payload={
            "capability": "IMAGE_TO_VIDEO",
            "profile": "seedance",
            "params": {
                "prompt": PROMPT,
                "duration": DURATION,
                "image_asset_id": asset_id,
            },
        },
    )
    task_id = task["id"]
    print(f"      task_id={task_id} status={task.get('status')}")

    print(f"[3/4] 轮询（每 {POLL_INTERVAL}s，最多 {MAX_POLLS} 次）")
    final = task
    for i in range(1, MAX_POLLS + 1):
        final = client.get_task(task_id)
        status = str(final.get("status") or "").lower()
        print(f"      poll {i}: status={status} cost={final.get('cost')}")
        if status in TERMINAL:
            break
        time.sleep(POLL_INTERVAL)

    print("[4/4] 最终任务：")
    for key in (
        "id",
        "status",
        "taskStatus",
        "videoUrl",
        "cost",
        "errorMsg",
        "completedAt",
    ):
        print(f"      {key} = {final.get(key)}")

    status = str(final.get("status") or "").lower()
    if status == "completed" and final.get("videoUrl"):
        print("PASS: 端到端完成，视频已产出")
        print(f"TASK_ID={task_id}")
        return 0

    if status == "requires_review":
        print("STOP: 提交状态不确定，禁止自动重跑，需人工确认火山侧是否已受理")
        print(f"TASK_ID={task_id}")
        return 3

    print(f"FAIL: 任务未完成，status={status}")
    print(f"TASK_ID={task_id}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
