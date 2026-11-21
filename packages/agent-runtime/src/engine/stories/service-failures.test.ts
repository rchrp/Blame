import assert from "node:assert/strict";
import test from "node:test";

import type { StoryQueueState, StoryTurnEnded } from "../story-protocol.js";
import {
  endedStatus,
  fakeApi,
  fakeHost,
  pause,
  preferences,
  row,
  runningStatus,
  service,
  settle,
  sync,
  working,
} from "./stories-fakes.test.js";

test("a story another computer runs is never read, paused nor settled here", async () => {
  const api = fakeApi([
    row("elsewhere", "a", working("their-session")),
    row("mine", "a", working("my-session")),
  ]);
  const fake = fakeHost();
  fake.statuses.set(
    "my-session",
    endedStatus("my-session", [["t1", "completed"]]),
  );
  const { service: stories, close } = await service(fake.host, {
    mine: "my-session",
  });
  try {
    await sync(stories, [{ id: "a", path: "/a" }]);
    await settle(() => api.stories.get("mine")!.status === "in-review");
    // Even asked to (an event about its session), it does not look.
    stories.onActivity({ session: "their-session", running: false });
    await pause(100);
    const asked = fake.calls
      .filter(({ method }) => method === "status")
      .flatMap(({ input }) => (input as { sessions: string[] }).sessions);
    assert.ok(!asked.includes("their-session"), "its session is not read here");
    assert.equal(api.stories.get("elsewhere")!.agentStatus, "Running");
    await assert.rejects(stories.pause("elsewhere"), /another computer/);
    await assert.rejects(
      stories.send("elsewhere", { message: { text: "Hello" } }),
      /another computer/,
    );
  } finally {
    await close();
    api.restore();
  }
});

test("a story this computer did not start loses its worktree here when it ends here, unless another computer runs its agent", async () => {
  const api = fakeApi([
    // In review from before this computer kept a ledger.
    row("before", "a", {
      status: "in-review",
      engineSessionId: "old-session",
      workspaceMode: "local-container",
      worktree: "/worktrees/before",
      branch: "story/before",
    }),
    row(
      "elsewhere",
      "a",
      working("their-session", {
        workspaceMode: "local-container",
        worktree: "/worktrees/elsewhere",
      }),
    ),
  ]);
  const fake = fakeHost();
  const { service: stories, close } = await service(fake.host);
  try {
    await sync(stories, [{ id: "a", path: "/a" }]);
    await stories.approve("before", {
      model: { providerId: "anthropic", modelId: "claude" },
    });
    await settle(
      () => fake.order.includes("remove /worktrees/before"),
      "the merged story's worktree to go",
    );
    await stories.discard("elsewhere", "Not needed");
    await pause(100);
    assert.ok(
      !fake.order.includes("remove /worktrees/elsewhere"),
      "the other computer's worktree is left alone",
    );
    assert.ok(
      !fake.calls.some(
        ({ method, input }) =>
          method === "interrupt" &&
          (input as { session: string }).session === "their-session",
      ),
      "its agent is not stopped here",
    );
  } finally {
    await close();
    api.restore();
  }
});

test("a session the engine could not read is not taken for one it lost", async () => {
  const api = fakeApi([row("story", "a", working("session"))]);
  const fake = fakeHost();
  fake.troubles.set("session", "throw");
  const { service: stories, close } = await service(
    fake.host,
    { story: "session" },
    { retryMs: () => 40 },
  );
  try {
    await sync(stories, [{ id: "a", path: "/a" }]);
    await pause(150);
    let story = api.stories.get("story")!;
    assert.equal(story.agentStatus, "Running", "nothing written");
    assert.equal(story.agentLastError, undefined);
    // It reads again later, and settles then.
    fake.troubles.delete("session");
    fake.statuses.set("session", endedStatus("session", [["t1", "completed"]]));
    await settle(() => api.stories.get("story")!.status === "in-review");
    story = api.stories.get("story")!;
    assert.equal(story.agentStatus, null);
  } finally {
    await close();
    api.restore();
  }
});

