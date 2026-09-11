"""在 ComfyUI 的运行环境中直接驱动公司节点，验证 Preview 链路。

用途：在重启 ComfyUI GUI 之前，先用 ComfyUI 自己的 venv 跑一遍节点代码，
确认 上传票据 -> OSS 预签名直传 -> 创建任务 -> 查询任务 这段链路是通的，
并且不会产生付费调用。

运行（必须用 ComfyUI 的 venv，因为它提供 torch/PIL/numpy/httpx）：
    VIDEO_FLOW_TOKEN=... VIDEO_FLOW_BACKEND_URL=http://localhost:3100 \
      /Volumes/lvmac/ai/ComfyUI/ComfyUI/.venv/bin/python scripts/comfyui_client_preview_check.py
"""

import ast
import os
import sys

CLIENT_DIR = os.environ.get(
    "VIDEO_FLOW_CLIENT_DIR",
    "/Users/steven/works/20260909video_flow/packages/comfyui-video-flow-client",
)
sys.path.insert(0, CLIENT_DIR)

import torch  # noqa: E402
from config import VideoFlowConfig  # noqa: E402
from nodes import (  # noqa: E402
    VideoFlowConfigNode,
    VideoFlowSeedancePreview,
    VideoFlowWaitTask,
)

PROMPT = os.environ.get("PROMPT", "preview chain check")
BACKEND_URL = os.environ.get("VIDEO_FLOW_BACKEND_URL", "http://localhost:3100")


def main() -> int:
    # token 由 VideoFlowConfig.from_env() 解析：环境变量优先，其次 ~/.video-flow/token。
    if not VideoFlowConfig.from_env().token:
        print(
            "FAIL: 未找到凭证。请设置 VIDEO_FLOW_TOKEN，"
            "或把 token 写入 ~/.video-flow/token"
        )
        return 2

    # 1) 配置节点：验证 token 来自本机凭证源，而不是 Workflow JSON。
    config = VideoFlowConfigNode().configure(BACKEND_URL, "1")[0]
    print(f"[1/4] config ok: backend={config.backend_url} token_len={len(config.token)}")

    # 2) 构造一张最小图片（ComfyUI 的 IMAGE 类型是 [B,H,W,C] 的 float 张量）。
    image = torch.rand(1, 64, 64, 3)

    # 3) 生成节点：内部会走 上传票据 -> OSS 直传 -> 创建 preview 任务。
    task_id, summary = VideoFlowSeedancePreview().submit(config, PROMPT, image)
    print(f"[2/4] task created: {task_id}")
    print(f"      summary: {summary}")

    # 4) 等待节点：Preview 任务没有执行状态，只回读请求记录。
    task_json = VideoFlowWaitTask().wait(config, task_id)

    # 节点返回的是 ComfyUI 的元组包装，元素才是 str(dict) 形式的 Python repr。
    raw = task_json[0] if isinstance(task_json, (tuple, list)) else task_json
    print(f"[3/4] task read back: {str(raw)[:400]}")

    try:
        task = ast.literal_eval(raw)
    except (ValueError, SyntaxError):
        print("[4/4] FAIL: 无法解析节点返回的任务内容")
        print(f"TASK_ID={task_id}")
        return 1

    status = str(task.get("status") or "").lower()
    if status == "preview":
        print("[4/4] PASS: 任务状态为 preview，未进入付费执行队列")
        print(f"TASK_ID={task_id}")
        return 0

    print(f"[4/4] FAIL: 任务状态为 {status!r}，不是 preview，请立刻检查是否产生了付费调用")
    print(f"TASK_ID={task_id}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
