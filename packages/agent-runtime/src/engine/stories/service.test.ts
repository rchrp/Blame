import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { EngineHostMethod } from "../protocol.js";
import type { StoryHostEvent, StoryTurnEnded } from "../story-protocol.js";
import { mergeStoppedText } from "./reconcile.js";
import { StoryService } from "./service.js";

type Row = Record<string, unknown> & { id: string; projectId: string };
type Request = { method: string; path: string; at: number };

/**
 * The account's API, in memory: stories, their PATCH and DELETE, and the
 * project's environment. `fail` makes the next request matching a test
 * answer 500; `hold` keeps answers back until released.
 */
function fakeApi(rows: Row[]) {
  const stories = new Map(rows.map((row) => [row.id, { ...row }]));
  const requests: Request[] = [];
  const failures: Array<(request: Request) => boolean> = [];
  const holds: Array<{
    match: (request: Request) => boolean;
    gate: Promise<void>;
  }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const { pathname, searchParams } = new URL(url);
    const path = pathname.replace(/^\/api\/v1/, "");
    const method = init?.method ?? "GET";
    const request = { method, path, at: Date.now() };
    requests.push(request);
    const json = (value: unknown) =>
      new Response(JSON.stringify({ data: value }), { status: 200 });
    // A list read now, answered when the test says (a slow read).
    const snapshot =
      path === "/projects/user-stories" && method === "GET"
        ? [...stories.values()]
            .filter((row) => row.projectId === searchParams.get("projectId"))
            .map((row) => ({ ...row }))
        : undefined;
    const held = holds.find((hold) => hold.match(request));
    if (held) await held.gate;
    const failing = failures.findIndex((matches) => matches(request));
    if (failing >= 0) {
      failures.splice(failing, 1);
      return new Response(JSON.stringify({ message: "unavailable" }), {
        status: 500,
      });
    }
    if (snapshot) return json(snapshot);
    const story = /^\/projects\/user-stories\/([^/]+)$/.exec(path);
    if (story) {
      const row = stories.get(story[1]!);
      if (!row)
        return new Response(JSON.stringify({ message: "Row not found" }), {
          status: 404,
        });
      if (method === "DELETE") {
        stories.delete(row.id);
        return new Response(null, { status: 204 });
      }
      if (method === "PATCH")
        Object.assign(row, JSON.parse(String(init!.body)), {
          updatedAt: new Date().toISOString(),
        });
      return json({ ...row });
    }
    if (/^\/projects\/[^/]+\/initialization$/.test(path))
      return json({ initialization: null, practices: [] });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return {
    stories,
    requests,
    fail: (matches: (request: Request) => boolean) => failures.push(matches),
    hold(match: (request: Request) => boolean) {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      holds.push({ match, gate });
      return release;
    },
    restore: () => (globalThis.fetch = original),
  };
}

type Status = {
  session: string;
  exists: boolean;
  running: boolean;
  turns: number;
  models: Array<{ providerId: string; modelId: string; turns: number }>;
  lastOutcome?: { status: string };
  endedTurns?: Array<{
    turn: string;
    outcome: { status: string };
    reply?: string;
  }>;
};

function runningStatus(session: string): Status {
  return { session, exists: true, running: true, turns: 1, models: [] };
}

function endedStatus(
  session: string,
  turns: Array<[string, string, string?]>,
): Status {
  const endedTurns = turns.map(([turn, status, reply]) => ({
    turn,
    outcome: { status },
    ...(reply ? { reply } : {}),
  }));
  return {
    session,
    exists: true,
    running: false,
    turns: turns.length,
    models: [
      { providerId: "anthropic", modelId: "claude", turns: turns.length },
    ],
    lastOutcome: endedTurns.at(-1)?.outcome,
    endedTurns,
  };
}

