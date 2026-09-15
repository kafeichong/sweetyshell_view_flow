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
