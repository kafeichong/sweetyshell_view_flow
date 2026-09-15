// Video Flow 的最小状态展示：只在节点执行完成/失败时显示 taskId、本地路径与费用提示。
//
// 这里刻意不做完整前端：用户需要知道的只有"任务 id 是什么""片存到哪了""费用是否
// 已核实"。任何一步失败都不能影响 ComfyUI 本身，所以整体包在 try/catch 里。

import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { toastLines } from "../video_flow_status_state.mjs";

const WATCHED_NODES = new Set([
  "VideoFlowConfirmedCreate",
  "VideoFlowPolicyWait",
  "VideoFlowPolicyDownload",
  "VideoFlowWaitTask",
  "VideoFlowLoadResult",
]);

function notify(message) {
  try {
    if (app?.extensionManager?.toast?.add) {
      app.extensionManager.toast.add({ severity: "info", summary: "Video Flow", detail: message, life: 8000 });
      return;
    }
    if (app?.ui?.dialog?.show) {
      app.ui.dialog.show(`Video Flow: ${message}`);
      return;
    }
  } catch (error) {
    // 落回控制台，绝不因为展示失败打断工作流。
  }
  console.log(`[video-flow] ${message}`);
}

function labelFor(node) {
  return node?.title || node?.type || "Video Flow";
}

app.registerExtension({
  name: "video.flow.status",

  async setup() {
    try {
      api.addEventListener("executed", ({ detail }) => {
        const node = app.graph?.getNodeById?.(detail?.node) ?? null;
        if (!node || !WATCHED_NODES.has(node.comfyClass)) return;

        // 节点统一把要展示的一行放在 `ui.text` 里；旧的 task_id/local_path/
        // cost_status 三个键从来没有被发出过，读了只会静默不弹提示。
        const lines = toastLines(detail?.output ?? {});
        if (lines.length) notify(`${labelFor(node)}：${lines.join("；")}`);
      });

      api.addEventListener("execution_error", ({ detail }) => {
        // Wait/LoadResult 的终态错误带 taskId：把它显示出来，用户才知道用什么去核对。
        const message = detail?.exception_message || "执行失败";
        const taskId = detail?.exception_extra_info?.task_id;
        notify(taskId ? `${message}（taskId: ${taskId}）` : message);
      });
    } catch (error) {
      console.log(`[video-flow] status extension disabled: ${error}`);
    }
  },
});