function fakeHost() {
  const calls: Array<{ method: EngineHostMethod; input: unknown }> = [];
  const events: StoryHostEvent[] = [];
  const statuses = new Map<string, Status>();
  const live = new Set<string>();
  const removed: string[] = [];
  const host = {
    api: () => ({ url: "http://api.test/api/v1", token: "token" }),
    call: async (method: EngineHostMethod, input: unknown) => {
      calls.push({ method, input });
      if (method === "createSession")
        return { session: (input as { session: string }).session, head: 0 };
      if (method === "send") {
        const session = (input as { session: string }).session;
        live.add(session);
        statuses.set(session, runningStatus(session));
        return { turn: "turn", started: true };
      }
      if (method === "running") return [...live];
      if (method === "status")
        return (input as { sessions: string[] }).sessions.map(
          (session) =>
            statuses.get(session) ?? {
              session,
              exists: false,
              running: false,
              turns: 0,
              models: [],
            },
        );
      if (method === "approveAndMerge")
        return {
          baseCommit: "base",
          mergeCommit: "merge",
          push: { status: "skipped" },
          targetBranch: "main",
        };
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
      stopStoryRuntime: async () => ({ projectSetupStopped: true }),
      removeStoryWorktree: async (input: { worktree: string }) => {
        removed.push(input.worktree);
        return true;
      },
      readWorkspaceFile: async () => '{"repaired":true}',
    },
    emit: (event: StoryHostEvent) => events.push(event),
  };
  return { host, calls, events, statuses, live, removed };
}

const preferences = {
  agentModel: { providerId: "anthropic", modelId: "claude" },
  runMode: "direct" as const,
  premium: false,
  runtimePhase: "ready",
};

function sync(
  service: StoryService,
  projects: Array<{ id: string; path: string }>,
  window = "window",
  prefs: Record<string, unknown> = preferences,
) {
  return service.sync({ window, projects, preferences: prefs as never });
}

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

function working(session: string, fields: Record<string, unknown> = {}) {
  return {
    status: "in-progress",
    agentStatus: "Running",
    engineSessionId: session,
    workspaceMode: "direct",
    worktree: "/a",
    ...fields,
  };
}

async function settle(until: () => boolean, what = "the service to settle") {
  for (let attempt = 0; attempt < 500 && !until(); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(until(), `waited for ${what}`);
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
    await sync(service, [
      { id: "a", path: "/projects/a" },
      { id: "b", path: "/projects/b" },
    ]);
    await settle(
      () => calls.filter(({ method }) => method === "send").length === 5,
    );
    for (const story of api.stories.values()) {
      assert.equal(story.status, "in-progress");
      assert.equal(story.agentStatus, "Running");
      assert.ok(story.engineSessionId);
    }
  } finally {
    service.stop();
    api.restore();
  }
});

test("each window adds its projects: none drops another's, whose running story still settles", async () => {
  const api = fakeApi([row("a1", "a", working("session-a")), row("b1", "b")]);
  const { host, calls, statuses, live } = fakeHost();
  live.add("session-a");
  statuses.set("session-a", runningStatus("session-a"));
  const service = new StoryService(host as never);
  try {
    await sync(service, [{ id: "a", path: "/a" }], "first");
    // Another window knows only its own project.
    await sync(service, [{ id: "b", path: "/b" }], "second");
    await settle(
      () => calls.some(({ method }) => method === "send"),
      "b1 to start",
    );
    // The first window's story still settles when its turn ends.
    live.delete("session-a");
    statuses.set(
      "session-a",
      endedStatus("session-a", [["t1", "completed", "Done a1."]]),
    );
    service.onActivity({ session: "session-a", running: false });
    await settle(
      () => api.stories.get("a1")!.status === "in-review",
      "a1 to settle",
    );
  } finally {
    service.stop();
    api.restore();
  }
});

test("a story that cannot start never makes the queue spin", async () => {
  const api = fakeApi([row("ready", "a"), row("stale", "a")]);
  const { host } = fakeHost();
  const service = new StoryService(host as never);
  try {
    // No model yet: the story waits, and nothing is read for it.
    await sync(service, [{ id: "a", path: "/a" }], "window", {
      ...preferences,
      agentModel: undefined,
    });
    await pause(300);
    const reads = api.requests.filter(({ path }) =>
      path.startsWith("/projects/user-stories/"),
    );
    assert.equal(reads.length, 0, "no story read while no model is chosen");
    const wait = service
      .queueState()
      .waiting.find(({ storyId }) => storyId === "ready");
    assert.equal(wait?.reason.kind, "no-model");
    // The cache says ready, the API no longer does: one read, then a pause.
    api.stories.get("stale")!.status = "backlog";
    api.stories.get("ready")!.status = "backlog";
    await sync(service, [{ id: "a", path: "/a" }]);
    await pause(400);
    const staleReads = api.requests.filter(
      ({ path }) => path === "/projects/user-stories/stale",
    );
    assert.ok(
      staleReads.length <= 2,
      `${staleReads.length} reads of a story that is not ready`,
    );
  } finally {
    service.stop();
    api.restore();
  }
});

