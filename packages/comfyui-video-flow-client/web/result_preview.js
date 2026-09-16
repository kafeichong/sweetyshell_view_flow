import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// 成片预览。
//
// 为什么不用节点返回 `ui.images` 让 ComfyUI 自己挂——前端收到 `executed` 之后是这样找节点的：
//
//     getNodeByExecutionId(this.rootGraph, id)   // this.rootGraph = **当前活动工作流**
//
// 而 node id 在不同工作流之间会重号（都是从 1 开始的小整数）。云端出片要几分钟，这期间用户
// 很容易切到别的工作流；视频回来时那个 id 就在**当前**那张图里找到了"另一个"节点，预览于是
// 挂到了别的工作流上（用户报过：用音频跑，结果落在另一个打开的工作流里）。同一个原因也会让
// `onExecuted` 调到错误的节点上，所以**连 onExecuted 也不能依赖**。
//
// 这里绕开它：自己监听 `executed`，用**发起运行的那个图**去定位节点（记在 runningGraph）。
// 相应的，Python 侧不再返回 `ui.images`，前端就不会自己去挂一遍。
const NODE_CLASS = "VideoFlowPolicyPreview";
const RESULT_KEY = "video_flow_video";
const WIDGET_NAME = "result_video";
// 预览框高度。固定值 + `object-fit: contain`，横竖屏都在框内按比例居中，永远不会撑破节点。
const PREVIEW_HEIGHT = 260;

// 发起运行的那个图。`execution_start` 是点运行那一刻发出的，此时活动标签就是"要跑的那个"，
// 之后用户随便切都影响不到它。
let runningGraph = null;

function videoUrl(item) {
  const params = new URLSearchParams({
    filename: item.filename,
    subfolder: item.subfolder ?? "",
    type: item.type ?? "output",
  });
  return api.apiURL(`/view?${params.toString()}`);
}

function playerWidget(node) {
  const existing = node.widgets?.find((widget) => widget.name === WIDGET_NAME);
  if (existing) return existing;

  const video = document.createElement("video");
  video.controls = true;
  video.loop = true;
  video.muted = true;
  video.playsInline = true;
  // 尺寸交给容器（100% + `object-fit: contain`），自己**不设固定像素**：DOM widget 的容器
  // 跟着画布缩放走，写死像素会和它对不上，视频就溢出节点外框。盒子多高由下面的 PREVIEW_HEIGHT
  // 经 `widget.computeSize` 定——盒子太小的时候竖屏成片会被压成一条，等于看不见（用户报过）。
  video.style.cssText = "display:block;width:100%;height:100%;object-fit:contain;border-radius:6px;background:#000";

  const widget = node.addDOMWidget(WIDGET_NAME, "video", video);
  widget.serialize = false;
  widget.options.serialize = false;
  // 不带 canvasOnly：带了就只有经典画布看得见（同 web/audio_upload.js 里的说明）。
  widget.options.canvasOnly = false;
  widget.videoEl = video;
  return widget;
}

app.registerExtension({
  name: "video.flow.result.preview",
  setup() {
    api.addEventListener("execution_start", () => {
      runningGraph = app.graph ?? runningGraph;
    });

    api.addEventListener("executed", ({ detail } = {}) => {
      const items = detail?.output?.[RESULT_KEY];
      if (!Array.isArray(items) || !items.length) return;

      const rawId = detail?.display_node ?? detail?.node;
      // 用记下来的图，**不是** app.graph / app.rootGraph：那是"当前打开"的标签。
      const target = (runningGraph ?? app.graph)?.getNodeById?.(rawId);
      if (!target || target.comfyClass !== NODE_CLASS) return;

      const widget = playerWidget(target);
      const video = widget.videoEl;
      // 只定**节点**的尺寸：节点撑到至少 360 宽、外加一条 PREVIEW_HEIGHT 的预览框。
      const width = Math.max(target.size?.[0] ?? 0, 360);
      widget.computeSize = () => [width, PREVIEW_HEIGHT];
      video.src = videoUrl(items[0]);
      target.setSize([width, target.computeSize()[1]]);
      target.setDirtyCanvas?.(true, true);
    });
  },
});
