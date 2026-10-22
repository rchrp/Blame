import assert from "node:assert/strict"
import test from "node:test"
import type { AgentScreenshotsClient } from "../context/platform.ts"
import {
  readAgentScreenshot,
  screenshotRefsInDetails,
  uploadActivityScreenshots,
} from "./agent-screenshot-sync.ts"

const id = "c".repeat(64)
const connection = { token: "token", url: "https://api.example/api/v1/" }
const detail = JSON.stringify({
  toolName: "preview_devtools__take_screenshot",
  output: [
    { type: "text", text: "Took a screenshot." },
    { type: "screenshot_ref", id, sessionId: "session-1", width: 1440 },
  ],
})

function client(local: boolean) {
  const cached: unknown[] = []
  const value: AgentScreenshotsClient = {
    cache: async (input) => {
      cached.push(input)
      return { ...input.metadata, id } as never
    },
    copy: async () => true,
    delete: async () => true,
    list: async () => [],
    saveAs: async () => true,
    read: async () =>
      local
        ? ({
            dataUrl: "data:image/png;base64,AAAA",
            metadata: { id, sessionId: "session-1" },
          } as never)
        : null,
  }
  return { cached, value }
}

function captureFetch(response: unknown) {
  const calls: Array<{ init?: RequestInit; url: string }> = []
  const original = globalThis.fetch
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ init, url: String(url) })
    return new Response(JSON.stringify(response), { status: 200 })
  }) as typeof fetch
  return { calls, restore: () => (globalThis.fetch = original) }
}

test("finds screenshot references in activity details", () => {
  assert.deepEqual(
    screenshotRefsInDetails([
      { detail },
      { detail: "not json screenshot_ref" },
      { detail: "{}" },
    ]),
    [{ id, sessionId: "session-1" }]
  )
})

test("uploads each referenced screenshot once per owner", async () => {
  const fetches = captureFetch({ id })
  try {
    const screenshots = client(true)
    const owner = { id: "story-1", kind: "userStory" as const }
    await uploadActivityScreenshots(
      connection,
      owner,
      [{ detail }],
      screenshots.value
    )
    await uploadActivityScreenshots(
      connection,
      owner,
      [{ detail }],
      screenshots.value
    )
    assert.equal(fetches.calls.length, 1)
    assert.equal(
      fetches.calls[0].url,
      `https://api.example/api/v1/projects/user-stories/story-1/agent-screenshots/${id}`
    )
    assert.equal(fetches.calls[0].init?.method, "PUT")
    assert.deepEqual(JSON.parse(String(fetches.calls[0].init?.body)), {
      content: "AAAA",
      mimeType: "image/png",
      sessionId: "session-1",
    })
  } finally {
    fetches.restore()
  }
})

test("another device fetches a missing screenshot and caches it", async () => {
  const fetches = captureFetch({ content: "AAAA", id, mimeType: "image/png" })
  try {
    const screenshots = client(false)
    const result = await readAgentScreenshot(
      { id, sessionId: "session-1" },
      {
        client: screenshots.value,
        connection,
        owner: { id: "chat-1", kind: "quickChat", scope: "runner:p:web" },
      }
    )
    assert.equal(result?.dataUrl, "data:image/png;base64,AAAA")
    assert.match(
      fetches.calls[0].url,
      /\/projects\/quick-chats\/chat-1\/agent-screenshots\/c{64}\?sessionId=session-1$/
    )
    assert.equal(screenshots.cached.length, 1)
    assert.equal(
      await readAgentScreenshot(
        { id: "../bad" },
        { client: screenshots.value }
      ),
      null
    )
  } finally {
    fetches.restore()
  }
})
