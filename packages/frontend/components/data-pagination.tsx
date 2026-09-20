import { Button } from "@/components/ui/button"

interface DataPaginationProps {
  page: number
  totalPages: number
  total?: number
  onPageChange: (page: number) => void
}

export function DataPagination({ page, totalPages, total, onPageChange }: DataPaginationProps) {
  const safeTotalPages = Math.max(1, totalPages)
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm text-muted-foreground">
        {typeof total === "number" ? `共 ${total} 条，` : ""}第 {page} / {safeTotalPages} 页
      </p>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => onPageChange(page - 1)} disabled={page <= 1}>上一页</Button>
        <Button variant="outline" size="sm" onClick={() => onPageChange(page + 1)} disabled={page >= safeTotalPages}>下一页</Button>
      </div>
    </div>
  )
}
