import assert from "node:assert/strict";
import test from "node:test";

import type { StoryTurnEnded } from "../story-protocol.js";
import { mergeStoppedText } from "./reconcile.js";
import { StoryService } from "./service.js";
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

test("every queued story of every project starts at once, with no cap", async () => {
  const api = fakeApi([
    row("a1", "a"),
    row("a2", "a"),
    row("a3", "a"),
    row("b1", "b"),
    row("b2", "b"),
  ]);
  const fake = fakeHost();
  const { service: stories, close } = await service(fake.host);
  try {
    await sync(stories, [
      { id: "a", path: "/projects/a" },
      { id: "b", path: "/projects/b" },
    ]);
    await settle(
      () => fake.calls.filter(({ method }) => method === "send").length === 5,
    );
    for (const story of api.stories.values()) {
      assert.equal(story.status, "in-progress");
      assert.equal(story.agentStatus, "Running");
    }
  } finally {
    await close();
    api.restore();
  }
});

test("a story of the backlog joins the queue and starts; one at work cannot be queued again", async () => {
  const api = fakeApi([
    row("draft", "a", { status: "backlog" }),
    row("busy", "a", working("busy-session")),
  ]);
  const fake = fakeHost();
  fake.live.add("busy-session");
  fake.statuses.set("busy-session", runningStatus("busy-session"));
  const { service: stories, close } = await service(fake.host, {
    busy: "busy-session",
  });
  try {
    await sync(stories, [{ id: "a", path: "/a" }]);
    await stories.enqueue("draft");
    await settle(() => api.stories.get("draft")!.status === "in-progress");
    await assert.rejects(stories.enqueue("busy"), /already at work/);
    await assert.rejects(
      stories.approve("busy", {
        model: { providerId: "anthropic", modelId: "claude" },
      }),
      /in review/,
    );
    assert.equal(api.stories.get("busy")!.status, "in-progress");
  } finally {
    await close();
    api.restore();
  }
});

test("each window's projects start; a closed window's no longer, and the last one's stay", async () => {
  const api = fakeApi([row("a1", "a", working("session-a")), row("b1", "b")]);
  const fake = fakeHost();
  fake.live.add("session-a");
  fake.statuses.set("session-a", runningStatus("session-a"));
  const { service: stories, close } = await service(fake.host, {
    a1: "session-a",
  });
  try {
    await sync(stories, [{ id: "a", path: "/a" }], "first");
    await sync(stories, [{ id: "b", path: "/b" }], "second");
    await settle(() => api.stories.get("b1")!.status === "in-progress");
    // The second window closes: its project's next story waits.
    stories.windowClosed("second");
    api.stories.set("b2", row("b2", "b"));
    await stories.refresh();
    await pause(100);
    assert.equal(api.stories.get("b2")!.status, "ready");
    const wait = stories
      .queueState()
      .waiting.find(({ storyId }) => storyId === "b2");
    assert.equal(wait?.reason.kind, "no-project");
    // The first window's running story still settles.
    fake.live.delete("session-a");
    fake.statuses.set(
      "session-a",
      endedStatus("session-a", [["t1", "completed"]]),
    );
    stories.onActivity({ session: "session-a", running: false });
    await settle(() => api.stories.get("a1")!.status === "in-review");
    // The last window closes: the app runs on, its projects' stories too.
    stories.windowClosed("first");
    api.stories.set("a2", row("a2", "a"));
    await stories.refresh();
    await settle(() => api.stories.get("a2")!.status === "in-progress");
  } finally {
    await close();
    api.restore();
  }
});

test("a turn that ended while Blame was closed is told once, after it starts again", async () => {
  const api = fakeApi([row("story", "a")]);
  const first = fakeHost();
  const { service: one, ledgerFile, close } = await service(first.host);
  try {
    await sync(one, [{ id: "a", path: "/a" }]);
    await settle(() => api.stories.get("story")!.agentStatus === "Running");
    one.stop();
    // Blame quits; the turn ends meanwhile (the engine's records say so).
    const session = api.stories.get("story")!.engineSessionId as string;
    const second = fakeHost();
    second.statuses.set(
      session,
      endedStatus(session, [["t1", "completed", "Done."]]),
    );
    const two = new StoryService(second.host as never, { ledgerFile });
    const ended: StoryTurnEnded[] = [];
    two.onTurnEnded((event) => ended.push(event));
    await sync(two, [{ id: "a", path: "/a" }]);
    await settle(
      () =>
        ended.length === 1 && api.stories.get("story")!.status === "in-review",
    );
    assert.equal(ended[0]!.turn, "t1");
    two.stop();
    // And never again.
    const third = fakeHost();
    third.statuses.set(
      session,
      endedStatus(session, [["t1", "completed", "Done."]]),
    );
    const three = new StoryService(third.host as never, { ledgerFile });
    const told: StoryTurnEnded[] = [];
    three.onTurnEnded((event) => told.push(event));
    await sync(three, [{ id: "a", path: "/a" }]);
    await pause(200);
    assert.equal(told.length, 0);
    three.stop();
  } finally {
    await close();
    api.restore();
  }
});

