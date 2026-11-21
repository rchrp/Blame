import assert from "node:assert/strict";
import { test } from "node:test";
import type { EngineClient, SessionConfig } from "@blame/engine-client";
import { EngineTaskError, TaskRunner, VM_SCAN_UNSUPPORTED } from "./runner.js";

const spec = {
  config: {} as SessionConfig,
  instruction: "Do it.",
  result: (value: unknown) => value,
};

function fakeClient() {
  const started: string[] = [];
  let finish: (() => void) | undefined;
  const client = {
    runTask: (params: { session: string }) => {
      started.push(params.session);
      return new Promise((resolve) => {
        finish = () => resolve({ status: "completed", call: "c", result: 1 });
      });
    },
  } as unknown as EngineClient;
  return { client, started, finish: () => finish?.() };
}

test("a follow of an announced task waits until the engine has its session", async () => {
  const fake = fakeClient();
  const runner = new TaskRunner(async () => fake.client);
  runner.announce("task-a");
  let followed = false;
  const follow = runner.whenCreated("task-a").then(() => (followed = true));
  // The host prepares the task (a scan): the follow still waits.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(followed, false);
  const running = runner.run(spec, { session: "task-a", what: "The task" });
  await follow;
  assert.deepEqual(fake.started, ["task-a"], "the session was asked for first");
  fake.finish();
  assert.equal((await running).result, 1);
  // Anything else is followed at once.
  await runner.whenCreated("conversation");
});

test("an announced task cancelled while it is prepared never runs", async () => {
  const fake = fakeClient();
  const runner = new TaskRunner(async () => fake.client);
  runner.announce("task-b");
  assert.equal(runner.cancel("task-b"), true);
  await assert.rejects(
    runner.run(spec, { session: "task-b", what: "The task" }),
    (error: unknown) =>
      error instanceof EngineTaskError &&
      error.outcome.status === "interrupted",
  );
  assert.deepEqual(fake.started, []);
  runner.settled("task-b");
  assert.equal(runner.cancel("task-b"), false, "nothing left to cancel");
});

test("a project task refuses a folder the host locates in the VM, before any scan", () => {
  const runner = new TaskRunner(
    async () => {
      throw new Error("no engine is asked");
    },
    (root) => (root.startsWith("/home/blame/") ? "vm" : "host"),
  );
  assert.throws(
    () => runner.assertHostScan("/home/blame/.local/share/blame/runtime/worktrees/a"),
    new RegExp(VM_SCAN_UNSUPPORTED.slice(0, 40)),
  );
  assert.doesNotThrow(() => runner.assertHostScan("/Users/me/project"));
});
