import assert from "node:assert/strict";
import test from "node:test";

import type { EngineHostMethod } from "../protocol.js";
import type { StoryHostEvent, StoryTurnEnded } from "../story-protocol.js";
import { StoryService } from "./service.js";

type Row = Record<string, unknown> & { id: string; projectId: string };

/** The account's API, in memory: stories, their PATCH and the project's environment. */
function fakeApi(rows: Row[]) {
  const stories = new Map(rows.map((row) => [row.id, { ...row }]));
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const { pathname, searchParams } = new URL(url);
    const path = pathname.replace(/^\/api\/v1/, "");
    const json = (value: unknown) =>
      new Response(JSON.stringify({ data: value }), { status: 200 });
    if (path === "/projects/user-stories" && init?.method !== "POST")
      return json(
        [...stories.values()].filter(
          (row) => row.projectId === searchParams.get("projectId"),
        ),
      );
    const story = /^\/projects\/user-stories\/([^/]+)$/.exec(path);
    if (story) {
      const row = stories.get(story[1]!);
      if (!row) return new Response("{}", { status: 404 });
      if (init?.method === "DELETE") {
        stories.delete(row.id);
        return new Response(null, { status: 204 });
      }
      if (init?.method === "PATCH")
        Object.assign(row, JSON.parse(String(init.body)), {
          updatedAt: new Date().toISOString(),
        });
      return json(row);
    }
    if (/^\/projects\/[^/]+\/initialization$/.test(path))
      return json({ initialization: null, practices: [] });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { stories, restore: () => (globalThis.fetch = original) };
}

function fakeHost() {
  const calls: Array<{ method: EngineHostMethod; input: unknown }> = [];
  const cleaned: string[] = [];
  const removed: string[] = [];
  const events: StoryHostEvent[] = [];
  const statuses = new Map<string, unknown>();
  const host = {
    api: () => ({ url: "http://api.test/api/v1", token: "token" }),
    call: async (method: EngineHostMethod, input: unknown) => {
      calls.push({ method, input });
      if (method === "createSession")
        return { session: (input as { session: string }).session, head: 0 };
      if (method === "send") return { turn: "turn", started: true };
      if (method === "approveAndMerge")
        return {
          baseCommit: "base",
          mergeCommit: "merge",
          push: { status: "skipped" },
          targetBranch: "main",
        };
      if (method === "status")
        return (input as { sessions: string[] }).sessions.map(
          (session) =>
            statuses.get(session) ?? {
              session,
              exists: true,
              running: false,
              turns: 1,
              models: [],
            },
        );
      return null;
    },
    desktop: {
      checkHostDependencies: async () => ({ ok: true }),
      gitIdentity: async () => ({ available: true, configured: true }),
      createStoryWorktree: async (input: { repositoryRoot: string }) => ({
        branch: "main",
        targetBranch: "main",
        workspaceMode: "direct" as const,
        worktree: input.repositoryRoot,
      }),
      git: async () => "abc123\n",
      prepareStoryTurn: async () => null,
      beginGitFlow: async () => ({
        inVm: false,
        activeWorktrees: [],
        operation: "flow",
      }),
      endGitFlow: async () => null,
      stopStoryRuntime: async (input: { storyId: string }) => {
        cleaned.push(input.storyId);
        return { projectSetupStopped: true };
      },
      removeStoryWorktree: async (input: { worktree: string }) => {
        removed.push(input.worktree);
        return true;
      },
      readWorkspaceFile: async () => '{"repaired":true}',
    },
    emit: (event: StoryHostEvent) => events.push(event),
  };
  return { host, calls, events, statuses, cleaned, removed };
}

const preferences = {
  agentModel: { providerId: "anthropic", modelId: "claude" },
  runMode: "direct" as const,
  premium: false,
  runtimePhase: "ready",
};

function row(
  id: string,
  projectId: string,
  fields: Record<string, unknown> = {},
): Row {
  return {
    id,
    projectId,
    storyNumber: 1,
    title: id,
    summary: `Do ${id}`,
    status: "ready",
    runMode: "direct",
    createdAt: "2026-11-21T10:00:00.000Z",
    ...fields,
  };
}

