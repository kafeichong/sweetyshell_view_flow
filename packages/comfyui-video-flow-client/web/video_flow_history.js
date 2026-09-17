/**
 * ComfyUI 扩展入口
 * 在 ComfyUI 界面中添加消费与任务历史面板
 */

import { app } from "../../scripts/app.js";

let historyPanel = null;

// 动态加载 CSS
function loadCSS() {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = './extensions/video_flow_client/video_flow_history.css';
  document.head.appendChild(link);
}

// 动态加载组件
async function loadComponents() {
  const { VideoFlowHistoryPanel } = await import('./js/VideoFlowHistoryPanel.js');
  return VideoFlowHistoryPanel;
}

app.registerExtension({
  name: "video.flow.history",

  async setup() {
    console.log('[VideoFlow] Loading history panel...');

    // 加载样式
    loadCSS();

    // 等待 ComfyUI 界面加载完成
    await new Promise(resolve => setTimeout(resolve, 500));

    try {
      // 动态加载组件
      const VideoFlowHistoryPanel = await loadComponents();

      // 创建固定在右侧的容器（确保在 body 下而不是 canvas 中）
      let container = document.querySelector('.vf-sidebar-container');
      if (!container) {
        container = document.createElement('div');
        container.className = 'vf-sidebar-container';
        container.style.cssText = `
          position: fixed;
          right: 20px;
          top: 80px;
          z-index: 10000;
          pointer-events: auto;
        `;
        // 直接添加到 body 末尾，避免被 ComfyUI 的画布覆盖
        document.body.appendChild(container);
      }

      // 创建并挂载面板
      historyPanel = new VideoFlowHistoryPanel();
      historyPanel.mount(container);

      console.log('[VideoFlow] History panel loaded successfully ✅');
    } catch (error) {
      console.error('[VideoFlow] Failed to load history panel:', error);
    }
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    // 当 VideoFlowConfirmedCreate 节点执行完成后，刷新任务列表
    if (nodeData.name === "VideoFlowConfirmedCreate") {
      const originalExecuted = nodeType.prototype.onExecuted;
      nodeType.prototype.onExecuted = function (message) {
        originalExecuted?.apply(this, arguments);

        // 延迟刷新，等待任务创建完成
        setTimeout(() => {
          if (historyPanel) {
            console.log('[VideoFlow] Refreshing history after task creation');
            historyPanel.refresh();
          }
        }, 1000);
      };
    }
  },
});

// 提供全局刷新方法
window.videoFlowRefreshHistory = () => {
  if (historyPanel) {
    historyPanel.refresh();
  } else {
    console.warn('[VideoFlow] History panel not loaded yet');
  }
};
