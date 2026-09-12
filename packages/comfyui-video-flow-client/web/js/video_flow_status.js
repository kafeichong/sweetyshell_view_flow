// Video Flow 的最小状态展示：只在节点执行完成/失败时显示 taskId、本地路径与费用提示。
//
// 这里刻意不做完整前端：用户需要知道的只有"任务 id 是什么""片存到哪了""费用是否
// 已核实"。任何一步失败都不能影响 ComfyUI 本身，所以整体包在 try/catch 里。

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const WATCHED_NODES = new Set([
  "VideoFlowSeedanceProduction",
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

        const output = detail?.output ?? {};
        const taskId = output.task_id?.[0] ?? node.widgets?.find?.((w) => w.name === "task_id")?.value;
        const localPath = output.local_path?.[0] ?? output.local_video_path?.[0];
        const costStatus = output.cost_status?.[0];

        const parts = [];
        if (taskId) parts.push(`任务 ${taskId}`);
        if (localPath) parts.push(`已保存到 ${localPath}`);
        if (costStatus) parts.push(costStatus);
        if (parts.length) notify(`${labelFor(node)}：${parts.join("；")}`);
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
