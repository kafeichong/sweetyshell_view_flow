import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"

async function productionCss() {
  const globalsPath = new URL("../app/globals.css", import.meta.url)
  const source = readFileSync(globalsPath, "utf8")
  const result = await postcss([tailwindcss()]).process(source, {
    from: globalsPath.pathname,
  })
  return result.css
}

test("the production stylesheet contains the sidebar-07 color utilities", async () => {
  const css = await productionCss()

  for (const selector of [
    ".bg-sidebar",
    ".text-sidebar-foreground",
    ".border-sidebar-border",
    ".ring-sidebar-ring",
  ]) {
    assert.match(css, new RegExp(`\\${selector}\\s*[{]`))
  }
})
