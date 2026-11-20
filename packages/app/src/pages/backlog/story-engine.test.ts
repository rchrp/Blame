import assert from "node:assert/strict"
import test from "node:test"

import {
  storyLocation,
  storyMessage,
  storyOutcomeUpdate,
  storySessionSettings,
  withAgentModel,
} from "./story-engine.ts"

const inProgress = { status: "in-progress" as const }

test("a local-container worktree is in the VM except on Linux", () => {
  assert.equal(storyLocation("local-container", "darwin"), "vm")
  assert.equal(storyLocation("local-container", "win32"), "vm")
  assert.equal(storyLocation("local-container", "linux"), "host")
  assert.equal(storyLocation("direct", "darwin"), "host")
  assert.equal(storyLocation("cloud-preview", "darwin"), "host")
})

test("a finished turn sends the story to review", () => {
  assert.deepEqual(
    storyOutcomeUpdate(inProgress, { status: "completed" } as never),
    { agentStatus: null, status: "in-review" }
  )
})

test("a failed turn pauses the story with the reason", () => {
  const outcome = {
    status: "failed",
    error: { kind: "overloaded", message: "The provider is overloaded." },
  }
  assert.deepEqual(storyOutcomeUpdate(inProgress, outcome as never), {
    agentLastError: "The provider is overloaded.",
    agentStatus: "Paused",
  })
})

test("an interrupted turn pauses the story; outside development only the flag clears", () => {
  const interrupted = { status: "interrupted" } as never
  assert.deepEqual(storyOutcomeUpdate(inProgress, interrupted), {
    agentStatus: "Paused",
  })
  assert.deepEqual(storyOutcomeUpdate({ status: "in-review" }, interrupted), {
    agentStatus: null,
  })
})

test("the models list keeps each choice once, the latest last", () => {
  const a = { providerId: "anthropic", modelId: "a", reasoningEffort: null }
  const b = { providerId: "openai", modelId: "b", reasoningEffort: "high" }
  assert.deepEqual(withAgentModel([a, b], a), [b, a])
  assert.deepEqual(withAgentModel(undefined, a), [a])
  const many = Array.from({ length: 20 }, (_, index) => ({
    providerId: "p",
    modelId: `m${index}`,
  }))
  assert.equal(withAgentModel(many, a).length, 16)
})

test("a story's settings name its worktree, where it is and its preview", () => {
  const settings = storySessionSettings({
    story: {
      id: "story",
      projectId: "project",
      title: "Checkout",
      worktree: "/worktrees/story",
      workspaceMode: "local-container",
    },
    model: { providerId: "anthropic", modelId: "a" },
    platformName: "darwin",
    previewDevtoolsScope: "story",
  })
  assert.equal(settings.purpose, "development-story")
  assert.deepEqual(
    settings.purpose === "development-story" && settings.settings.workspace,
    { root: "/worktrees/story", location: "vm" }
  )
  assert.throws(() =>
    storySessionSettings({
      story: {
        id: "s",
        projectId: "p",
        title: "t",
        worktree: null,
        workspaceMode: null,
      },
      model: { providerId: "anthropic", modelId: "a" },
    })
  )
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
