import { readdir, readFile } from "node:fs/promises"
import { extname, join, relative } from "node:path"

const hardLimit = 1_000
const reviewThreshold = 600
const root = new URL("../", import.meta.url).pathname
const legacy = new Map(Object.entries({
  "packages/desktop/src/main/workspace-ipc.ts": budget(5185, 5100),
  "packages/agent-runtime/src/cline-runtime.ts": budget(5006, 4900),
  "packages/app/src/components/backlog/drawer/markdown-editor.tsx": budget(2405, 2350),
  "packages/app/src/components/chat/agent-conversation.tsx": budget(2348, 2300),
  "packages/agent-runtime/src/agent-telemetry.ts": budget(2269, 2200),
  "packages/app/src/pages/backlog/page.tsx": budget(2155, 2100),
  "packages/app/src/components/model/model-selector.tsx": budget(2087, 2050),
  "packages/app/src/components/backlog/drawer/user-story-preview.tsx": budget(2035, 1950),
  "packages/app/src/pages/backlog/use-backlog-rotation.ts": budget(1393, 1350),
  "packages/desktop/src/main/workspace-compose.ts": budget(1327, 1250),
  "packages/desktop/src/main/code-review-graph.ts": budget(1314, 1250),
  "packages/app/src/components/backlog/data/agent-flow.ts": budget(1308, 1250),
  "packages/app/src/pages/settings/page.tsx": budget(1270, 1200),
  "packages/app/src/pages/chat/page.tsx": budget(1149, 1100),
  "packages/app/src/components/backlog/drawer/user-story-drawer-panel.tsx": budget(1112, 1050),
  "packages/app/src/pages/git/page.tsx": budget(1068, 1000),
  "packages/app/src/components/git/git-conflict-dialog.tsx": budget(1059, 1000),
  "packages/desktop/src/main/project-creation.ts": budget(1040, 1000),
  "packages/desktop/src/main/workspace-runtime.ts": budget(1036, 1000),
  "packages/agent-runtime/src/project-discovery.ts": budget(1006, 1000),
}))

const files = await sourceFiles(join(root, "packages"))
const failures = []
for (const file of files) {
  const path = relative(root, file)
  if (path === "packages/api/database/schema.ts") continue
  const lines = lineCount(await readFile(file, "utf8"))
  const allowance = legacy.get(path)
  const ceiling = allowance && Date.now() >= Date.parse(allowance.reviewAt)
    ? allowance.nextMaximum
    : allowance?.maximum ?? hardLimit
  if (lines > ceiling) failures.push(`${path}: ${lines} lines exceeds ${ceiling}`)
  else if (lines > reviewThreshold) console.warn(`line-budget review: ${path} (${lines})`)
}
if (failures.length) {
  console.error(failures.join("\n"))
  process.exitCode = 1
}

function budget(maximum, nextMaximum) {
  return { maximum, nextMaximum, reviewAt: "2026-10-01T00:00:00Z" }
}

async function sourceFiles(directory) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (![
        "dist",
        "build",
        "generated",
        ".adonisjs",
        "node_modules",
      ].includes(entry.name)) result.push(...await sourceFiles(path))
    } else if ([".ts", ".tsx"].includes(extname(path)) && !/\.(?:test|spec)\.[^.]+$/.test(path)) {
      result.push(path)
    }
  }
  return result
}

function lineCount(value) {
  return value ? value.split(/\r?\n/).length : 0
}
