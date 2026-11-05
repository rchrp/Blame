import assert from "node:assert/strict";
import test from "node:test";
import { queueDependencyInstall } from "./local-preview-install-queue.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

test("runs one dependency install at a time and says when one waits", async () => {
  const events: string[] = [];
  const first = deferred();
  const running = queueDependencyInstall(async () => {
    events.push("first started");
    await first.promise;
    events.push("first ended");
    return "first";
  });
  const waiting = queueDependencyInstall(
    async () => {
      events.push("second started");
      return "second";
    },
    () => events.push("second waits"),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["first started", "second waits"]);

  first.resolve();
  assert.deepEqual(await Promise.all([running, waiting]), ["first", "second"]);
  assert.deepEqual(events, [
    "first started",
    "second waits",
    "first ended",
    "second started",
  ]);
});

test("a failed install lets the next one run", async () => {
  const failed = queueDependencyInstall(async () => {
    throw new Error("install failed");
  });
  const next = queueDependencyInstall(async () => "installed");
  await assert.rejects(failed, /install failed/);
  assert.equal(await next, "installed");

  let waited = false;
  await queueDependencyInstall(
    async () => undefined,
    () => (waited = true),
  );
  assert.equal(waited, false);
});
