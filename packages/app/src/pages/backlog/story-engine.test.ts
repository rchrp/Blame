import assert from "node:assert/strict"
import test from "node:test"

import {
  storyLocation,
  storyMessage,
  storyOutcomeUpdate,
  storySessionSettings,
  withAgentModel,
  withTurnCounts,
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

test("a turn the agent did not finish pauses the story with why", () => {
  const outcome = {
    status: "contract_unmet",
    unmet: [{ kind: "result", tool: "finish_task" }],
  }
  assert.deepEqual(storyOutcomeUpdate(inProgress, outcome as never), {
    agentLastError:
      "The agent stopped without finishing: its work was not checked with finish_task.",
    agentStatus: "Paused",
  })
})

test("a reply the checks refused sends the story to review; a turn that never finished pauses it", () => {
  const refused = {
    status: "contract_unmet",
    unmet: [{ kind: "result", tool: "finish_task" }],
    refused: { kind: "failing_checks", tasks: ["test:gpu"] },
  }
  assert.deepEqual(storyOutcomeUpdate(inProgress, refused as never), {
    agentStatus: null,
    status: "in-review",
  })
  const { refused: _, ...stopped } = refused
  void _
  assert.deepEqual(storyOutcomeUpdate(inProgress, stopped as never), {
    agentStatus: "Paused",
    agentLastError:
      "The agent stopped without finishing: its work was not checked with finish_task.",
  })
})

test("each model of a story carries the turns the records count for it", () => {
  const models = [
    {
      providerId: "anthropic",
      modelId: "claude-opus",
      reasoningEffort: "high",
    },
    { providerId: "anthropic", modelId: "claude-opus", reasoningEffort: "low" },
    { providerId: "openai", modelId: "gpt-large", turns: 4 },
  ]
  // After a model change and a rewind: opus 2 turns, gpt 1, and a third model.
  const counted = withTurnCounts(models, [
    { providerId: "anthropic", modelId: "claude-opus", turns: 2 },
    { providerId: "openai", modelId: "gpt-large", turns: 1 },
    { providerId: "gemini", modelId: "gemini-pro", turns: 1 },
  ])
  assert.deepEqual(counted, [
    {
      providerId: "anthropic",
      modelId: "claude-opus",
      reasoningEffort: "high",
      turns: 2,
    },
    {
      providerId: "anthropic",
      modelId: "claude-opus",
      reasoningEffort: "low",
      turns: 2,
    },
    { providerId: "openai", modelId: "gpt-large", turns: 1 },
    { providerId: "gemini", modelId: "gemini-pro", turns: 1 },
  ])
  assert.equal(
    withTurnCounts(counted, [
      { providerId: "anthropic", modelId: "claude-opus", turns: 2 },
      { providerId: "openai", modelId: "gpt-large", turns: 1 },
      { providerId: "gemini", modelId: "gemini-pro", turns: 1 },
    ]),
    undefined,
    "nothing changed"
  )
  // A model whose turns were all undone keeps its entry, without a count.
  assert.deepEqual(
    withTurnCounts(
      [{ providerId: "openai", modelId: "gpt-large", turns: 1 }],
      []
    ),
    [{ providerId: "openai", modelId: "gpt-large" }]
  )
})
