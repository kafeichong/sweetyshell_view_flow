import json
import subprocess
from pathlib import Path


def test_status_toast_reads_the_ui_text_channel_the_nodes_actually_send():
    """节点把给用户看的一行统一放在 ui.text 里。

    状态脚本原先找的是 output.task_id / local_path / cost_status —— 这三个键在 v2
    链路里**从来没被发出过**，所以 toast 一次都没出现过。这里固定住新约定。
    """
    module = Path(__file__).resolve().parents[1] / "web" / "video_flow_status_state.mjs"
    script = f"""
      import {{ toastLines }} from {json.dumps(module.as_uri())};

      const lines = toastLines({{ text: ["正式任务 t1；执行槽 slot-1；已提交，等待生成"] }});
      if (lines.length !== 1) process.exit(10);
      if (lines[0] !== "正式任务 t1；执行槽 slot-1；已提交，等待生成") process.exit(11);

      // 旧键名不再被当作数据源：它们从未出现过，留着只会掩盖真实缺口。
      if (toastLines({{ task_id: ["t1"], local_path: ["/tmp/a.mp4"] }}).length !== 0) process.exit(12);

      // 缺失、非数组、空白行都不产出提示。
      if (toastLines(undefined).length !== 0) process.exit(13);
      if (toastLines({{}}).length !== 0) process.exit(14);
      if (toastLines({{ text: "不是数组" }}).length !== 0) process.exit(15);
      if (toastLines({{ text: ["", "   ", null] }}).length !== 0) process.exit(16);

      // 多行保留顺序，并去掉每行首尾空白。
      const multi = toastLines({{ text: ["  第一行 ", "第二行"] }});
      if (multi.length !== 2) process.exit(17);
      if (multi[0] !== "第一行" || multi[1] !== "第二行") process.exit(18);
    """

    completed = subprocess.run(
        ["node", "--input-type=module", "--eval", script],
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode == 0, completed.stderr
