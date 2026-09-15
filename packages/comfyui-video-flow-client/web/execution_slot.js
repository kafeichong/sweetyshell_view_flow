import { app } from "../../scripts/app.js";
import { ensureExecutionSlotId, replaceExecutionSlotId } from "./execution_slot_identity.mjs";

function newExecutionSlotId() {
  if (globalThis.crypto?.randomUUID) return `slot-${globalThis.crypto.randomUUID()}`;
  return `slot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function slotWidget(node) {
  return node.widgets?.find?.((widget) => widget.name === "execution_slot_id") ?? null;
}

function protectWidget(widget) {
  if (widget?.inputEl) widget.inputEl.readOnly = true;
}

app.registerExtension({
  name: "video.flow.execution-slot",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "VideoFlowConfirmedCreate") return;

    const originalCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = originalCreated?.apply(this, arguments);
      const widget = slotWidget(this);
      ensureExecutionSlotId(widget, newExecutionSlotId);
      protectWidget(widget);
      return result;
    };

    const originalClone = nodeType.prototype.clone;
    nodeType.prototype.clone = function () {
      const cloned = originalClone.apply(this, arguments);
      const widget = slotWidget(cloned);
      replaceExecutionSlotId(widget, newExecutionSlotId);
      protectWidget(widget);
      return cloned;
    };
  },
});
