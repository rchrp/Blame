import assert from "node:assert/strict";
import test from "node:test";

import {
  dependencyWait,
  initializationDecision,
  queuedStories,
  runtimeWait,
} from "./queue.js";
import { storySessionSettings, storyTurnModel } from "./settings.js";
import {
  parseStory,
  storyLocation,
  storyMessage,
  storyOutcomeUpdate,
  withAgentModel,
  withTurnCounts,
  type HostStory,
} from "./story.js";

const inProgress = { status: "in-progress" as const };

function story(fields: Partial<HostStory> & { id: string }): HostStory {
  return parseStory({
    projectId: "project",
    storyNumber: 1,
    title: fields.id,
    summary: "",
    status: "ready",
    createdAt: "2026-11-21T10:00:00.000Z",
    ...fields,
  });
}

test("a local-container worktree is in the VM except on Linux", () => {
  assert.equal(storyLocation("local-container", "darwin"), "vm");
  assert.equal(storyLocation("local-container", "win32"), "vm");
  assert.equal(storyLocation("local-container", "linux"), "host");
  assert.equal(storyLocation("direct", "darwin"), "host");
  assert.equal(storyLocation("cloud-mirror", "darwin"), "host");
});

test("the models list keeps each choice once, the latest last", () => {
  const a = { providerId: "anthropic", modelId: "a", reasoningEffort: null };
  const b = { providerId: "openai", modelId: "b", reasoningEffort: "high" };
  assert.deepEqual(withAgentModel([a, b], a), [b, a]);
  assert.deepEqual(withAgentModel(undefined, a), [a]);
  const many = Array.from({ length: 20 }, (_, index) => ({
    providerId: "p",
    modelId: `m${index}`,
  }));
  assert.equal(withAgentModel(many, a).length, 16);
});

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
    ],
    [{ id: "f", name: "shot.png", type: "image/png" }],
    async () => "aGk=",
  );
  assert.equal(
    message.text,
    "Fix it\n\nsrc/a.ts, lines 2-3:\n\n```\nconst a = 1\n```\n\nBuilds on #4: Checkout",
  );
  assert.deepEqual(message.attachments, [
    { data: "aGk=", mediaType: "image/png", name: "shot.png" },
  ]);
});

test("a finished turn sends the story to review", () => {
  assert.deepEqual(
    storyOutcomeUpdate(inProgress, { status: "completed" } as never),
    { agentStatus: null, status: "in-review" },
  );
});

test("a failed turn pauses the story with the reason", () => {
  const outcome = {
    status: "failed",
    error: { kind: "overloaded", message: "The provider is overloaded." },
  };
  assert.deepEqual(storyOutcomeUpdate(inProgress, outcome as never), {
    agentLastError: "The provider is overloaded.",
    agentStatus: "Paused",
  });
});

test("an interrupted turn pauses the story; outside development only the flag clears", () => {
  const interrupted = { status: "interrupted" } as never;
  assert.deepEqual(storyOutcomeUpdate(inProgress, interrupted), {
    agentStatus: "Paused",
  });
  assert.deepEqual(storyOutcomeUpdate({ status: "in-review" }, interrupted), {
    agentStatus: null,
  });
});

test("a turn the agent did not finish pauses the story with why", () => {
  const outcome = {
    status: "contract_unmet",
    unmet: [{ kind: "result", tool: "finish_task" }],
  };
  assert.deepEqual(storyOutcomeUpdate(inProgress, outcome as never), {
    agentLastError:
      "The agent stopped without finishing: its work was not checked with finish_task.",
    agentStatus: "Paused",
  });
});

test("a reply the checks refused sends the story to review; a turn that never finished pauses it", () => {
  const refused = {
    status: "contract_unmet",
    unmet: [{ kind: "result", tool: "finish_task" }],
    refused: { kind: "failing_checks", tasks: ["test:gpu"] },
  };
  assert.deepEqual(storyOutcomeUpdate(inProgress, refused as never), {
    agentStatus: null,
    status: "in-review",
  });
  const { refused: _, ...stopped } = refused;
  void _;
  assert.deepEqual(storyOutcomeUpdate(inProgress, stopped as never), {
    agentStatus: "Paused",
    agentLastError:
      "The agent stopped without finishing: its work was not checked with finish_task.",
  });
});

test("each model of a story carries the turns the records count for it", () => {
  const models = [
    {
      providerId: "anthropic",
      modelId: "claude-opus",
      reasoningEffort: "high",
    },
    { providerId: "anthropic", modelId: "claude-opus", reasoningEffort: "low" },
    { providerId: "openai", modelId: "gpt-large", turns: 4 },
  ];
  // After a model change and a rewind: opus 2 turns, gpt 1, and a third model.
  const counted = withTurnCounts(models, [
    { providerId: "anthropic", modelId: "claude-opus", turns: 2 },
    { providerId: "openai", modelId: "gpt-large", turns: 1 },
    { providerId: "gemini", modelId: "gemini-pro", turns: 1 },
  ]);
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
  ]);
  assert.equal(
    withTurnCounts(counted, [
      { providerId: "anthropic", modelId: "claude-opus", turns: 2 },
      { providerId: "openai", modelId: "gpt-large", turns: 1 },
      { providerId: "gemini", modelId: "gemini-pro", turns: 1 },
    ]),
    undefined,
    "nothing changed",
  );
  // A model whose turns were all undone keeps its entry, without a count.
  assert.deepEqual(
    withTurnCounts(
      [{ providerId: "openai", modelId: "gpt-large", turns: 1 }],
      [],
    ),
    [{ providerId: "openai", modelId: "gpt-large" }],
  );
});

