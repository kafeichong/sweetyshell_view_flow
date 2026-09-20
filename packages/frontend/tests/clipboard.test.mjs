import assert from "node:assert/strict"
import test from "node:test"

import { writeClipboardText } from "../lib/clipboard.ts"

test("copyable workflow names write their complete text to the clipboard", async () => {
  let clipboardText = ""
  const clipboard = {
    async writeText(value) {
      clipboardText = value
    },
  }

  await writeClipboardText("多模态参考", clipboard)

  assert.equal(clipboardText, "多模态参考")
})
