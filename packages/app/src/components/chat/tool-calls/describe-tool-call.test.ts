import assert from "node:assert/strict"
import test from "node:test"
import { encodeToolResult } from "@blame/agent-runtime/tool-result-envelope"

import { describeToolCall, toolCallSource } from "./describe-tool-call.ts"

// Payloads below are real outputs captured from the Blame harness.
function view(
  toolName: string,
  input: unknown,
  output?: unknown,
  running = false
) {
  return describeToolCall(
    toolCallSource(
      {
        kind: "tool",
        title: toolName,
        toolName,
        detail: JSON.stringify({ toolName, input, output, durationMs: 1250 }),
      },
      running
    )
  )
}

function row(result: ReturnType<typeof view>) {
  return [
    result.verb,
    result.target?.text,
    ...result.chips.map((chip) => chip.label),
  ]
    .filter(Boolean)
    .join(" ")
}

test("large command feedback retains command outcome and terminal text in multipart results", () => {
  const output = { status: "ok", data: { command: "npm test", exitCode: 1, output: "failure diagnostic\n".repeat(700) } }
  const encoded = encodeToolResult(output)
  assert.ok(Array.isArray(encoded))
  assert.deepEqual(view("run_task", { kind: "project", task: "test" }, encoded), view("run_task", { kind: "project", task: "test" }, output))
  // Transcripts from earlier versions carry the first envelope format.
  const earlier = [
    { type: "text", text: JSON.stringify({ format: "blame_tool_result_v1", result: { ...output, data: { ...output.data, output: null } }, textFields: [["data", "output"]] }) },
    { type: "text", text: output.data.output },
  ]
  assert.deepEqual(view("run_task", { kind: "project", task: "test" }, earlier), view("run_task", { kind: "project", task: "test" }, output))
})

test("edits name the file and its line counts", () => {
  const result = view(
    "edit_code",
    {
      operations: [
        {
          kind: "patch",
          patch:
            "*** Begin Patch\n*** Update File: src/sync-service.ts\n@@\n-      this.backoff *= 2\n+      this.backoff = Math.min(this.backoff * 2, 1600)\n*** End Patch",
        },
      ],
    },
    {
      status: "ok",
      data: {
        changed: true,
        changes: [
          {
            path: "src/sync-service.ts",
            additions: 1,
            deletions: 1,
            symbols: ["SyncService.retry"],
          },
        ],
        parse: { status: "passed" },
      },
    }
  )
  assert.equal(row(result), "Edited sync-service.ts +1 −1 in SyncService.retry")
  const diff = result.bodies.find((body) => body.type === "diff")
  assert.ok(diff && diff.type === "diff")
  assert.deepEqual(
    diff.files[0]!.lines.map((line) => line.kind),
    ["hunk", "remove", "add"]
  )
})

test("new files read as created", () => {
  const result = view(
    "edit_code",
    {
      operations: [
        {
          kind: "patch",
          path: "src/sync-service.test.ts",
          patch: "import test from 'node:test'\ntest('x', () => {})\n",
        },
      ],
    },
    {
      status: "ok",
      data: {
        changes: [
          { path: "src/sync-service.test.ts", additions: 2, deletions: 0 },
        ],
      },
    }
  )
  assert.equal(row(result), "Created sync-service.test.ts +2")
})

test("commands show the command line and how they ended", () => {
  assert.equal(
    row(
      view(
        "run_task",
        { kind: "command", command: "echo hello && ls src" },
        {
          status: "ok",
          data: {
            command: "echo hello && ls src",
            exitCode: 0,
            output: "hello",
          },
        }
      )
    ),
    "Ran echo hello && ls src Done 1.3 s"
  )
  const failed = view(
    "run_task",
    { kind: "command", command: 'node -e "process.exit(3)"' },
    {
      status: "blocked",
      category: "command",
      message: "Command exited with code 3.",
      recovery: "Inspect the command output.",
    }
  )
  assert.equal(failed.failed, true)
  assert.equal(failed.chips[0]!.label, "Exit 3")
  assert.equal(failed.bodies[0]!.type, "error")
})

