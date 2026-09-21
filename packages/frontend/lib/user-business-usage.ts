export interface UserBusinessUsage {
  totalTasks: number
  monthlyTasks: number
  successfulTasks: number
}

export function normalizeUserBusinessUsage(user: {
  businessUsage?: Partial<UserBusinessUsage> | null
}): UserBusinessUsage {
  return {
    totalTasks: finiteCount(user.businessUsage?.totalTasks),
    monthlyTasks: finiteCount(user.businessUsage?.monthlyTasks),
    successfulTasks: finiteCount(user.businessUsage?.successfulTasks),
  }
}

export function formatMonthlySettled(value: string | null | undefined) {
  const amount = Number(value)
  return Number.isFinite(amount) ? amount.toFixed(2) : '0.00'
}

function finiteCount(value: number | undefined) {
  return Number.isFinite(value) ? value as number : 0
}