async function settle(service: StoryService, until: () => boolean) {
  for (let attempt = 0; attempt < 200 && !until(); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(until(), "the service settled");
  void service;
}

test("every queued story of every project starts at once, with no cap", async () => {
  const api = fakeApi([
    row("a1", "a"),
    row("a2", "a"),
    row("a3", "a"),
    row("b1", "b"),
    row("b2", "b"),
  ]);
  const { host, calls } = fakeHost();
  const service = new StoryService(host as never);
  try {
    await service.sync({
      projects: [
        { id: "a", path: "/projects/a" },
        { id: "b", path: "/projects/b" },
      ],
      preferences,
    });
    await settle(
      service,
      () => calls.filter(({ method }) => method === "send").length === 5,
    );
    for (const story of api.stories.values()) {
      assert.equal(story.status, "in-progress");
      assert.equal(story.agentStatus, "Running");
      assert.ok(story.engineSessionId);
    }
    const created = calls.filter(({ method }) => method === "createSession");
    assert.equal(created.length, 5);
  } finally {
    service.stop();
    api.restore();
  }
});

test("a story starts once the stories it starts after are done", async () => {
  const api = fakeApi([
    row("first", "a", { status: "in-review" }),
    row("second", "a", { startsAfter: ["first"] }),
    row("orphan", "a", { startsAfter: ["discarded"] }),
    row("discarded", "a", { status: "discarded" }),
  ]);
  const { host, calls, events } = fakeHost();
  const service = new StoryService(host as never);
  try {
    await service.sync({ projects: [{ id: "a", path: "/a" }], preferences });
    const reasons = () =>
      Object.fromEntries(
        service
          .queueState()
          .waiting.map((wait) => [wait.storyId, wait.reason.kind]),
      );
    assert.deepEqual(reasons(), {
      second: "dependencies",
      orphan: "dependency-dropped",
    });
    assert.ok(events.some((event) => event.type === "story-queue"));
    api.stories.get("first")!.status = "done";
    await service.refresh("a");
    await settle(service, () => calls.some(({ method }) => method === "send"));
    assert.equal(api.stories.get("second")!.status, "in-progress");
    assert.deepEqual(reasons(), { orphan: "dependency-dropped" });
  } finally {
    service.stop();
    api.restore();
  }
});

test("the end of a turn settles the story and tells the host's listeners", async () => {
  const api = fakeApi([
    row("story", "a", {
      status: "in-progress",
      agentStatus: "Running",
      engineSessionId: "session",
      workspaceMode: "direct",
      worktree: "/a",
    }),
  ]);
  const { host, statuses } = fakeHost();
  // Running now: nothing to recover on load.
  statuses.set("session", {
    session: "session",
    exists: true,
    running: true,
    turns: 1,
    models: [],
  });
  const service = new StoryService(host as never);
  const ended: StoryTurnEnded[] = [];
  service.onTurnEnded((event) => ended.push(event));
  try {
    await service.sync({ projects: [{ id: "a", path: "/a" }], preferences });
    statuses.set("session", {
      session: "session",
      exists: true,
      running: false,
      turns: 1,
      lastReply: "Added the checkout.",
      models: [{ providerId: "anthropic", modelId: "claude", turns: 1 }],
    });
    service.onActivity({
      session: "session",
      running: false,
      outcome: { status: "completed" } as never,
    });
    await settle(service, () => ended.length === 1);
    const story = api.stories.get("story")!;
    assert.equal(story.status, "in-review");
    assert.equal(story.agentStatus, null);
    assert.deepEqual(story.agentModels, [
      { providerId: "anthropic", modelId: "claude", turns: 1 },
    ]);
    assert.equal(ended[0]!.lastReply, "Added the checkout.");
    assert.equal(ended[0]!.outcome?.status, "completed");
  } finally {
    service.stop();
    api.restore();
  }
});

test("after a quit, a story left running is settled from its records", async () => {
  const api = fakeApi([
    row("story", "a", {
      status: "in-progress",
      agentStatus: "Running",
      engineSessionId: "session",
      workspaceMode: "direct",
    }),
  ]);
  const { host, statuses } = fakeHost();
  statuses.set("session", {
    session: "session",
    exists: true,
    running: false,
    turns: 2,
    lastOutcome: { status: "interrupted" },
    models: [],
  });
  const service = new StoryService(host as never);
  try {
    await service.sync({ projects: [{ id: "a", path: "/a" }], preferences });
    await settle(
      service,
      () => api.stories.get("story")!.agentStatus === "Paused",
    );
    assert.equal(api.stories.get("story")!.status, "in-progress");
  } finally {
    service.stop();
    api.restore();
  }
});

test("a message resumes a paused story; a pause stops the running turn", async () => {
  const api = fakeApi([
    row("story", "a", {
      status: "in-progress",
      agentStatus: "Paused",
      engineSessionId: "session",
      workspaceMode: "direct",
      worktree: "/a",
      agentModels: [{ providerId: "openai", modelId: "gpt" }],
    }),
  ]);
  const { host, calls } = fakeHost();
  const service = new StoryService(host as never);
  try {
    await service.sync({ projects: [{ id: "a", path: "/a" }], preferences });
    await service.send("story", {
      message: { text: "Use the blue button" },
      turn: { ultra: true },
    });
    const story = api.stories.get("story")!;
    assert.equal(story.agentStatus, "Running");
    const send = calls.find(({ method }) => method === "send")!.input as {
      message: { text: string; ultra?: boolean };
      delivery: string;
      settings: { settings: { model: { providerId: string } } };
    };
    assert.equal(send.message.text, "Use the blue button");
    assert.equal(send.message.ultra, true);
    assert.equal(send.delivery, "turn");
    // The story keeps the model it last worked with.
    assert.equal(send.settings.settings.model.providerId, "openai");
    await service.pause("story");
    assert.ok(calls.some(({ method }) => method === "interrupt"));
    // The turn's end, not the pause, pauses it.
    assert.equal(story.agentStatus, "Running");
  } finally {
    service.stop();
    api.restore();
  }
});

test("Approve & Merge merges, cleans up, and starts the stories after it", async () => {
  const api = fakeApi([
    row("first", "a", {
      status: "in-review",
      engineSessionId: "session",
      workspaceMode: "local-container",
      worktree: "/worktrees/first",
      branch: "story/first",
    }),
    row("second", "a", { startsAfter: ["first"] }),
  ]);
  const { host, calls, removed } = fakeHost();
  const service = new StoryService(host as never);
  try {
    await service.sync({ projects: [{ id: "a", path: "/a" }], preferences });
    const outcome = await service.approve("first", {
      model: { providerId: "anthropic", modelId: "claude" },
    });
    const merged = api.stories.get("first")!;
    assert.equal(merged.status, "done");
    assert.equal(merged.mergeCommit, "merge");
    assert.equal(merged.worktree, null);
    assert.equal(outcome.repositoryRoot, "/a");
    assert.deepEqual(outcome.previewRepairCandidate, { repaired: true });
    const merge = calls.find(({ method }) => method === "approveAndMerge")!
      .input as { worktree: string; storyBranch: string; inVm: boolean };
    assert.equal(merge.worktree, "/worktrees/first");
    assert.equal(merge.storyBranch, "story/first");
    await settle(service, () => removed.includes("/worktrees/first"));
    // Done with its agent: its session leaves the engine.
    assert.ok(calls.some(({ method }) => method === "deleteSession"));
    await settle(
      service,
      () => api.stories.get("second")!.status === "in-progress",
    );
  } finally {
    service.stop();
    api.restore();
  }
});

test("a discarded story shows at once and loses its runtime meanwhile", async () => {
  const api = fakeApi([
    row("story", "a", {
      status: "in-progress",
      agentStatus: "Paused",
      engineSessionId: "session",
      workspaceMode: "local-container",
      worktree: "/worktrees/story",
      branch: "story/x",
    }),
    row("after", "a", { startsAfter: ["story"] }),
  ]);
  const { host, events, removed } = fakeHost();
  const service = new StoryService(host as never);
  try {
    await service.sync({ projects: [{ id: "a", path: "/a" }], preferences });
    await service.discard("story", "Rejected during review");
    assert.equal(api.stories.get("story")!.status, "discarded");
    await settle(service, () => api.stories.get("story")!.worktree === null);
    assert.deepEqual(removed, ["/worktrees/story"]);
    assert.ok(
      events.some(
        (event) => event.type === "story-cleanup" && event.cleaning === false,
      ),
    );
    // The story kept its conversation for a rework.
    assert.equal(api.stories.get("story")!.engineSessionId, "session");
    const wait = service
      .queueState()
      .waiting.find(({ storyId }) => storyId === "after");
    assert.equal(wait?.reason.kind, "dependency-dropped");
  } finally {
    service.stop();
    api.restore();
  }
});

test("back to the backlog stops the story first; a delete removes it for good", async () => {
  const api = fakeApi([
    row("story", "a", {
      status: "in-progress",
      agentStatus: "Running",
      engineSessionId: "session",
      workspaceMode: "direct",
      worktree: "/a",
    }),
    row("other", "a", { status: "backlog" }),
  ]);
  const { host, calls, statuses, events } = fakeHost();
  statuses.set("session", {
    session: "session",
    exists: true,
    running: true,
    turns: 1,
    models: [],
  });
  const service = new StoryService(host as never);
  try {
    await service.sync({ projects: [{ id: "a", path: "/a" }], preferences });
    await service.toBacklog("story");
    const story = api.stories.get("story")!;
    assert.equal(story.status, "backlog");
    assert.equal(story.worktree, null);
    assert.ok(calls.some(({ method }) => method === "interrupt"));
    await service.remove("other");
    assert.equal(api.stories.has("other"), false);
    assert.ok(
      events.some(
        (event) => event.type === "story-removed" && event.storyId === "other",
      ),
    );
  } finally {
    service.stop();
    api.restore();
  }
});
