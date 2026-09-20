import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { extname, join, relative } from "node:path"
import test from "node:test"

const frontendRoot = new URL("..", import.meta.url).pathname
const sourceRoots = ["app", "components"]
const forbiddenPatterns = [
  ["gradient", /(?:bg-gradient-|from-(?:gray|blue|purple|pink|green|orange|red)-|to-(?:gray|blue|purple|pink|green|orange|red)-)/g],
  ["glass", /(?:backdrop-blur|bg-white\/\d+)/g],
  ["large shadow", /shadow-(?:md|lg|xl|2xl)/g],
  ["fixed color", /(?:bg|text|border|ring)-(?:gray|blue|purple|pink|green|orange|red)-\d{2,3}/g],
  ["fixed neutral", /(?:bg|text|border)-(?:white|black)(?!\/)/g],
  ["fixed warning color", /(?:bg|text|border|ring)-yellow-\d{2,3}/g],
  ["custom large radius", /rounded-(?:lg|xl|2xl|3xl)/g],
  ["raw form control", /<(?:button|select|input)\b/g],
  ["emoji icon", /[💰📊📈⚠✅ℹ🔄📥✓]/gu],
]

function collectSourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (absolutePath.endsWith(join("components", "ui"))) return []
      return collectSourceFiles(absolutePath)
    }
    if (![".tsx", ".ts", ".css"].includes(extname(entry.name))) return []
    return [absolutePath]
  })
}

function formalSourceFiles() {
  return sourceRoots
    .flatMap((root) => collectSourceFiles(join(frontendRoot, root)))
    .filter((file) => !file.endsWith(".d.ts"))
}

function allFrontendSourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = join(directory, entry.name)
    if (entry.isDirectory()) return allFrontendSourceFiles(absolutePath)
    if (![".tsx", ".ts", ".css"].includes(extname(entry.name))) return []
    return [absolutePath]
  })
}

test("formal pages use only the shadcn semantic visual system", () => {
  const violations = []

  for (const file of formalSourceFiles()) {
    const source = readFileSync(file, "utf8")
    for (const [rule, pattern] of forbiddenPatterns) {
      const matches = [...source.matchAll(pattern)].map((match) => match[0])
      if (matches.length > 0) {
        violations.push(`${relative(frontendRoot, file)}: ${rule}: ${[...new Set(matches)].join(", ")}`)
      }
    }
  }

  assert.deepEqual(violations, [])
})

test("shadcn is configured as the only New York zinc design source", () => {
  const config = JSON.parse(readFileSync(join(frontendRoot, "components.json"), "utf8"))

  assert.equal(config.style, "new-york")
  assert.equal(config.tailwind.baseColor, "zinc")
  assert.equal(config.tailwind.cssVariables, true)
})

test("formal frontend source never logs authentication tokens", () => {
  const violations = formalSourceFiles()
    .filter((file) => /console\.(?:log|error)\([^\n]*(?:auth_token|,\s*token\b|token\s*\))/i.test(readFileSync(file, "utf8")))
    .map((file) => relative(frontendRoot, file))

  assert.deepEqual(violations, [])
})

test("formal frontend source does not hardcode the retired 3001 backend", () => {
  const violations = formalSourceFiles()
    .filter((file) => readFileSync(file, "utf8").includes("localhost:3001"))
    .map((file) => relative(frontendRoot, file))

  assert.deepEqual(violations, [])
})

test("frontend typography uses regular font weight throughout", () => {
  const heavyFontWeight = /(?:font-(?:medium|semibold|bold|extrabold|black)|font-weight\s*:\s*(?:[5-9]00|bold(?:er)?))/g
  const violations = sourceRoots
    .flatMap((root) => allFrontendSourceFiles(join(frontendRoot, root)))
    .filter((file) => !file.endsWith(".d.ts"))
    .flatMap((file) => {
      const matches = [...readFileSync(file, "utf8").matchAll(heavyFontWeight)].map((match) => match[0])
      return matches.length === 0
        ? []
        : [`${relative(frontendRoot, file)}: ${[...new Set(matches)].join(", ")}`]
    })

  assert.deepEqual(violations, [])
})

test("history detail sections separate muted headers from card content", () => {
  const historyPage = readFileSync(join(frontendRoot, "app/(app)/history/page.tsx"), "utf8")

  assert.equal(
    [...historyPage.matchAll(/<CardHeader className="border-b bg-muted\/50">/g)].length,
    4,
  )
  assert.match(
    historyPage,
    /<summary className="[^"]*bg-muted\/50[^"]*">工作流详情<\/summary>/,
  )
})

test("showcase detail uses the same muted section header treatment", () => {
  const showcaseDetail = readFileSync(join(frontendRoot, "app/(app)/showcase/[taskId]/page.tsx"), "utf8")

  assert.equal(
    [...showcaseDetail.matchAll(/<CardHeader className="border-b bg-muted\/50">/g)].length,
    3,
  )
})

test("showcase prompt exposes an accessible copy action", () => {
  const showcaseDetail = readFileSync(join(frontendRoot, "app/(app)/showcase/[taskId]/page.tsx"), "utf8")

  assert.match(showcaseDetail, /aria-label=\{promptCopied \? '提示词已复制' : '复制提示词'\}/)
  assert.match(showcaseDetail, /writeClipboardText\(task\.prompt, navigator\.clipboard\)/)
})

test("desktop sidebar stays viewport-fixed beside long page content", () => {
  const sidebar = readFileSync(join(frontendRoot, "components/ui/sidebar.tsx"), "utf8")

  assert.match(sidebar, /relative h-svh w-\(--sidebar-width\)/)
  assert.match(sidebar, /fixed inset-y-0 z-10 hidden h-svh w-\(--sidebar-width\)/)
})