test("an engine that does not answer never holds the story's actions", async () => {
  const api = fakeApi([row("story", "a", working("session"))]);
  const fake = fakeHost();
  fake.troubles.set("session", "hang");
  const { service: stories, close } = await service(
    fake.host,
    { story: "session" },
    { deadlineMs: 50, retryMs: () => 10_000 },
  );
  try {
    await sync(stories, [{ id: "a", path: "/a" }]);
    await pause(20);
    // The reconcile waits on the engine; a discard comes after it.
    const started = Date.now();
    await stories.discard("story", "Not needed");
    assert.ok(Date.now() - started < 1_000, "the discard was not held");
    assert.equal(api.stories.get("story")!.status, "discarded");
  } finally {
    await close();
    api.restore();
  }
});

test("with the API down, a story is looked at again with a growing pause, not over and over", async () => {
  const api = fakeApi([row("story", "a", working("session"))]);
  const fake = fakeHost();
  fake.live.add("session");
  fake.statuses.set("session", runningStatus("session"));
  const { service: stories, close } = await service(
    fake.host,
    { story: "session" },
    { retryMs: (failures) => 40 * 2 ** (failures - 1) },
  );
  try {
    await sync(stories, [{ id: "a", path: "/a" }]);
    await pause(50);
    const stop = api.fail(
      ({ method, path }) =>
        method === "GET" && path === "/projects/user-stories/story",
      true,
    );
    const before = api.requests.length;
    // Every turn's start and end, while the API does not answer.
    for (let index = 0; index < 40; index += 1)
      stories.onActivity({ session: "session", running: index % 2 === 0 });
    await pause(350);
    const reads = api.requests
      .slice(before)
      .filter(({ path }) => path === "/projects/user-stories/story");
    assert.ok(reads.length <= 5, `${reads.length} reads in 350 ms`);
    stop();
  } finally {
    await close();
    api.restore();
  }
});

test("a compaction of a story in review moves nothing", async () => {
  const api = fakeApi([
    row(
      "story",
      "a",
      working("session", { status: "in-review", agentStatus: null }),
    ),
  ]);
  const fake = fakeHost();
  fake.statuses.set("session", endedStatus("session", [["t1", "completed"]]));
  const { service: stories, close } = await service(fake.host, {
    story: "session",
  });
  try {
    await sync(stories, [{ id: "a", path: "/a" }]);
    // The session is busy compacting: no turn runs.
    fake.live.add("session");
    fake.statuses.set("session", {
      ...endedStatus("session", [["t1", "completed"]]),
      running: true,
      turnRunning: false,
    });
    stories.onActivity({ session: "session", running: true });
    await pause(150);
    const story = api.stories.get("story")!;
    assert.equal(story.status, "in-review");
    assert.equal(story.agentStatus, null);
  } finally {
    await close();
    api.restore();
  }
});

test("a wait is said once while it lasts, however often the start is tried again", async () => {
  const api = fakeApi([row("story", "a")]);
  const fake = fakeHost();
  fake.host.desktop.gitIdentity = async () => ({
    available: true,
    configured: false,
  });
  const { service: stories, close } = await service(fake.host);
  try {
    await sync(stories, [{ id: "a", path: "/a" }]);
    await settle(() => stories.queueState().waiting.length === 1);
    const queues = () =>
      fake.events
        .filter((event) => event.type === "story-queue")
        .map((event) => (event as { queue: StoryQueueState }).queue);
    const seen = queues().length;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      stories.retry("story");
      await pause(60);
    }
    for (const queue of queues().slice(seen))
      assert.deepEqual(
        queue.waiting.map(({ reason }) => reason.kind),
        ["git-identity"],
        "the wait never left the queue's state",
      );
  } finally {
    await close();
    api.restore();
  }
});

