import assert from "node:assert/strict"
import test from "node:test"

import { describeToolCall, toolCallSource } from "./describe-tool-call.ts"

// Payloads below are real outputs captured from the Blame harness and the
// shapes produced by Cline built-in tools.
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
  assert.equal(
    row(
      view(
        "read_files",
        { files: [{ path: "src/a.ts", start_line: 4, end_line: 10 }] },
        [{ query: "src/a.ts", result: "code", success: true }]
      )
    ),
    "Read a.ts L4–10"
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

test("Cline patches and commands get the same treatment", () => {
  const patch = view(
    "apply_patch",
    {
      input:
        "*** Begin Patch\n*** Add File: notes.md\n+# Notes\n+hello\n*** End Patch",
    },
    [
      {
        query: "apply_patch",
        result: "Successfully applied patch to the following files:\nnotes.md",
        success: true,
      },
    ]
  )
  assert.equal(row(patch), "Created notes.md +2")
  assert.equal(
    row(
      view("run_commands", { commands: ["ls"] }, [
        { query: "ls", result: "a\nb", success: true },
      ])
    ),
    "Ran ls Done 1.3 s"
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
    { uid: "1_4" },
    {
      content: [{ type: "text", text: "Took a screenshot." }],
    }
  )
  assert.equal(row(result), "Captured element 1_4")
  assert.deepEqual(result.bodies, [])
})

test("common browser tools read as sentences", () => {
  assert.equal(
    row(view("preview_devtools__take_snapshot", {}, { content: [] })),
    "Read the page structure"
  )
  assert.equal(
    row(view("preview_devtools__click", { uid: "1_23" }, { content: [] })),
    "Clicked element 1_23"
  )
  assert.equal(
    row(
      view(
        "preview_devtools__fill",
        { uid: "1_8", value: "hello@blame.so" },
        { content: [] }
      )
    ),
    "Filled element 1_8 “hello@blame.so”"
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
        { colorScheme: "dark", viewport: "390x844x3,mobile,touch" },
        { content: [] }
      )
    ),
    "Emulated dark mode, a 390×844 mobile viewport"
  )
  assert.equal(
    row(
      view(
        "preview_devtools__resize_page",
        { width: 941, height: 620 },
        { content: [] }
      )
    ),
    "Resized the page to 941×620"
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
              text: "## Console messages\nmsgid=1 [log] ready\nmsgid=2 [error] boom",
            },
          ],
        }
      )
    ),
    "Read console messages 1 error"
  )
  assert.equal(
    row(view("preview_devtools__hover", { uid: "1_2" }, { content: [] })),
    "Hover element 1_2"
  )
})

test("a component preview names its page and flags errors", () => {
  const result = view(
    "open_component_preview",
    { path: "/dialog.blame-preview.html?state=empty", colorScheme: "dark" },
    [
      {
        type: "text",
        text: "Opened /dialog.blame-preview.html?state=empty (dark).\nError overlay: none.\nConsole errors:\nmsgid=4 [error] Missing key prop",
      },
      ...screenshotOutput,
    ]
  )
  assert.equal(row(result), "Previewed /dialog.blame-preview.html?state=empty 1440×900 dark Errors")
  assert.equal(result.bodies[0].type, "screenshot")
  assert.deepEqual(result.bodies[1], {
    type: "text",
    text: "Error overlay: none.\nConsole errors:\nmsgid=4 [error] Missing key prop",
  })
})
