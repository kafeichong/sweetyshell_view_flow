import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// 音频参考槽的上传按钮。
//
// 为什么不是给节点加个 audio_upload 标志就完事——前端"音频上传"那条路是写给 LoadAudio
// 那一族的：extensions/core/uploadAudio.ts 会注入一个 AUDIOUPLOAD widget，而它一上来就
// `node.widgets.find(w => w.name === 'audioUI')`。audioUI 只由 Comfy.AudioWidget 对
// LoadAudio / SaveAudio / PreviewAudio / ... 这几个类注入，我们的自定义节点不在名单里，
// 于是它拿到 undefined 就去取 .element，构造时直接抛错，按钮不会出现。
//
// 视频能靠标志解决，是因为它走的是另一条注入路（useImageUploadWidget），而那条路只认
// image_upload / video_upload / animated_image_upload，**明确不认 audio_upload**。
// 两条路都指望不上，音频只能自己加按钮。
//
// 按钮**不能**带 canvasOnly：Nodes 2.0 的 widgetRegistry 用
// `!options.canvasOnly && !!widget.type` 决定渲不渲染，带了就只有经典画布看得见。
//
// 两条使用路径，只有一条通：
// - **画布上**（主路径）：自绘的 DOM 按钮，宽高我们说了算，正常工作。
// - **右侧边栏「参数」里**：那一行由 ComfyUI 自己渲染，点它**没有反应**。查过：前端里负责
//   这类按钮的 `WidgetButton` 组件源码是 `handleClick = () => widget.callback?.()`，也就是
//   它本该走 callback——但用"改页面标题"的探针实测，点标题、点按钮都不触发。说明那个面板
//   走的不是这个组件，实际分发路径没定位到。`widget.callback` 这里仍然挂着（成本为零，
//   哪个面板真按 callback 触发就自然能用）。**要传音频请用画布上的按钮。**
const UPLOAD_ENDPOINT = "/upload/image";
const ACCEPTED_TYPES = ".wav,.mp3,audio/*";
const BUTTON_LABEL = "选择音频文件上传";
const BUTTON_NAME = "upload_audio";
const AUDIO_NODE = "VideoFlowReferenceAudioInput";

function audioWidget(node) {
  return node.widgets?.find((widget) => widget.name === "audio") ?? null;
}

function report(message) {
  // 扩展里拿不到内部的 toast store（那是 `@/` 别名下的模块），dialog 是公开且够用的。
  if (app.ui?.dialog?.show) app.ui.dialog.show(message);
  else console.error(`[video.flow] ${message}`);
}

function pickFile(onFile) {
  const picker = document.createElement("input");
  picker.type = "file";
  picker.accept = ACCEPTED_TYPES;
  picker.style.display = "none";
  document.body.append(picker);
  picker.addEventListener("cancel", () => picker.remove());
  picker.addEventListener("change", () => {
    const file = picker.files?.[0];
    picker.remove();
    if (file) onFile(file);
  });
  picker.click();
}

// 与 ComfyUI 自带的图片/音频上传一致：这里也发到 /upload/image —— 那是通用的上传入口，
// 文件名里的 image 是历史包袱，服务端收任何类型的文件，返回 {name, subfolder, type}。
async function upload(node, widget, file) {
  const body = new FormData();
  body.append("image", file);
  const response = await api.fetchApi(UPLOAD_ENDPOINT, { method: "POST", body });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const data = await response.json();
  const path = data.subfolder ? `${data.subfolder}/${data.name}` : data.name;

  // 传进来的文件要进下拉的选项里，否则这个值不在候选内，用户之后也没法再选回它。
  const values = widget.options?.values;
  if (Array.isArray(values) && !values.includes(path)) values.push(path);

  const previous = widget.value;
  widget.value = path;
  widget.callback?.(path);
  node.onWidgetChanged?.(widget.name, path, previous, widget);
  node.setDirtyCanvas?.(true, true);
}

app.registerExtension({
  name: "video.flow.audio-upload",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== AUDIO_NODE) return;

    const originalCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = originalCreated?.apply(this, arguments);
      const widget = audioWidget(this);
      // 拿不到槽位就什么都不加：宁可没有按钮，也不要挂一个点了没反应的按钮上去。
      if (!widget) return result;

      // 用 **DOM widget** 而不是 litegraph 的 `addWidget("button", …)`：新界面把 widget 渲染成
      // 「标签 | 控件」一行，button 会被当成右侧那个小控件，左边半行是点不到的标签文字——用户
      // 反馈"按钮很小很窄，要瞄准"就是这个。DOM widget 让我们拿到整个元素，宽度撑满、高度给足。
      // 这也正是 ComfyUI 自己对音频的做法（前端 AUDIO_UI：addDOMWidget + options.canvasOnly=false）。
      // 画布上的自绘按钮和侧边栏的参数行都会调它——两条路共用同一个入口。
      const chooseFile = () => {
        pickFile(async (file) => {
          try {
            await upload(this, widget, file);
          } catch (error) {
            report(`音频上传失败：${error?.message ?? error}`);
          }
        });
      };

      const button = document.createElement("button");
      button.type = "button";
      button.textContent = BUTTON_LABEL;
      button.title = "从本机选一个音频文件（wav/mp3）传进 ComfyUI 的 input 目录";
      button.style.cssText = [
        "width:100%",
        "height:34px",
        "cursor:pointer",
        "border-radius:6px",
        "font-size:13px",
        "border:1px solid var(--border-color,#3a3a3a)",
        "background:var(--comfy-input-bg,#2a2a2a)",
        "color:var(--input-text,#dddddd)",
      ].join(";");
      button.addEventListener("click", chooseFile);

      const domWidget = this.addDOMWidget(BUTTON_NAME, "button", button);
      // 侧边栏「参数」是**另一套渲染**：它不挂我们这个元素，只按 widget 的 name/label/callback
      // 画一个自己的按钮。所以只挂元素上的 click 会得到"画布上能点、侧边栏点了没反应"；label
      // 不设的话侧边栏还会直接把 widget 名 `upload_audio` 当按钮文字显示出来。
      domWidget.label = BUTTON_LABEL;
      domWidget.callback = chooseFile;
      domWidget.serialize = false;
      domWidget.options.serialize = false;
      // 不带 canvasOnly：新界面的 widgetRegistry 用 `!options.canvasOnly && !!widget.type`
      // 决定渲不渲染，带了就只有经典画布看得见。
      domWidget.options.canvasOnly = false;
      this.setSize(this.computeSize());
      return result;
    };
  },
});
