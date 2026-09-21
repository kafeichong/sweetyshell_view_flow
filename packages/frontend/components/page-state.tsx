import { AlertCircle, Inbox } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"

interface PageStateProps {
  kind: "loading" | "empty" | "error"
  title?: string
  description?: string
  action?: React.ReactNode
}

export function PageState({ kind, title, description, action }: PageStateProps) {
  if (kind === "loading") {
    return (
      <div className="space-y-3" aria-label={title ?? "加载中"}>
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }

  if (kind === "error") {
    return (
      <Alert variant="destructive">
        <AlertCircle className="size-4" />
        <AlertTitle>{title ?? "加载失败"}</AlertTitle>
        {description ? <AlertDescription>{description}</AlertDescription> : null}
        {action ? <div className="mt-4">{action}</div> : null}
      </Alert>
    )
  }

  return (
    <div className="flex min-h-40 flex-col items-center justify-center gap-2 border border-dashed p-8 text-center">
      <Inbox className="size-8 text-muted-foreground" />
      <p className="font-normal">{title ?? "暂无数据"}</p>
      {description ? <p className="max-w-md text-sm text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  )
}
