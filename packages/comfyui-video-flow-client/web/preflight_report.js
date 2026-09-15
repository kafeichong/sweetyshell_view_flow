import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { ComfyWidgets } from "../../scripts/widgets.js";
import { failedReport, pendingReport } from "./preflight_report_state.mjs";

const watched = new Set(["VideoFlowRequestPreflight", "VideoFlowConfirmedCreate", "VideoFlowPolicyDownload"]);

function setReport(node, value) {
  if (!node.preflightReport) {
    node.preflightReport = ComfyWidgets.STRING(node, "检查报告", ["STRING", { multiline: true }], app).widget;
    node.preflightReport.options.serialize = false;
    if (node.preflightReport.inputEl) node.preflightReport.inputEl.readOnly = true;
  }
  node.preflightReport.value = value;
  node.setSize(node.computeSize());
  node.setDirtyCanvas(true, true);
}

app.registerExtension({
  name: "video.flow.preflight.report",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (!watched.has(nodeData.name)) return;
    const original = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      original?.apply(this, arguments);
      setReport(this, (message.text || []).join("\n"));
    };
  },
  setup() {
    api.addEventListener("execution_start", () => {
      for (const node of app.graph?._nodes || []) {
        if (node.preflightReport) setReport(node, pendingReport());
      }
    });
    api.addEventListener("execution_error", ({ detail } = {}) => {
      const nodeId = detail?.node_id ?? detail?.node;
      const node = app.graph?.getNodeById?.(nodeId);
      if (!node || !watched.has(node.comfyClass)) return;
      const message = detail?.exception_message || detail?.exception_type || detail?.error;
      setReport(node, failedReport(message));
    });
  },
});
