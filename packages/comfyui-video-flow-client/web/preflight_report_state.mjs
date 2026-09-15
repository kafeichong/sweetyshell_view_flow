export function pendingReport() {
  return "本次检查尚未完成，请等待结果。";
}

export function failedReport(message) {
  const detail = typeof message === "string" && message.trim()
    ? message.trim()
    : "未知错误";
  return `本次检查失败：${detail}`;
}
