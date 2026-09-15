// 节点把给用户看的一行统一放在 `ui.text` 里——ComfyUI 只在节点返回 `ui` 键时
// 才发 `executed` 事件，所以这是用户看到 taskId 的唯一通道。
//
// 这里只做一件事：把那个数组整理成可直接显示的若干行。抽成无副作用模块是为了
// 能在 node 里直测——调用它的 .js 需要 `import "../../scripts/app.js"`，
// 在浏览器之外加载不了。

export function toastLines(output) {
  const text = output?.text;
  if (!Array.isArray(text)) {
    return [];
  }
  return text
    .map((line) => (line === null || line === undefined ? "" : String(line).trim()))
    .filter((line) => line.length > 0);
}
