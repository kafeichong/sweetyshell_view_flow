import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { ComfyWidgets } from "../../scripts/widgets.js";
const watched = new Set(["VideoFlowRequestPreflight", "VideoFlowPolicyDownload"]);
app.registerExtension({
  name: "video.flow.preflight.report",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (!watched.has(nodeData.name)) return;
    const original = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      original?.apply(this, arguments);
      if (!this.preflightReport) {
        this.preflightReport = ComfyWidgets.STRING(this, "检查报告", ["STRING", { multiline: true }], app).widget;
        this.preflightReport.options.serialize = false;
        if (this.preflightReport.inputEl) this.preflightReport.inputEl.readOnly = true;
      }
      this.preflightReport.value = (message.text || []).join("\n");
      this.setSize(this.computeSize());
      this.setDirtyCanvas(true, true);
    };
  },
  setup() {
    api.addEventListener("execution_start", () => {
      for (const node of app.graph?._nodes || []) {
        if (node.preflightReport) node.preflightReport.value = "本次检查尚未完成，请等待结果。";
      }
    });
  },
});