test("a turn's end that comes after the story was sent back leaves it in the backlog", async () => {
  const api = fakeApi([row("story", "a", working("session"))]);
  const fake = fakeHost();
  fake.live.add("session");
  fake.statuses.set("session", runningStatus("session"));
  const { service: stories, close } = await service(fake.host, {
    story: "session",
  });
  try {
    await sync(stories, [{ id: "a", path: "/a" }]);
    const back = stories.toBacklog("story");
    fake.live.delete("session");
    fake.statuses.set(
      "session",
      endedStatus("session", [["t1", "interrupted"]]),
    );
    stories.onActivity({ session: "session", running: false });
    await back;
    await pause(200);
    const story = api.stories.get("story")!;
    assert.equal(story.status, "backlog");
    assert.equal(story.agentStatus, null);
  } finally {
    await close();
    api.restore();
  }
});

test("a start or a merge cut short by a quit is settled when the project is read", async () => {
  const api = fakeApi([
    row("cut", "a", {
      status: "in-progress",
      agentStatus: null,
      worktree: "/a",
      workspaceMode: "direct",
    }),
    row("merging", "a", {
      status: "in-review",
      agentStatus: "Running",
      engineSessionId: "merged-session",
      worktree: "/w",
      workspaceMode: "direct",
    }),
    row("empty", "a", working("empty-session")),
  ]);
  const fake = fakeHost();
  fake.statuses.set(
    "merged-session",
    endedStatus("merged-session", [["t1", "completed"]]),
  );
  fake.statuses.set("empty-session", {
    session: "empty-session",
    exists: true,
    running: false,
    turns: 0,
    models: [],
  });
  const { service: stories, close } = await service(fake.host, {
    cut: null,
    merging: "merged-session",
    empty: "empty-session",
  });
  try {
    // No model: the stories put back in the queue stay there for the test.
    await sync(stories, [{ id: "a", path: "/a" }], "window", {
      ...preferences,
      agentModel: undefined,
    });
    await settle(() => api.stories.get("merging")!.agentStatus === null);
    assert.equal(api.stories.get("merging")!.agentLastError, mergeStoppedText);
    await settle(() => api.stories.get("cut")!.status === "ready");
    await settle(() => api.stories.get("empty")!.status === "ready");
    assert.equal(api.stories.get("empty")!.engineSessionId, null);
    assert.ok(
      fake.calls.some(
        ({ method, input }) =>
          method === "deleteSession" &&
          (input as { session: string }).session === "empty-session",
      ),
    );
  } finally {
    await close();
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
  const fake = fakeHost();
  fake.statuses.set("session", endedStatus("session", [["t1", "completed"]]));
  const { service: stories, close } = await service(fake.host, {
    story: "session",
  });
  try {
    await sync(stories, [{ id: "a", path: "/a" }]);
    fake.live.add("session");
    fake.statuses.set("session", {
      ...endedStatus("session", [["t1", "completed"]]),
      running: true,
      turnRunning: true,
    });
    stories.onActivity({ session: "session", running: true });
    await settle(() => api.stories.get("story")!.agentStatus === "Running");
    assert.equal(api.stories.get("story")!.status, "in-progress");
  } finally {
    await close();
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
  const fake = fakeHost();
  fake.statuses.set("session", {
    ...endedStatus("session", [["t1", "interrupted"]]),
    models: [{ providerId: "openai", modelId: "gpt", turns: 1 }],
  });
  const { service: stories, close } = await service(fake.host, {
    story: "session",
  });
  try {
    await sync(stories, [{ id: "a", path: "/a" }]);
    await stories.send("story", {
      message: { text: "Use the blue button" },
      turn: { ultra: true },
    });
    assert.equal(api.stories.get("story")!.agentStatus, "Running");
    const send = fake.calls.find(({ method }) => method === "send")!.input as {
      message: { ultra?: boolean };
      settings: { settings: { model: { providerId: string } } };
    };
    assert.equal(send.message.ultra, true);
    assert.equal(send.settings.settings.model.providerId, "openai");
    await stories.pause("story");
    assert.ok(fake.calls.some(({ method }) => method === "interrupt"));
  } finally {
    await close();
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
  const fake = fakeHost();
  fake.statuses.set("session", endedStatus("session", [["t1", "completed"]]));
  const { service: stories, close } = await service(fake.host, {
    first: "session",
  });
  try {
    await sync(stories, [{ id: "a", path: "/a" }]);
    assert.equal(stories.queueState().waiting[0]?.reason.kind, "dependencies");
    const outcome = await stories.approve("first", {
      model: { providerId: "anthropic", modelId: "claude" },
    });
    assert.equal(api.stories.get("first")!.status, "done");
    assert.deepEqual(outcome.previewRepairCandidate, { repaired: true });
    await settle(() => fake.order.includes("remove /worktrees/first"));
    assert.ok(fake.calls.some(({ method }) => method === "deleteSession"));
    await settle(() => api.stories.get("second")!.status === "in-progress");
  } finally {
    await close();
    api.restore();
  }
});

test("a rework and a new start wait for a discard's cleanup, which never writes over them", async () => {
  const api = fakeApi([
    row(
      "story",
      "a",
      working("session", {
        agentStatus: "Paused",
        worktree: "/worktrees/story",
        branch: "story/x",
      }),
    ),
  ]);
  const fake = fakeHost();
  fake.removeDelay.ms = 150;
  fake.statuses.set("session", endedStatus("session", [["t1", "interrupted"]]));
  const { service: stories, close } = await service(fake.host, {
    story: "session",
  });
  try {
    await sync(stories, [{ id: "a", path: "/a" }]);
    await stories.discard("story", "Rejected during review");
    assert.equal(api.stories.get("story")!.status, "discarded");
    // Reworked and queued again at once, while its worktree is removed.
    await stories.toBacklog("story");
    await stories.enqueue("story");
    await settle(() => api.stories.get("story")!.status === "in-progress");
    assert.deepEqual(fake.order, ["remove /worktrees/story", "create story"]);
    await pause(100);
    const story = api.stories.get("story")!;
    assert.equal(story.status, "in-progress");
    assert.equal(story.worktree, "/a", "its new worktree stays");
  } finally {
    await close();
    api.restore();
  }
});

test("a cleanup that outlasts the deadline holds the story until its worktree is gone", async () => {
  const api = fakeApi([
    row(
      "story",
      "a",
      working("session", {
        agentStatus: "Paused",
        worktree: "/worktrees/story",
        branch: "story/x",
      }),
    ),
  ]);
  const fake = fakeHost();
  // Removing a VM worktree with its preview's containers takes long.
  fake.removeDelay.ms = 300;
  fake.statuses.set("session", endedStatus("session", [["t1", "interrupted"]]));
  const { service: stories, close } = await service(
    fake.host,
    { story: "session" },
    { deadlineMs: 50 },
  );
  try {
    await sync(stories, [{ id: "a", path: "/a" }]);
    await stories.discard("story", "Rejected during review");
    await stories.toBacklog("story");
    await stories.enqueue("story");
    await settle(() => api.stories.get("story")!.status === "in-progress");
    assert.deepEqual(fake.order, ["remove /worktrees/story", "create story"]);
  } finally {
    await close();
    api.restore();
  }
});

test("back to the backlog stops the story first and says so; a delete removes it for good", async () => {
  const api = fakeApi([
    row("story", "a", working("session", { workspaceMode: "cloud-mirror" })),
    row("other", "a", { status: "backlog" }),
  ]);
  const fake = fakeHost();
  fake.live.add("session");
  fake.statuses.set("session", runningStatus("session"));
  const { service: stories, close } = await service(fake.host, {
    story: "session",
  });
  try {
    await sync(stories, [{ id: "a", path: "/a" }]);
    await stories.toBacklog("story");
    assert.equal(api.stories.get("story")!.status, "backlog");
    assert.ok(fake.calls.some(({ method }) => method === "interrupt"));
    assert.ok(
      fake.events.some(
        (event) =>
          event.type === "story-cleanup" &&
          event.cleaning &&
          event.workspaceMode === "cloud-mirror",
      ),
      "the windows hear of it (a Cloud Preview's state goes)",
    );
    await stories.remove("other");
    assert.equal(api.stories.has("other"), false);
  } finally {
    await close();
    api.restore();
  }
});

test("a story created elsewhere shows on the boards once its project is read again", async () => {
  const api = fakeApi([row("old", "a", { status: "backlog" })]);
  const fake = fakeHost();
  const { service: stories, close } = await service(fake.host);
  try {
    await sync(stories, [{ id: "a", path: "/a" }]);
    api.stories.set("new", row("new", "a", { status: "backlog" }));
    await stories.refresh("a");
    const announced = fake.events.filter(
      (event) => event.type === "story",
    ) as Array<{ storyId: string }>;
    assert.deepEqual(
      announced.map(({ storyId }) => storyId),
      ["new"],
    );
  } finally {
    await close();
    api.restore();
  }
});
