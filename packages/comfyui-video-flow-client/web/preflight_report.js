import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { ComfyWidgets } from "../../scripts/widgets.js";
import { failedReport, pendingReport } from "./preflight_report_state.mjs";

// 只放真正会输出"检查报告"的节点。VideoFlowPolicyDownload 不在其中：它的 ui.text
// 是本地文件路径，塞进"检查报告"框会让人误以为那是服务端报告（路径改由状态 toast 展示）。
const watched = new Set(["VideoFlowRequestPreflight", "VideoFlowConfirmedCreate"]);

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

// **正在跑的那个图**。多标签下不能用 `app.graph`——那是"当前打开"的标签，不是"发起运行"的那个；
// 节点 id 在不同工作流之间还会重号，于是报告会写到另一个工作流里恰好同号的那个节点上（用户
// 报过：用音频跑，结果落在另一个打开的工作流上）。改成记下**真正开始执行的那个图**：
// ComfyUI 会对开始执行的图里的节点调 `onExecutionStart`，`this.graph` 就是它，不用猜。
let runningGraph = null;

app.registerExtension({
  name: "video.flow.preflight.report",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (!watched.has(nodeData.name)) return;
    const original = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      original?.apply(this, arguments);
      setReport(this, (message.text || []).join("\n"));
    };
    // 待机标记挂在**节点自己**身上，而不是扫 `app.graph`：这样多标签下只标到真正要跑的那个
    // 图，也不会把别的标签的节点无故标成"运行中…"。
    const originalStart = nodeType.prototype.onExecutionStart;
    nodeType.prototype.onExecutionStart = function () {
      originalStart?.apply(this, arguments);
      runningGraph = this.graph ?? runningGraph;
      if (this.preflightReport) setReport(this, pendingReport());
    };
  },
  setup() {
    api.addEventListener("execution_error", ({ detail } = {}) => {
      const nodeId = detail?.node_id ?? detail?.node;
      // 用记下来的图，**不是** `app.graph`：出错时用户很可能已经切到别的标签了。
      const node = runningGraph?.getNodeById?.(nodeId);
      if (!node || !watched.has(node.comfyClass)) return;
      const message = detail?.exception_message || detail?.exception_type || detail?.error;
      setReport(node, failedReport(message));
    });
  },
});
