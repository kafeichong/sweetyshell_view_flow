import json
import subprocess
from pathlib import Path


def test_browser_slot_helper_preserves_existing_id_and_rekeys_a_copy():
    module = Path(__file__).resolve().parents[1] / "web" / "execution_slot_identity.mjs"
    script = f"""
      import {{ ensureExecutionSlotId, replaceExecutionSlotId }} from {json.dumps(module.as_uri())};
      const values = ["slot-existing"];
      const widget = {{ get value() {{ return values[0]; }}, set value(v) {{ values[0] = v; }} }};
      const generated = ["slot-created", "slot-copy"];
      const factory = () => generated.shift();
      if (ensureExecutionSlotId(widget, factory) !== "slot-existing") process.exit(10);
      if (widget.value !== "slot-existing") process.exit(11);
      if (replaceExecutionSlotId(widget, factory) !== "slot-created") process.exit(12);
      if (replaceExecutionSlotId(widget, factory) !== "slot-copy") process.exit(13);
      if (widget.value !== "slot-copy") process.exit(14);
    """

    completed = subprocess.run(
        ["node", "--input-type=module", "--eval", script],
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode == 0, completed.stderr
