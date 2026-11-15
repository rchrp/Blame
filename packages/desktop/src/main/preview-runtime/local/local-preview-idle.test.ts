import assert from "node:assert/strict";
import test from "node:test";
import {
  idlePreviewActions,
  idlePreviewWorktrees,
} from "./local-preview-idle.ts";

const minute = 60_000;

test("stops previews unused for the timeout, never one an agent works in", () => {
  const now = 100 * minute;
  const lastUse = new Map([
    ["/w/viewed", now - 5 * minute],
    ["/w/forgotten", now - 30 * minute],
    ["/w/agent", now - 60 * minute],
  ]);
  assert.deepEqual(
    idlePreviewWorktrees({
      running: ["/w/viewed", "/w/forgotten", "/w/agent", "/w/untracked"],
      busy: (worktree) => worktree === "/w/agent",
      lastUse,
      since: 0,
      now,
      timeoutMs: 20 * minute,
    }),
    ["/w/forgotten", "/w/untracked"],
  );
});

test("counts a preview already running from when Blame started", () => {
  const since = 90 * minute;
  assert.deepEqual(
    idlePreviewWorktrees({
      running: ["/w/previous-session"],
      busy: () => false,
      lastUse: new Map(),
      since,
      now: since + 10 * minute,
      timeoutMs: 20 * minute,
    }),
    [],
  );
});

test("hibernates after a few minutes, stops after hours", () => {
  const now = 1_000 * minute;
  const lastUse = new Map([
    ["/w/viewed", now - 2 * minute],
    ["/w/idle", now - 6 * minute],
    ["/w/asleep", now - 30 * minute],
    ["/w/forgotten", now - 180 * minute],
  ]);
  assert.deepEqual(
    idlePreviewActions({
      running: ["/w/viewed", "/w/idle", "/w/asleep", "/w/forgotten"],
      hibernated: (worktree) => worktree === "/w/asleep",
      agentWorksIn: () => false,
      lastUse,
      lastAgentWork: new Map(),
      since: 0,
      now,
    }),
    { hibernate: ["/w/idle"], stop: ["/w/forgotten"] },
  );
});

test("an agent at work lets its preview hibernate but not stop", () => {
  const now = 1_000 * minute;
  const actions = (agentWorksIn: boolean, agentWorkedAgo: number) =>
    idlePreviewActions({
      running: ["/w/story"],
      hibernated: () => false,
      agentWorksIn: () => agentWorksIn,
      lastUse: new Map([["/w/story", now - 300 * minute]]),
      lastAgentWork: new Map([["/w/story", now - agentWorkedAgo * minute]]),
      since: 0,
      now,
    });
  assert.deepEqual(actions(true, 0), { hibernate: ["/w/story"], stop: [] });
  // The user reviews it once the agent is done: hibernated, not stopped.
  assert.deepEqual(actions(false, 30), { hibernate: ["/w/story"], stop: [] });
  assert.deepEqual(actions(false, 150), { hibernate: [], stop: ["/w/story"] });
});
