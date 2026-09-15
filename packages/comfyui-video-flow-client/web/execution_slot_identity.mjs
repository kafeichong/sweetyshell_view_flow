export function ensureExecutionSlotId(widget, factory) {
  const current = typeof widget?.value === "string" ? widget.value.trim() : "";
  if (current) return current;
  return replaceExecutionSlotId(widget, factory);
}

export function replaceExecutionSlotId(widget, factory) {
  if (!widget) throw new Error("execution_slot_id widget is missing");
  const value = factory();
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("execution slot factory returned an invalid value");
  }
  widget.value = value.trim();
  return widget.value;
}
