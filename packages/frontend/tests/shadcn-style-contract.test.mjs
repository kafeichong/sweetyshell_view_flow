import assert from "node:assert/strict"
import { existsSync, readFileSync, readdirSync } from "node:fs"
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

test("history selected task uses a softened semantic border", () => {
  const historyPage = readFileSync(join(frontendRoot, "app/(app)/history/page.tsx"), "utf8")

  assert.match(historyPage, /data-\[state=selected\]:border-foreground\/25/)
  assert.doesNotMatch(historyPage, /data-\[state=selected\]:border-foreground(?:\s|")/)
})

test("history constrains wide-screen content and caps the task-list width", () => {
  const historyPage = readFileSync(join(frontendRoot, "app/(app)/history/page.tsx"), "utf8")

  assert.match(historyPage, /mx-auto[^\"]*w-full[^\"]*max-w-\[1600px\]/)
  assert.match(historyPage, /lg:grid-cols-\[clamp\(17rem,32\.5%,22rem\)_minmax\(0,1fr\)\]/)
})

test("history uses admin-scoped read endpoints for administrator sessions", () => {
  const historyPage = readFileSync(join(frontendRoot, "app/(app)/history/page.tsx"), "utf8")

  assert.match(historyPage, /authMode === 'admin'/)
  assert.match(historyPage, /\/v1\/admin\/history\/tasks/)
  assert.match(historyPage, /\/v1\/admin\/history\/assets/)
  assert.match(historyPage, /'x-admin-token': token/)
})

test("showcase detail uses the same muted section header treatment", () => {
  const showcaseDetail = readFileSync(join(frontendRoot, "app/(app)/showcase/[taskId]/page.tsx"), "utf8")

  assert.equal(
    [...showcaseDetail.matchAll(/<CardHeader className="border-b bg-muted\/50">/g)].length,
    4,
  )
  assert.match(showcaseDetail, /<CardTitle className="text-base">参考素材<\/CardTitle>/)
  assert.match(showcaseDetail, /task\.inputAssets\.map/)
})

test("showcase prompt exposes an accessible copy action", () => {
  const showcaseDetail = readFileSync(join(frontendRoot, "app/(app)/showcase/[taskId]/page.tsx"), "utf8")

  assert.match(showcaseDetail, /aria-label=\{promptCopied \? '提示词已复制' : '复制提示词'\}/)
  assert.match(showcaseDetail, /writeClipboardText\(task\.prompt, navigator\.clipboard\)/)
})

test("showcase reference images expose an accessible full-size preview", () => {
  const showcaseDetail = readFileSync(join(frontendRoot, "app/(app)/showcase/[taskId]/page.tsx"), "utf8")
  const lightbox = readFileSync(join(frontendRoot, "components/image-lightbox.tsx"), "utf8")

  assert.match(showcaseDetail, /aria-label="放大查看参考图片"/)
  assert.match(showcaseDetail, /<ImageLightbox/)
  assert.match(lightbox, /role="dialog"/)
  assert.match(lightbox, /aria-modal="true"/)
  assert.match(lightbox, /event\.key === 'Escape'/)
})

test("showcase image preview navigates the complete reference-image gallery", () => {
  const lightbox = readFileSync(join(frontendRoot, "components/image-lightbox.tsx"), "utf8")

  assert.match(lightbox, /aria-label="上一张图片"/)
  assert.match(lightbox, /aria-label="下一张图片"/)
  assert.match(lightbox, /event\.key === 'ArrowLeft'/)
  assert.match(lightbox, /event\.key === 'ArrowRight'/)
  assert.match(lightbox, /\(index \+ direction \+ images\.length\) % images\.length/)
  assert.match(lightbox, /onTouchStart=/)
  assert.match(lightbox, /onTouchEnd=/)
})

test("showcase and history share the same input-image lightbox", () => {
  const showcaseDetail = readFileSync(join(frontendRoot, "app/(app)/showcase/[taskId]/page.tsx"), "utf8")
  const historyPage = readFileSync(join(frontendRoot, "app/(app)/history/page.tsx"), "utf8")

  assert.match(showcaseDetail, /<ImageLightbox/)
  assert.match(historyPage, /<ImageLightbox/)
  assert.match(historyPage, /aria-label="放大查看输入图片"/)
})

test("desktop sidebar stays viewport-fixed beside long page content", () => {
  const sidebar = readFileSync(join(frontendRoot, "components/ui/sidebar.tsx"), "utf8")

  assert.match(sidebar, /relative h-svh w-\(--sidebar-width\)/)
  assert.match(sidebar, /fixed inset-y-0 z-10 hidden h-svh w-\(--sidebar-width\)/)
})

test("all authenticated management pages inherit the shared sidebar layout", () => {
  assert.equal(existsSync(join(frontendRoot, "app/(app)/users/page.tsx")), true)
  assert.equal(existsSync(join(frontendRoot, "app/users/page.tsx")), false)
})

test("user-facing frontend uses the SweetyShell brand name", () => {
  const brandedSources = [
    join(frontendRoot, "app/layout.tsx"),
    join(frontendRoot, "app/login/page.tsx"),
    join(frontendRoot, "components/app-sidebar.tsx"),
  ].map((file) => readFileSync(file, "utf8")).join("\n")

  assert.doesNotMatch(brandedSources, /Video Flow(?: Console)?/)
  assert.equal([...brandedSources.matchAll(/糖果壳®SweetyShell®/g)].length, 3)
})

test("user token management is admin-only and reports real spending", () => {
  const sidebar = readFileSync(join(frontendRoot, "components/app-sidebar.tsx"), "utf8")
  const tokensPage = readFileSync(join(frontendRoot, "app/(app)/tokens/page.tsx"), "utf8")

  assert.match(sidebar, /authMode === 'user'[\s\S]*href: '\/alerts'[\s\S]*:[\s\S]*href: '\/tokens', label: '用户 Token'/)
  assert.match(sidebar, /href: '\/users', label: '用户管理'/)
  assert.match(tokensPage, /router\.replace\('\/dashboard'\)/)
  assert.match(tokensPage, /用户 Token 管理/)
  assert.match(tokensPage, /今日实际花费/)
  assert.match(tokensPage, /本月实际花费/)
  assert.match(tokensPage, /已预占/)
  assert.match(tokensPage, /待审核/)
})

test("token page text actions use readable shadcn button variants", () => {
  const tokensPage = readFileSync(join(frontendRoot, "app/(app)/tokens/page.tsx"), "utf8")

  assert.match(tokensPage, /variant="ghost"[\s\S]*?<RefreshCw/)
  assert.match(tokensPage, /variant="link"[\s\S]*?查看日志/)
  assert.match(tokensPage, /variant="secondary"[\s\S]*?<Download/)
  assert.doesNotMatch(tokensPage, /className="[^"]*text-primary hover:text-primary[^"]*"/)
})

test("SweetyShell logo is used by the sidebar and browser metadata", () => {
  const sidebar = readFileSync(join(frontendRoot, "components/app-sidebar.tsx"), "utf8")
  const layout = readFileSync(join(frontendRoot, "app/layout.tsx"), "utf8")

  assert.equal(existsSync(join(frontendRoot, "public/favicon.svg")), true)
  assert.match(sidebar, /src="\/favicon\.svg"/)
  assert.match(sidebar, /rounded-md border bg-background/)
  assert.match(layout, /icons:\s*\{\s*icon:\s*"\/favicon\.svg"/)
})
