import assert from "node:assert/strict"
import test from "node:test"

import {
  formatMonthlySettled,
  normalizeUserBusinessUsage,
} from "../lib/user-business-usage.ts"

test("older user responses without business usage render safe zero metrics", () => {
  assert.deepEqual(normalizeUserBusinessUsage({ usageCount: 68 }), {
    totalTasks: 0,
    monthlyTasks: 0,
    successfulTasks: 0,
  })
})

test("current user responses preserve backend business metrics", () => {
  assert.deepEqual(normalizeUserBusinessUsage({
    businessUsage: {
      totalTasks: 4,
      monthlyTasks: 3,
      successfulTasks: 2,
    },
  }), {
    totalTasks: 4,
    monthlyTasks: 3,
    successfulTasks: 2,
  })
})

test("older user responses without spending render a zero amount", () => {
  assert.equal(formatMonthlySettled(undefined), "0.00")
  assert.equal(formatMonthlySettled("27.369930"), "27.37")
})
