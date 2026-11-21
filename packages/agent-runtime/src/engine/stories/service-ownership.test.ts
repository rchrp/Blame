// A story at work the ledger does not name (the previous build left it, or
// the ledger was lost) is this computer's when its engine runs the story's
// session or its own worktree is here, and, left from before the ledger
// started empty, when its engine keeps the session.

import assert from "node:assert/strict";
import test from "node:test";

import type { StoryTurnEnded } from "../story-protocol.js";
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

test("a story the previous build left at work, whose session this computer keeps, is settled here, its last turn told once", async () => {
  const api = fakeApi([row("left", "a", working("old-session"))]);
  const fake = fakeHost();
  fake.stored.add("old-session");
  fake.statuses.set(
    "old-session",
    endedStatus("old-session", [
      ["t1", "completed", "Started the page."],
      ["t2", "completed", "Added the page."],
    ]),
  );
  // The first run of a build that keeps a ledger: there is none yet.
  const { service: stories, close } = await service(fake.host, null);
  const ended: StoryTurnEnded[] = [];
  stories.onTurnEnded((event) => ended.push(event));
  try {
    await sync(stories, [{ id: "a", path: "/a" }]);
    await settle(() => api.stories.get("left")!.status === "in-review");
    assert.equal(api.stories.get("left")!.agentStatus, null);
    await settle(() => ended.length === 1);
    await pause(100);
    assert.deepEqual(
      ended.map(({ turn, lastReply }) => [turn, lastReply]),
      [["t2", "Added the page."]],
      "only the turn it was left at work for",
    );
  } finally {
    await close();
    api.restore();
  }
});

test("a story at work whose agent runs here can be paused and messaged, though no ledger names it", async () => {
  const api = fakeApi([]);
  const fake = fakeHost();
  const { service: stories, close } = await service(fake.host);
  const reached = (method: string, session: string) =>
    fake.calls.some(
      (call) =>
        call.method === method &&
        (call.input as { session: string }).session === session,
    );
  try {
    await sync(stories, [{ id: "a", path: "/a" }]);
    // Read after the project was first read: only the action asks.
    for (const [id, session] of [
      ["paused", "paused-session"],
      ["told", "told-session"],
    ]) {
      api.stories.set(id!, row(id!, "a", working(session!)));
      fake.live.add(session!);
      fake.statuses.set(session!, runningStatus(session!));
    }
    await stories.refresh("a");
    await stories.pause("paused");
    assert.ok(reached("interrupt", "paused-session"), "its turn was stopped");
    await stories.send("told", { message: { text: "Go on" } });
    assert.ok(reached("send", "told-session"), "the message reached its agent");
  } finally {
    await close();
    api.restore();
  }
});

test("a story at work whose worktree is here is cleaned here when discarded, though no ledger names it", async () => {
  const api = fakeApi([
    row(
      "kept",
      "a",
      working("gone-session", {
        workspaceMode: "local-container",
        worktree: "/worktrees/kept",
      }),
    ),
  ]);
  const fake = fakeHost();
  fake.worktrees.add("/worktrees/kept");
  const { service: stories, close } = await service(fake.host);
  try {
    await sync(stories, [{ id: "a", path: "/a" }]);
    await stories.discard("kept", "Not needed");
    await settle(
      () => fake.order.includes("remove /worktrees/kept"),
      "its worktree to go",
    );
    assert.ok(
      fake.calls.some(
        ({ method, input }) =>
          method === "interrupt" &&
          (input as { session: string }).session === "gone-session",
      ),
      "its agent was stopped",
    );
    await settle(() => api.stories.get("kept")!.agentStatus === null);
    assert.equal(api.stories.get("kept")!.status, "discarded");
  } finally {
    await close();
    api.restore();
  }
});

test("with a ledger kept all along, a story at work whose session was only followed here is left alone", async () => {
  const api = fakeApi([row("theirs", "a", working("their-session"))]);
  const fake = fakeHost();
  // Its drawer was open here: the engine keeps a copy of its session.
  fake.stored.add("their-session");
  fake.statuses.set(
    "their-session",
    endedStatus("their-session", [["t1", "interrupted"]]),
  );
  const { service: stories, close } = await service(fake.host);
  try {
    await sync(stories, [{ id: "a", path: "/a" }]);
    stories.onActivity({ session: "their-session", running: false });
    await pause(150);
    const asked = fake.calls
      .filter(({ method }) => method === "status")
      .flatMap(({ input }) => (input as { sessions: string[] }).sessions);
    assert.ok(!asked.includes("their-session"), "its session is not read");
    assert.equal(api.stories.get("theirs")!.agentStatus, "Running");
    await assert.rejects(stories.pause("theirs"), /another computer/);
  } finally {
    await close();
    api.restore();
  }
});

test(
  "the service's own look never starts the runtime VM; a person's discard looks there",
  // On Linux a Local Container story runs on the host, with no VM.
  { skip: process.platform === "linux" },
  async () => {
    const api = fakeApi([
      row(
        "in-vm",
        "a",
        working("vm-session", {
          workspaceMode: "local-container",
          worktree: "/vm/worktrees/in-vm",
        }),
      ),
    ]);
    const fake = fakeHost();
    fake.worktrees.add("/vm/worktrees/in-vm");
    const looked: string[] = [];
    const worktreeHere = fake.host.desktop.storyWorktreeHere;
    fake.host.desktop.storyWorktreeHere = async (input) => {
      looked.push(input.worktree);
      return worktreeHere(input);
    };
    fake.host.storedSessions = async () => {
      looked.push("sessions");
      return [...fake.stored];
    };
    const { service: stories, close } = await service(fake.host, null);
    try {
      // The Blame Runtime is stopped.
      await sync(stories, [{ id: "a", path: "/a" }], "window", {
        ...preferences,
        runtimePhase: "stopped",
      });
      await pause(100);
      assert.equal(looked.length, 0, "nothing asked of the VM");
      await stories.discard("in-vm", "Not needed");
      await settle(
        () => fake.order.includes("remove /vm/worktrees/in-vm"),
        "its worktree to go",
      );
      assert.ok(looked.includes("/vm/worktrees/in-vm"));
    } finally {
      await close();
      api.restore();
    }
  },
);
