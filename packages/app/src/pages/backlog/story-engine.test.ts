import assert from "node:assert/strict"
import test from "node:test"

import { storyLocation, storyMessage } from "./story-engine.ts"

test("a local-container worktree is in the VM except on Linux", () => {
  assert.equal(storyLocation("local-container", "darwin"), "vm")
  assert.equal(storyLocation("local-container", "win32"), "vm")
  assert.equal(storyLocation("local-container", "linux"), "host")
  assert.equal(storyLocation("direct", "darwin"), "host")
  assert.equal(storyLocation("cloud-preview", "darwin"), "host")
})

test("a message carries quoted code, earlier stories and attached files", async () => {
  const message = await storyMessage(
    " Fix it ",
    [
      { content: "const a = 1", endLine: 3, path: "src/a.ts", startLine: 2 },
      {
        content: "Checkout",
        endLine: 1,
        origin: "story",
        path: "#4",
        startLine: 1,
      },
    ] as never,
    [{ id: "f", name: "shot.png", type: "image/png" }] as never,
    async () => "aGk="
  )
  assert.equal(
    message.text,
    "Fix it\n\nsrc/a.ts, lines 2-3:\n\n```\nconst a = 1\n```\n\nBuilds on #4: Checkout"
  )
  assert.deepEqual(message.attachments, [
    { data: "aGk=", mediaType: "image/png", name: "shot.png" },
  ])
})
