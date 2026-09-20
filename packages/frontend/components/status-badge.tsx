import { Badge, type BadgeProps } from "@/components/ui/badge"

const labels: Record<string, string> = {
  pending: "等待中",
  processing: "处理中",
  running: "运行中",
  completed: "已完成",
  success: "成功",
  failed: "失败",
  active: "正常",
  disabled: "已停用",
}

function variantFor(status: string): BadgeProps["variant"] {
  if (["failed", "error", "disabled"].includes(status)) return "destructive"
  if (["completed", "success", "active"].includes(status)) return "default"
  return "secondary"
}

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return <Badge variant={variantFor(status)}>{label ?? labels[status] ?? status}</Badge>
}
