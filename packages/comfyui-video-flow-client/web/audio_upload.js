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

      const button = this.addWidget(
        "button",
        BUTTON_NAME,
        BUTTON_LABEL,
        () => {
          pickFile(async (file) => {
            try {
              await upload(this, widget, file);
            } catch (error) {
              report(`音频上传失败：${error?.message ?? error}`);
            }
          });
        },
        { serialize: false }
      );
      button.label = BUTTON_LABEL;
      button.tooltip = "从本机选一个音频文件（wav/mp3）传进 ComfyUI 的 input 目录";
      this.setSize(this.computeSize());
      return result;
    };
  },
});
