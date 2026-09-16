import json
import subprocess
from pathlib import Path


def test_report_state_replaces_old_success_with_pending_then_failure():
    module = Path(__file__).resolve().parents[1] / "web" / "preflight_report_state.mjs"
    script = f"""
      import {{ pendingReport, failedReport }} from {json.dumps(module.as_uri())};
      let value = "上一次 Preview 已通过";
      value = pendingReport();
      if (value.includes("已通过")) process.exit(10);
      value = failedReport("PREFLIGHT_EXPIRED");
      if (!value.includes("失败") || !value.includes("PREFLIGHT_EXPIRED")) process.exit(11);
    """

    completed = subprocess.run(
        ["node", "--input-type=module", "--eval", script],
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode == 0, completed.stderr


def test_report_never_resolves_nodes_through_the_active_tab():
    """报告只能写到**发起运行**的那个工作流里，不能写进"当前打开"的那个。

    踩过（用户报的）：用音频跑，报告落在另一个打开的工作流上。根因是节点定位用了
    `app.graph`——那是当前标签的图；而节点 id 在不同工作流之间会重号，于是报告写到了
    恰好同号的那个节点里。待机标记同理：扫 `app.graph` 会把别的标签的节点无故标成
    "运行中…"，而真正在跑的那个反而收不到。

    正确做法是用 ComfyUI 给节点调的 `onExecutionStart`——`this` 天然就是正确的那一个。
    """
    source = (Path(__file__).resolve().parents[1] / "web" / "preflight_report.js").read_text(
        encoding="utf-8"
    )
    # 注释里可以解释这条规矩，所以只查代码。
    code = "\n".join(line.split("//")[0] for line in source.splitlines())

    assert "app.graph" not in code, '别用 app.graph 定位节点：那是「当前打开」的标签，不是发起运行的那个'
    assert "onExecutionStart" in code, "待机标记要走 onExecutionStart，才能标到真正在跑的那个图"