test("a turn's end that fails to be written is written again, and told once", async () => {
  const api = fakeApi([row("story", "a", working("session"))]);
  const { host, statuses, live } = fakeHost();
  live.add("session");
  statuses.set("session", runningStatus("session"));
  const service = new StoryService(host as never);
  const ended: StoryTurnEnded[] = [];
  service.onTurnEnded((event) => ended.push(event));
  try {
    await sync(service, [{ id: "a", path: "/a" }]);
    await pause(50);
    live.delete("session");
    statuses.set(
      "session",
      endedStatus("session", [["t1", "completed", "Added the checkout."]]),
    );
    // The first write of the turn's end fails; the event comes twice.
    api.fail(
      ({ method, path }) =>
        method === "PATCH" && path === "/projects/user-stories/story",
    );
    service.onActivity({ session: "session", running: false });
    service.onActivity({ session: "session", running: false });
    await settle(
      () => api.stories.get("story")!.status === "in-review",
      "the turn's end to be written",
    );
    await settle(() => ended.length === 1, "the turn to be told");
    await pause(100);
    assert.equal(ended.length, 1, "told once");
    assert.equal(ended[0]!.turn, "t1");
    assert.equal(ended[0]!.lastReply, "Added the checkout.");
    assert.equal(api.stories.get("story")!.agentStatus, null);
  } finally {
    service.stop();
    api.restore();
  }
});

