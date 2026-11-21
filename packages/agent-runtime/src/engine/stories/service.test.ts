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
  const events: StoryHostEvent[] = [];
  const statuses = new Map<string, unknown>();
  const host = {
    api: () => ({ url: "http://api.test/api/v1", token: "token" }),
    call: async (method: EngineHostMethod, input: unknown) => {
      calls.push({ method, input });
      if (method === "createSession")
        return { session: (input as { session: string }).session, head: 0 };
      if (method === "send") return { turn: "turn", started: true };
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
    },
    emit: (event: StoryHostEvent) => events.push(event),
  };
  return { host, calls, events, statuses };
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