test("queued stories start oldest first, once their files are uploaded", () => {
  const stories = [
    story({ id: "late", createdAt: "2026-11-21T12:00:00.000Z" }),
    story({ id: "early", createdAt: "2026-11-21T09:00:00.000Z" }),
    story({ id: "uploading", fileAttachmentUploadPending: true }),
    story({ id: "draft", status: "backlog" }),
  ];
  assert.deepEqual(
    queuedStories(stories).map(({ id }) => id),
    ["early", "late"],
  );
});

test("a story starts after the stories it names are done, never after a dropped one", () => {
  const project = [
    { id: "a", status: "done" as const },
    { id: "b", status: "in-review" as const },
    { id: "c", status: "discarded" as const },
  ];
  assert.equal(
    dependencyWait({ id: "x", startsAfter: [] }, project),
    undefined,
  );
  assert.equal(
    dependencyWait({ id: "x", startsAfter: ["a"] }, project),
    undefined,
  );
  assert.deepEqual(
    dependencyWait({ id: "x", startsAfter: ["a", "b"] }, project),
    {
      kind: "dependencies",
      storyIds: ["b"],
    },
  );
  assert.deepEqual(
    dependencyWait({ id: "x", startsAfter: ["b", "c"] }, project),
    {
      kind: "dependency-dropped",
      storyIds: ["c"],
    },
  );
  assert.deepEqual(
    dependencyWait({ id: "x", startsAfter: ["gone"] }, project),
    {
      kind: "dependency-dropped",
      storyIds: ["gone"],
    },
  );
  // A field the API does not send yet reads as empty.
  assert.equal(dependencyWait({ id: "x" }, project), undefined);
});

test("a story waits while the preview environment is prepared, else runs Direct", () => {
  const now = Date.parse("2026-11-21T10:10:00.000Z");
  const running = {
    status: "running",
    previewManifest: null,
    runConfigurations: [],
    createdAt: "2026-11-21T10:00:00.000Z",
    updatedAt: "2026-11-21T10:05:00.000Z",
  };
  assert.equal(initializationDecision(running, "local-container", now), "wait");
  assert.equal(initializationDecision(running, "direct", now), "start");
  assert.equal(
    initializationDecision(running, "local-container", now + 60 * 60_000),
    "run-direct",
  );
  assert.equal(
    initializationDecision(null, "vercel-compose", now),
    "run-direct",
  );
  assert.equal(
    initializationDecision(
      { ...running, status: "done", previewManifest: {} as never },
      "local-container",
      now,
    ),
    "start",
  );
});

test("only Local Container stories wait for the Blame Runtime", () => {
  assert.equal(runtimeWait("direct", "missing"), undefined);
  assert.equal(runtimeWait("local-container", "ready"), undefined);
  assert.deepEqual(runtimeWait("local-container", "stopped"), {
    kind: "runtime",
    phase: "stopped",
  });
  assert.deepEqual(runtimeWait("local-container", "missing"), {
    kind: "needs-runtime",
    phase: "missing",
  });
});

test("a story's first run uses the model it asked for, then keeps its last one", () => {
  const preferences = {
    agentModel: {
      providerId: "anthropic",
      modelId: "default",
      maxInputTokens: 150_000,
    },
    runMode: "direct" as const,
    premium: false,
    runtimePhase: "ready",
    contextLimits: { asked: 200_000 },
  };
  const asked = story({
    id: "asked",
    requestedModel: {
      providerId: "openai",
      modelId: "gpt",
      reasoningEffort: "high",
    },
  });
  assert.deepEqual(storyTurnModel(asked, preferences, undefined, true), {
    model: { providerId: "openai", modelId: "gpt", reasoning: "high" },
    maxContextTokens: 200_000,
  });
  const plain = story({ id: "plain" });
  assert.deepEqual(storyTurnModel(plain, preferences, undefined, true), {
    model: { providerId: "anthropic", modelId: "default" },
  });
  const worked = story({
    id: "worked",
    agentModels: [
      { providerId: "openai", modelId: "gpt", reasoningEffort: "low" },
    ],
  });
  assert.deepEqual(storyTurnModel(worked, preferences, undefined, false), {
    model: { providerId: "openai", modelId: "gpt", reasoning: "low" },
  });
  assert.equal(storyTurnModel(plain, undefined, undefined, true), undefined);
});

test("a story's settings name its worktree, where it is and its preview", () => {
  const settings = storySessionSettings({
    story: story({
      id: "story",
      worktree: "/worktrees/story",
      workspaceMode: "direct",
    }),
    projectPath: "/project",
    snapshot: {
      initialization: {
        status: "done",
        previewManifest: {} as never,
        runConfigurations: [
          {
            id: "web",
            default: true,
            previewUrl: "http://localhost:3000",
          } as never,
        ],
        createdAt: "",
        updatedAt: null,
      },
      practices: [{ practice: "unit_tests", enabled: true }],
    },
    model: { providerId: "anthropic", modelId: "a" },
  });
  assert.deepEqual(settings.settings.workspace, {
    root: "/worktrees/story",
    location: "host",
  });
  assert.equal(settings.settings.previewDevtoolsScope, "runner:/project:web");
  assert.deepEqual(
    settings.settings.codePractices?.map(({ practice, enabled }) => [
      practice,
      enabled,
    ]),
    [
      ["coding_style", true],
      ["unit_tests", true],
      ["layered_architecture", false],
      ["commit_message_convention", false],
    ],
  );
  assert.throws(() =>
    storySessionSettings({
      story: story({ id: "s" }),
      projectPath: "/project",
      snapshot: { initialization: null, practices: [] },
      model: { providerId: "anthropic", modelId: "a" },
    }),
  );
});
