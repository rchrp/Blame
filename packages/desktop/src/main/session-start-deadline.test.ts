import assert from "node:assert/strict";
import test from "node:test";

import { withSessionStartDeadline } from "./session-start-deadline.ts";

test("a start that answers in time is returned as is", async () => {
  const aborted: string[] = [];
  const session = await withSessionStartDeadline(
    Promise.resolve({ sessionId: "s1" }),
    async (id) => aborted.push(id),
    1_000,
  );
  assert.deepEqual(session, { sessionId: "s1" });
  assert.deepEqual(aborted, []);
});

test("a start that never answers fails after the deadline", async () => {
  await assert.rejects(
    withSessionStartDeadline(
      new Promise<{ sessionId: string }>(() => {}),
      async () => undefined,
      20,
    ),
    /did not answer within 0 seconds while starting the session/,
  );
});

test("a session that starts after the deadline is stopped", async () => {
  const aborted: string[] = [];
  let resolve!: (session: { sessionId: string }) => void;
  const start = new Promise<{ sessionId: string }>((done) => {
    resolve = done;
  });
  await assert.rejects(
    withSessionStartDeadline(start, async (id) => aborted.push(id), 20),
  );
  resolve({ sessionId: "late" });
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(aborted, ["late"]);
});

test("a start that fails keeps its own error", async () => {
  await assert.rejects(
    withSessionStartDeadline(
      Promise.reject(new Error("Hub connection closed")),
      async () => undefined,
      1_000,
    ),
    /Hub connection closed/,
  );
});
