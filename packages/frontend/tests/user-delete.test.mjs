import assert from "node:assert/strict"
import test from "node:test"

import { isActorDeletionConfirmed } from "../lib/user-delete.ts"

test("permanent deletion requires an exact actor id confirmation", () => {
  assert.equal(isActorDeletionConfirmed("test-user", "test-user"), true)
  assert.equal(isActorDeletionConfirmed(" test-user ", "test-user"), false)
  assert.equal(isActorDeletionConfirmed("Test-User", "test-user"), false)
  assert.equal(isActorDeletionConfirmed("", "test-user"), false)
})
