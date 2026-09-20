import assert from "node:assert/strict"
import test from "node:test"
import { credentialFingerprint, normalizeLoginToken } from "../lib/auth-token.ts"

test("login trims whitespace copied with a token", () => {
  assert.equal(normalizeLoginToken("  vf_example_token\n"), "vf_example_token")
})

test("credential diagnostics use a short irreversible fingerprint", async () => {
  assert.equal(await credentialFingerprint("vf_example_token"), "6c009291b34f")
})
