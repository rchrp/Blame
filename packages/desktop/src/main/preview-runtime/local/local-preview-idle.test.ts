import assert from "node:assert/strict";
import test from "node:test";
import { idlePreviewWorktrees } from "./local-preview-idle.ts";

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