test("a turn that ended while Blame was closed is told once, after it starts again", async () => {
  const directory = await mkdtemp(join(tmpdir(), "story-ledger-"));
  const ledgerFile = join(directory, "turns.json");
  const api = fakeApi([row("story", "a")]);
  const first = fakeHost();
  const service = new StoryService(first.host as never, { ledgerFile });
  try {
    await sync(service, [{ id: "a", path: "/a" }]);
    await settle(() => api.stories.get("story")!.agentStatus === "Running");
    service.stop();
    // Blame quits; the turn ends meanwhile (the engine's records say so).
    const session = api.stories.get("story")!.engineSessionId as string;
    const second = fakeHost();
    second.statuses.set(
      session,
      endedStatus(session, [["t1", "completed", "Done."]]),
    );
    const restarted = new StoryService(second.host as never, { ledgerFile });
    const ended: StoryTurnEnded[] = [];
    restarted.onTurnEnded((event) => ended.push(event));
    await sync(restarted, [{ id: "a", path: "/a" }]);
    await settle(
      () =>
        ended.length === 1 && api.stories.get("story")!.status === "in-review",
    );
    restarted.stop();
    // And never again.
    const third = fakeHost();
    third.statuses.set(
      session,
      endedStatus(session, [["t1", "completed", "Done."]]),
    );
    const again = new StoryService(third.host as never, { ledgerFile });
    const told: StoryTurnEnded[] = [];
    again.onTurnEnded((event) => told.push(event));
    await sync(again, [{ id: "a", path: "/a" }]);
    await pause(200);
    assert.equal(told.length, 0);
    again.stop();
  } finally {
    service.stop();
    api.restore();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a turn's end that comes after the story was sent back leaves it in the backlog", async () => {
  const api = fakeApi([row("story", "a", working("session"))]);
  const { host, statuses, live } = fakeHost();
  live.add("session");
  statuses.set("session", runningStatus("session"));
  const service = new StoryService(host as never);
  try {
    await sync(service, [{ id: "a", path: "/a" }]);
    const back = service.toBacklog("story");
    // The interrupted turn's end arrives while the story goes back.
    live.delete("session");
    statuses.set("session", endedStatus("session", [["t1", "interrupted"]]));
    service.onActivity({ session: "session", running: false });
    await back;
    await pause(200);
    const story = api.stories.get("story")!;
    assert.equal(story.status, "backlog");
    assert.equal(story.agentStatus, null);
  } finally {
    service.stop();
    api.restore();
  }
});

test("a list read before a write does not bring back what the write changed", async () => {
  const api = fakeApi([row("story", "a", working("session"))]);
  const { host, statuses, live } = fakeHost();
  live.add("session");
  statuses.set("session", runningStatus("session"));
  const service = new StoryService(host as never);
  try {
    await sync(service, [{ id: "a", path: "/a" }]);
    // A reload whose answer comes late, from before the turn's end.
    const release = api.hold(
      ({ method, path }) =>
        method === "GET" && path === "/projects/user-stories",
    );
    const reload = service.refresh("a");
    await pause(20);
    live.delete("session");
    statuses.set("session", endedStatus("session", [["t1", "completed"]]));
    service.onActivity({ session: "session", running: false });
    await settle(() => api.stories.get("story")!.status === "in-review");
    await pause(50);
    release();
    await reload;
    const payload = service.payload("story") as { status: string };
    assert.equal(payload.status, "in-review");
  } finally {
    service.stop();
    api.restore();
  }
});

test("an action asks a story in the state it needs", async () => {
  const api = fakeApi([
    row("working", "a", working("session", { branch: "story/x" })),
  ]);
  const { host, statuses, live } = fakeHost();
  live.add("session");
  statuses.set("session", runningStatus("session"));
  const service = new StoryService(host as never);
  try {
    await sync(service, [{ id: "a", path: "/a" }]);
    await assert.rejects(service.enqueue("working"), /already at work/);
    await assert.rejects(
      service.approve("working", {
        model: { providerId: "anthropic", modelId: "claude" },
      }),
      /in review/,
    );
    assert.equal(api.stories.get("working")!.status, "in-progress");
  } finally {
    service.stop();
    api.restore();
  }
});

test("a start or a merge cut short by a quit is settled when the project is read", async () => {
  const api = fakeApi([
    // Quit after its worktree, before its session.
    row("cut", "a", {
      status: "in-progress",
      agentStatus: null,
      worktree: "/a",
      workspaceMode: "direct",
    }),
    // Quit during Approve & Merge.
    row("merging", "a", {
      status: "in-review",
      agentStatus: "Running",
      engineSessionId: "merged-session",
      worktree: "/w",
      workspaceMode: "direct",
    }),
    // Quit after its session, before its first message.
    row("empty", "a", working("empty-session")),
  ]);
  const { host, statuses, calls } = fakeHost();
  statuses.set(
    "merged-session",
    endedStatus("merged-session", [["t1", "completed"]]),
  );
  statuses.set("empty-session", {
    session: "empty-session",
    exists: true,
    running: false,
    turns: 0,
    models: [],
  });
  const service = new StoryService(host as never);
  try {
    // No model: the stories put back in the queue stay there for the test.
    await sync(service, [{ id: "a", path: "/a" }], "window", {
      ...preferences,
      agentModel: undefined,
    });
    await settle(() => api.stories.get("merging")!.agentStatus === null);
    assert.equal(api.stories.get("merging")!.agentLastError, mergeStoppedText);
    await settle(() => api.stories.get("cut")!.status === "ready");
    await settle(() => api.stories.get("empty")!.status === "ready");
    assert.equal(api.stories.get("empty")!.engineSessionId, null);
    assert.ok(
      calls.some(
        ({ method, input }) =>
          method === "deleteSession" &&
          (input as { session: string }).session === "empty-session",
      ),
      "the empty session goes",
    );
  } finally {
    service.stop();
    api.restore();
  }
});

test("a follow-up whose turn starts as the last one ends shows the story at work", async () => {
  const api = fakeApi([
    row(
      "story",
      "a",
      working("session", { status: "in-review", agentStatus: null }),
    ),
  ]);
  const { host, statuses, live } = fakeHost();
  statuses.set("session", endedStatus("session", [["t1", "completed"]]));
  const service = new StoryService(host as never);
  const ended: StoryTurnEnded[] = [];
  service.onTurnEnded((event) => ended.push(event));
  try {
    await sync(service, [{ id: "a", path: "/a" }]);
    // A turn starts on the story in review (a message the engine had queued).
    live.add("session");
    statuses.set("session", {
      ...endedStatus("session", [["t1", "completed"]]),
      running: true,
    });
    service.onActivity({ session: "session", running: true });
    await settle(() => api.stories.get("story")!.agentStatus === "Running");
    assert.equal(api.stories.get("story")!.status, "in-progress");
  } finally {
    service.stop();
    api.restore();
  }
});

test("a message to a paused story makes it work; a pause stops the running turn", async () => {
  const api = fakeApi([
    row(
      "story",
      "a",
      working("session", {
        agentStatus: "Paused",
        agentModels: [{ providerId: "openai", modelId: "gpt" }],
      }),
    ),
  ]);
  const { host, calls, statuses } = fakeHost();
  statuses.set("session", {
    ...endedStatus("session", [["t1", "interrupted"]]),
    models: [{ providerId: "openai", modelId: "gpt", turns: 1 }],
  });
  const service = new StoryService(host as never);
  try {
    await sync(service, [{ id: "a", path: "/a" }]);
    await service.send("story", {
      message: { text: "Use the blue button" },
      turn: { ultra: true },
    });
    assert.equal(api.stories.get("story")!.agentStatus, "Running");
    const send = calls.find(({ method }) => method === "send")!.input as {
      message: { text: string; ultra?: boolean };
      settings: { settings: { model: { providerId: string } } };
    };
    assert.equal(send.message.ultra, true);
    // The story keeps the model it last worked with.
    assert.equal(send.settings.settings.model.providerId, "openai");
    await service.pause("story");
    assert.ok(calls.some(({ method }) => method === "interrupt"));
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
  const { host, calls, removed, statuses } = fakeHost();
  statuses.set("session", endedStatus("session", [["t1", "completed"]]));
  const service = new StoryService(host as never);
  try {
    await sync(service, [{ id: "a", path: "/a" }]);
    const wait = service.queueState().waiting[0]?.reason;
    assert.equal(wait?.kind, "dependencies");
    const outcome = await service.approve("first", {
      model: { providerId: "anthropic", modelId: "claude" },
    });
    const merged = api.stories.get("first")!;
    assert.equal(merged.status, "done");
    assert.equal(merged.mergeCommit, "merge");
    assert.deepEqual(outcome.previewRepairCandidate, { repaired: true });
    await settle(() => removed.includes("/worktrees/first"));
    assert.ok(calls.some(({ method }) => method === "deleteSession"));
    await settle(() => api.stories.get("second")!.status === "in-progress");
  } finally {
    service.stop();
    api.restore();
  }
});

test("a discard cleans up meanwhile, never over a story reworked since", async () => {
  const api = fakeApi([
    row(
      "story",
      "a",
      working("session", {
        agentStatus: "Paused",
        workspaceMode: "local-container",
        worktree: "/worktrees/story",
        branch: "story/x",
      }),
    ),
    row("after", "a", { startsAfter: ["story"] }),
  ]);
  const { host, events, removed, statuses } = fakeHost();
  statuses.set("session", endedStatus("session", [["t1", "interrupted"]]));
  const service = new StoryService(host as never);
  try {
    await sync(service, [{ id: "a", path: "/a" }]);
    await service.discard("story", "Rejected during review");
    assert.equal(api.stories.get("story")!.status, "discarded");
    await settle(() => api.stories.get("story")!.worktree === null);
    assert.deepEqual(removed, ["/worktrees/story"]);
    assert.ok(
      events.some((event) => event.type === "story-cleanup" && !event.cleaning),
    );
    assert.equal(api.stories.get("story")!.engineSessionId, "session");
    const wait = service
      .queueState()
      .waiting.find(({ storyId }) => storyId === "after");
    assert.equal(wait?.reason.kind, "dependency-dropped");
    // Reworked and queued again: a late cleanup write would not touch it.
    await service.toBacklog("story");
    await service.enqueue("story");
    assert.equal(
      api.stories.get("story")!.status === "ready" ||
        api.stories.get("story")!.status === "in-progress",
      true,
    );
  } finally {
    service.stop();
    api.restore();
  }
});

test("back to the backlog stops the story first; a delete removes it for good", async () => {
  const api = fakeApi([
    row("story", "a", working("session")),
    row("other", "a", { status: "backlog" }),
  ]);
  const { host, calls, statuses, events, live } = fakeHost();
  live.add("session");
  statuses.set("session", runningStatus("session"));
  const service = new StoryService(host as never);
  try {
    await sync(service, [{ id: "a", path: "/a" }]);
    await service.toBacklog("story");
    assert.equal(api.stories.get("story")!.status, "backlog");
    assert.equal(api.stories.get("story")!.worktree, null);
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
