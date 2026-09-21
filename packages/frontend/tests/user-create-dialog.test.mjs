import assert from "node:assert/strict"
import test from "node:test"

import {
  createInitialUserDialogState,
  userDialogReducer,
} from "../lib/user-create-dialog.ts"

test("a successful creation replaces the form with a one-time token result", () => {
  const initial = {
    ...createInitialUserDialogState(),
    draft: { actorId: "creative-test", name: "测试用户" },
  }

  const result = userDialogReducer(initial, {
    type: "created",
    token: "vf_test_token",
  })

  assert.deepEqual(result, {
    phase: "success",
    draft: { actorId: "", name: "" },
    token: "vf_test_token",
    copied: false,
  })
})

test("closing or continuing clears the one-time token", () => {
  const success = {
    phase: "success",
    draft: { actorId: "", name: "" },
    token: "vf_test_token",
    copied: true,
  }

  assert.deepEqual(
    userDialogReducer(success, { type: "reset" }),
    createInitialUserDialogState(),
  )
})