test("a check that waited for a turn says how long", () => {
  const result = view(
    "run_task",
    { kind: "command", command: "npm run build" },
    {
      status: "ok",
      data: {
        command: "npm run build",
        exitCode: 0,
        output: "built",
        waitedForTurn: { seconds: 42, behind: "another agent's build or tests" },
      },
    }
  )
  assert.deepEqual(
    result.chips.map((chip) => chip.label),
    ["Done", "1.3 s", "Waited 42 s"]
  )
  assert.match(result.chips[2]!.title ?? "", /another agent's build or tests/)
})

test("test runs surface their counts", () => {
  const result = view(
    "run_task",
    { kind: "project", task: "test" },
    {
      status: "ok",
      data: {
        command: "npm run test",
        exitCode: 0,
        output: "# pass 1",
        check: {
          outcome: "passed",
          counts: { executed: 1, passed: 1, failed: 0, skipped: 0 },
        },
      },
    }
  )
  assert.equal(result.family, "test")
  assert.equal(row(result), "Ran test 1 passed 1.3 s")
})

test("searches show the query and the number of results", () => {
  const result = view(
    "search_code",
    { query: "backoff", scope: "src" },
    {
      status: "ok",
      data: {
        results: [
          {
            path: "src/sync-service.ts",
            lines: [1, 11],
            kind: "class",
            qualifiedName: "SyncService",
            signature: "class SyncService",
          },
          {
            path: "src/sync-service.ts",
            lines: [4, 10],
            kind: "method",
            qualifiedName: "SyncService.retry",
          },
        ],
        candidateCount: 3,
      },
    }
  )
  assert.equal(row(result), 'Searched for "backoff" 3 results in src')
  const hits = result.bodies[0]
  assert.ok(hits && hits.type === "search")
  assert.equal(hits.hits[1]!.line, 4)
  assert.equal(hits.more, 1)
})

test("reads name the file, symbol or range", () => {
  assert.equal(
    row(
      view(
        "read_code",
        { target: "src/sync-service.ts" },
        {
          status: "ok",
          data: {
            path: "src/sync-service.ts",
            view: "raw",
            complete: true,
            content: "a\nb\nc\n",
          },
        }
      )
    ),
    "Read sync-service.ts 3 lines"
  )
  assert.equal(
    row(
      view(
        "read_code",
        { target: "src/sync-service.ts#SyncService.retry", view: "symbol" },
        {
          status: "ok",
          data: {
            path: "src/sync-service.ts",
            view: "symbol",
            qualifiedName: "SyncService.retry",
            body: "{}",
          },
        }
      )
    ),
    "Read SyncService.retry sync-service.ts"
  )
  assert.equal(
    row(
      view(
        "read_code",
        { target: "src" },
        {
          status: "ok",
          data: {
            entries: [{ kind: "file", target: "src/a.ts" }],
            path: "src",
            view: "directory",
            candidateCount: 1,
          },
        }
      )
    ),
    "Listed src/ 1 entry"
  )
})

test("running tools use the present tense", () => {
  assert.equal(
    view("run_task", { kind: "command", command: "pnpm test" }, undefined, true)
      .verb,
    "Running"
  )
  assert.equal(
    view("search_code", { query: "x" }, undefined, true).verb,
    "Searching for"
  )
})

test("unknown tools and broken payloads fall back gracefully", () => {
  assert.equal(
    row(view("custom_tool", { url: "https://x.dev" })),
    "Custom tool https://x.dev"
  )
  const broken = describeToolCall(
    toolCallSource(
      {
        kind: "tool",
        title: "Edited files",
        toolName: "edit_code",
        detail: '{"toolName": "edit_c',
      },
      false
    )
  )
  assert.equal(broken.verb, "Edited")
})

const screenshotId = "e".repeat(64)
const screenshotOutput = [
  { type: "text", text: "Took a screenshot of the current page's viewport." },
  {
    type: "screenshot_ref",
    id: screenshotId,
    mimeType: "image/png",
    width: 1440,
    height: 900,
    pageUrl: "http://127.0.0.1:5173/settings/providers?tab=cloud",
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
    sessionId: "session-1",
  },
  {
    type: "text",
    text: `Screenshot saved as screenshot:${screenshotId} (1440×900, dark).`,
  },
]

test("a screenshot names the page, its size and theme, and shows the capture", () => {
  const result = view(
    "preview_devtools__take_screenshot",
    { format: "png" },
    screenshotOutput
  )
  assert.equal(
    row(result),
    "Captured /settings/providers?tab=cloud 1440×900 dark"
  )
  assert.equal(result.target?.mono, true)
  assert.equal(result.failed, false)
  assert.deepEqual(result.bodies, [
    {
      type: "screenshot",
      screenshots: [
        {
          colorScheme: "dark",
          height: 900,
          id: screenshotId,
          mimeType: "image/png",
          pageUrl: "http://127.0.0.1:5173/settings/providers?tab=cloud",
          sessionId: "session-1",
          viewport: { height: 900, width: 1440 },
          width: 1440,
        },
      ],
    },
  ])
})

test("a running screenshot shows a pending capture", () => {
  const result = view("preview_devtools__take_screenshot", {}, undefined, true)
  assert.equal(row(result), "Capturing the preview")
  assert.deepEqual(result.bodies, [
    { type: "screenshot", screenshots: [], pending: true },
  ])
})

test("a failed screenshot shows its error and no capture", () => {
  const result = view(
    "preview_devtools__take_screenshot",
    {},
    {
      content: [{ type: "text", text: "Protocol error: Target closed" }],
      isError: true,
    }
  )
  assert.equal(result.failed, true)
  assert.deepEqual(result.bodies, [
    { type: "error", message: "Protocol error: Target closed" },
  ])
})

test("a screenshot without metadata still reads as a sentence", () => {
  const result = view(
    "preview_devtools__take_screenshot",
    { target: "@e4" },
    {
      content: [{ type: "text", text: "Screenshot taken." }],
    }
  )
  assert.equal(row(result), "Captured @e4")
  assert.deepEqual(result.bodies, [])
})

test("common browser tools read as sentences", () => {
  assert.equal(
    row(view("preview_devtools__take_snapshot", {}, { content: [] })),
    "Read the page structure"
  )
  assert.equal(
    row(
      view("preview_devtools__take_snapshot", { mode: "text" }, { content: [] })
    ),
    "Read the page text"
  )
  assert.equal(
    row(view("preview_devtools__click", { target: "@e23" }, { content: [] })),
    "Clicked @e23"
  )
  assert.equal(
    row(
      view(
        "preview_devtools__fill",
        { target: "#email", value: "hello@blame.so" },
        { content: [] }
      )
    ),
    "Filled #email “hello@blame.so”"
  )
  assert.equal(
    row(
      view(
        "preview_devtools__navigate_page",
        { type: "url", url: "http://127.0.0.1:5173/board" },
        { content: [] }
      )
    ),
    "Opened /board"
  )
  assert.equal(
    row(
      view(
        "preview_devtools__navigate_page",
        { type: "reload" },
        { content: [] }
      )
    ),
    "Reloaded the page"
  )
  assert.equal(
    row(
      view(
        "preview_devtools__emulate",
        { colorScheme: "dark", viewport: { width: 941, height: 620 } },
        { content: [] }
      )
    ),
    "Emulated a 941×620 viewport, dark mode"
  )
  assert.equal(
    row(
      view(
        "preview_devtools__emulate",
        { device: "iPhone 16", offline: true },
        { content: [] }
      )
    ),
    "Emulated iPhone 16, offline"
  )
  assert.equal(
    row(
      view(
        "preview_devtools__list_console_messages",
        {},
        {
          content: [
            {
              type: "text",
              text: "[log] ready\n[page error] Error: boom",
            },
          ],
        }
      )
    ),
    "Read console messages 1 error"
  )
  assert.equal(
    row(view("preview_devtools__hover", { target: "@e2" }, { content: [] })),
    "Hover @e2"
  )
})

test("a component preview names its file, counts its renders and flags errors", () => {
  const second = { ...screenshotOutput[1], id: "f".repeat(64), colorScheme: "light" }
  const result = view(
    "open_component_preview",
    {
      file: "packages/app/src/dialog.blame-preview.tsx",
      states: ["default", "empty"],
      themes: ["dark"],
    },
    [
      {
        type: "text",
        text: "Started a Vite 8.3.6 server in the story's workspace for packages/app, at http://127.0.0.1:41234. 2 renders of packages/app/src/dialog.blame-preview.tsx:",
      },
      {
        type: "text",
        text: "Render 1/2 — default, dark, 1440 px: rendered.\nError overlay: none.\nConsole errors: none.",
      },
      ...screenshotOutput,
      {
        type: "text",
        text: "Render 2/2 — empty, dark, 1440 px: rendered.\nError overlay: none.\nConsole errors:\n- Warning: Each child in a list should have a unique key",
      },
      second,
    ]
  )
  assert.equal(row(result), "Previewed dialog.blame-preview.tsx 1440×900 dark 2 renders Errors")
  assert.equal(result.target?.title, "packages/app/src/dialog.blame-preview.tsx")
  const shots = result.bodies[0]
  assert.ok(shots.type === "screenshot")
  assert.equal(shots.screenshots.length, 2)
  assert.deepEqual(result.bodies[1], {
    type: "text",
    text: "Render 1/2 — default, dark, 1440 px: rendered.\nError overlay: none.\nConsole errors: none.\nRender 2/2 — empty, dark, 1440 px: rendered.\nError overlay: none.\nConsole errors:\n- Warning: Each child in a list should have a unique key",
  })
  const clean = view(
    "open_component_preview",
    { file: "dialog.blame-preview.tsx" },
    [
      {
        type: "text",
        text: "Render 1/1 — default, light, 1280 px: rendered.\nError overlay: none.\nConsole errors: none.",
      },
      ...screenshotOutput,
    ]
  )
  assert.ok(!clean.chips.some((chip) => chip.label === "Errors"))
})

test("story history lookups name the search and the story read", () => {
  assert.equal(
    row(view("search_user_stories", { query: "login redirect" }, "2 of 2…")),
    "Searched stories “login redirect”"
  )
  assert.equal(
    row(view("search_user_stories", {}, undefined, true)),
    "Searching stories recent"
  )
  assert.equal(
    row(view("read_user_story", { story: "us-012", include: ["files"] })),
    "Read story US-012 files"
  )
})

test("a grep answered by search_code shows the search hits with their matching lines", () => {
  const result = view("run_task", { kind: "command", command: 'grep -rn "selectLines" src' }, {
    status: "ok",
    data: {
      command: 'grep -rn "selectLines" src',
      servedBy: "search_code",
      mode: "regex",
      results: [{ alias: "s3", path: "src/view.ts", lines: [1, 3], kind: "function", qualifiedName: "view", reason: "lexical_symbol", matchLine: 2, snippet: "  return selectLines();" }],
      candidateCount: 1,
    },
  })
  assert.match(row(result), /^Ran grep -rn "selectLines" src via search_code \/ read_code 1\.3/u)
  assert.equal(result.failed, false)
  assert.deepEqual(result.bodies, [{ type: "search", more: 0, hits: [{ path: "src/view.ts", line: 2, kind: "function", name: "view", snippet: "  return selectLines();" }] }])
})

test("a grep that matched nothing is not shown as a failure", () => {
  const result = view("run_task", { kind: "command", command: "grep -c missing notes.txt | sort" }, {
    status: "ok",
    data: { command: "grep -c missing notes.txt | sort", exitCode: 1, noMatch: true, output: "0" },
  })
  assert.match(row(result), /^Ran grep -c missing notes\.txt \| sort No match 1\.3/u)
  assert.equal(result.failed, false)
})

test("blame_configure shows the exact command, URL or source while it waits for approval", () => {
  const add = view("blame_configure", {
    action: "add_mcp",
    name: "notes",
    command: "npx",
    args: ["-y", "notes-mcp"],
    env: ["NOTES_KEY"],
  }, undefined, true)
  assert.equal(row(add), "Adding MCP server notes: npx -y notes-mcp needs variables")
  assert.deepEqual(add.bodies[0], {
    type: "fields",
    fields: [
      { label: "Runs", value: "npx -y notes-mcp", mono: true },
      { label: "You fill in", value: "NOTES_KEY", mono: true },
    ],
  })
  const remote = view("blame_configure", { action: "add_mcp", name: "docs", url: "https://mcp.example.com/mcp" }, undefined, true)
  assert.match(remote.target!.text, /docs: https:\/\/mcp\.example\.com\/mcp/)
  const skill = view(
    "blame_configure",
    { action: "install_skill", source: "o/r/skills/pdf" },
    { installed: "pdf", files: 3, path: "/h/.agents/skills/pdf", scripts: ["run.sh"] },
  )
  assert.equal(row(skill), "Installed skill o/r/skills/pdf pdf")
  assert.deepEqual(skill.bodies.at(-1), { type: "list", label: "Scripts, copied and never run", items: ["run.sh"] })
  assert.equal(view("blame_configure", { action: "remove_mcp", name: "notes" }, { removed: "notes" }).verb, "Removed MCP server")
  assert.equal(view("blame_configure", { action: "add_mcp", name: "x" }, { outcome: "failed", error: "No." }).failed, true)
})

test("blame_repair reads as a repair with before, after and a hand-over button", () => {
  const fixed = view("blame_repair", { action: "restart_preview" }, {
    outcome: "fixed",
    before: { status: "failed" },
    after: { status: "ready" },
    next: "The preview is ready.",
  })
  assert.equal(row(fixed), "Restarted the preview Fixed")
  assert.equal(fixed.chips[0]!.tone, "success")
  const failing = view("blame_repair", { action: "reconnect_mcp", name: "notes" }, {
    outcome: "still_failing",
    before: { state: "failed" },
    after: { state: "failed" },
    logExcerpt: ["boom"],
  })
  assert.equal(row(failing), "Reconnected MCP server notes Still failing")
  assert.equal(failing.chips[0]!.tone, "danger")
  const handOver = view("blame_repair", { action: "hand_over", where: "mcp", why: "authorize Linear" }, {
    handedOver: true,
    where: "Settings → MCP Servers",
  })
  assert.equal(row(handOver), "Asked you to authorize Linear Settings → MCP Servers")
  assert.deepEqual(handOver.bodies[0], { type: "settings-link", section: "mcp" })
})

test("blame_inspect reads as a check of one area", () => {
  const overview = view("blame_inspect", { area: "overview" }, {
    summary: "1 area to look at: mcp",
    areas: [{ area: "mcp", status: "problem", summary: "1 server, 1 to fix" }],
    next: "blame_inspect area=mcp",
  })
  assert.equal(row(overview), "Checked Blame's state 1 area to look at: mcp")
  assert.equal(overview.chips[0]!.tone, "danger")
  const logs = view("blame_inspect", { area: "logs", search: "boom" }, { source: "app", lines: ["a", "b"] })
  assert.equal(row(logs), 'Checked Blame\'s logs for "boom" app')
  assert.deepEqual(logs.bodies[0], { type: "terminal", output: "a\nb" })
  const refused = view("blame_inspect", { area: "skills", source: "o/r" }, { candidate: null, refused: "No SKILL.md" })
  assert.deepEqual(refused.bodies[0], { type: "error", message: "No SKILL.md" })
})