test("a write's own answer is never replaced by a read asked before it arrived", async () => {
  const api = fakeApi([row("story", "a", { status: "backlog" })]);
  const fake = fakeHost();
  const { service: stories, close } = await service(fake.host);
  try {
    // No model: the queued story stays queued for the test.
    await sync(stories, [{ id: "a", path: "/a" }], "window", {
      ...preferences,
      agentModel: undefined,
    });
    const release = api.hold(
      ({ method, path }) =>
        method === "PATCH" && path === "/projects/user-stories/story",
    );
    const queued = stories.enqueue("story");
    await pause(20);
    // A list asked after the write was sent, answered before it applied.
    await stories.refresh("a");
    release();
    const answer = await queued;
    assert.equal(answer.status, "ready");
    assert.equal(
      (stories.payload("story") as { status: string }).status,
      "ready",
    );
  } finally {
    await close();
    api.restore();
  }
});

test("a refreshed token keeps the projects; signing out starts over", async () => {
  const api = fakeApi([row("first", "a", { status: "backlog" })]);
  const fake = fakeHost();
  const { service: stories, close } = await service(fake.host);
  try {
    await sync(stories, [{ id: "a", path: "/a" }]);
    fake.connection.token = "refreshed";
    stories.connected(fake.connection);
    api.stories.set("second", row("second", "a"));
    await stories.refresh();
    await settle(() => api.stories.get("second")!.status === "in-progress");
    // Signed out, then in again: nothing runs until a window says what.
    stories.connected(undefined);
    stories.connected(fake.connection);
    api.stories.set("third", row("third", "a"));
    await stories.refresh();
    await pause(100);
    assert.equal(api.stories.get("third")!.status, "ready");
    await sync(stories, [{ id: "a", path: "/a" }]);
    await settle(() => api.stories.get("third")!.status === "in-progress");
  } finally {
    await close();
    api.restore();
  }
});

test("a story waits while a window prepares its project's environment, and not once that window closed", async () => {
  const api = fakeApi([row("story", "a", { runMode: "local-container" })]);
  const fake = fakeHost();
  const { service: stories, close } = await service(fake.host);
  try {
    await sync(stories, [{ id: "a", path: "/a" }], "preparing", {
      ...preferences,
      initializingProjects: ["a"],
    });
    await sync(stories, [{ id: "a", path: "/a" }], "other");
    await settle(() => stories.queueState().waiting.length === 1);
    assert.equal(
      stories.queueState().waiting[0]!.reason.kind,
      "initialization",
    );
    await pause(50);
    assert.equal(api.stories.get("story")!.runMode, "local-container");
    // The window that prepared it closes (its analysis stops with it): no
    // working environment, so the story runs Direct.
    stories.windowClosed("preparing");
    stories.retry("story");
    await settle(() => api.stories.get("story")!.status === "in-progress");
    assert.equal(api.stories.get("story")!.runMode, "direct");
  } finally {
    await close();
    api.restore();
  }
});

test("a turn's end that fails to be written is written again, and told once", async () => {
  const api = fakeApi([row("story", "a", working("session"))]);
  const fake = fakeHost();
  fake.live.add("session");
  fake.statuses.set("session", runningStatus("session"));
  const { service: stories, close } = await service(fake.host, {
    story: "session",
  });
  const ended: StoryTurnEnded[] = [];
  stories.onTurnEnded((event) => ended.push(event));
  try {
    await sync(stories, [{ id: "a", path: "/a" }]);
    await pause(50);
    fake.live.delete("session");
    fake.statuses.set(
      "session",
      endedStatus("session", [["t1", "completed", "Added the checkout."]]),
    );
    api.fail(
      ({ method, path }) =>
        method === "PATCH" && path === "/projects/user-stories/story",
    );
    stories.onActivity({ session: "session", running: false });
    stories.onActivity({ session: "session", running: false });
    await settle(() => api.stories.get("story")!.status === "in-review");
    await settle(() => ended.length === 1);
    await pause(100);
    assert.equal(ended.length, 1, "told once");
    assert.equal(ended[0]!.lastReply, "Added the checkout.");
  } finally {
    await close();
    api.restore();
  }
});
