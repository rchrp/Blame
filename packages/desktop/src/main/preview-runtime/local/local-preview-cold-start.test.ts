import assert from "node:assert/strict";
import test from "node:test";
import type { DockerHost } from "@blame/preview-runtime/compose";
import { prepareColdStart } from "./local-preview-cold-start.ts";
import { createCompileQueue } from "./local-preview-compile-queue.ts";

const plan = {
  services: [{ id: "web", workingDir: "/workspace" }],
} as Parameters<typeof prepareColdStart>[0]["plan"];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

// Answers like the Blame Runtime: `presence` for the cache check, `seed`
// for the seed container's last line; captures wait for `captured`.
function fakeHost(input: {
  manifest?: string;
  presence: string;
  seed?: string;
  captured?: Promise<void>;
}) {
  const calls: string[] = [];
  const host: DockerHost = {
    readFile: async () =>
      input.manifest ?? JSON.stringify({ dependencies: { next: "16.4.6" } }),
    writeFile: async () => undefined,
    async run(command, args) {
      const script = args.find((arg) => arg.includes("\n")) ?? "";
      const kind = script.includes("echo captured")
        ? "capture"
        : script.includes("seeded $((")
          ? "seed"
          : script.includes("docker volume create")
            ? "volume"
            : "presence";
      calls.push(kind);
      if (kind === "capture") {
        await input.captured;
        return { exitCode: 0, stdout: "captured\n", stderr: "" };
      }
      const stdout =
        kind === "seed"
          ? input.seed
          : kind === "presence"
            ? input.presence
            : "";
      return { exitCode: 0, stdout: `${stdout ?? ""}\n`, stderr: "" };
    },
  };
  return { host, calls };
}

function inputFor(host: DockerHost, extra: Record<string, unknown> = {}) {
  const steps: string[] = [];
  const logs: string[] = [];
  const queue = createCompileQueue({ availableMemory: async () => 0 });
  return {
    steps,
    logs,
    queue,
    input: {
      host,
      worktree: "/w",
      plan,
      serviceIds: ["web"],
      dependencyKey: "abc123",
      owner: { uid: 1001, gid: 1001 },
      running: false,
      step: (step: string) => steps.push(step),
      log: (line: string) => logs.push(line),
      queue,
      ...extra,
    },
  };
}

test("a warm restart, a running preview or another framework skip the turn", async () => {
  const warm = fakeHost({ presence: "warm" });
  assert.equal(await prepareColdStart(inputFor(warm.host).input), undefined);
  assert.deepEqual(warm.calls, ["presence"]);

  const running = fakeHost({ presence: "none" });
  const runningInput = inputFor(running.host, { running: true }).input;
  assert.equal(await prepareColdStart(runningInput), undefined);
  assert.deepEqual(running.calls, []);

  const vite = fakeHost({
    presence: "none",
    manifest: JSON.stringify({ devDependencies: { vite: "7.0.0" } }),
  });
  assert.equal(await prepareColdStart(inputFor(vite.host).input), undefined);
  assert.deepEqual(vite.calls, []);
});

test("a seeded start gives its turn back once the first page answered", async () => {
  const { host, calls } = fakeHost({
    presence: "snapshot",
    seed: "seeded 600",
  });
  const { input, logs, queue } = inputFor(host);
  const start = await prepareColdStart(input);
  assert.equal(start?.kind, "seeded");
  await start!.enter();
  assert.deepEqual(queue.state, { running: 1, waiting: 0 });
  start!.answered();
  assert.deepEqual(queue.state, { running: 0, waiting: 0 });
  // A fresh snapshot is not taken again.
  assert.deepEqual(calls, ["presence", "seed"]);
  assert.match(logs.join(""), /Seeded the compile cache .*10 min old/);
});

test("a cold start keeps its turn until its cache became the snapshot", async () => {
  const captured = deferred();
  const { host, calls } = fakeHost({
    presence: "none",
    captured: captured.promise,
  });
  const { input, queue, steps } = inputFor(host);
  const first = await prepareColdStart(input);
  assert.equal(first?.kind, "cold");
  await first!.enter();

  const second = await prepareColdStart({ ...input, worktree: "/w2" });
  const entered = second!.enter();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(steps, ["Waiting for another preview to compile"]);

  first!.answered();
  first!.end();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(queue.state, { running: 1, waiting: 1 });
  captured.resolve();
  await entered;
  assert.deepEqual(queue.state, { running: 1, waiting: 0 });
  assert.ok(calls.includes("capture"));
  second!.end();
  assert.deepEqual(queue.state, { running: 0, waiting: 0 });
});

test("a start dropped while it waits gives its turn back when admitted", async () => {
  const { host } = fakeHost({ presence: "none" });
  const { input, queue } = inputFor(host);
  const first = await prepareColdStart(input);
  await first!.enter();
  const second = await prepareColdStart({ ...input, worktree: "/w2" });
  const entered = second!.enter();
  second!.end();
  first!.end();
  await entered;
  assert.deepEqual(queue.state, { running: 0, waiting: 0 });
});

test("a snapshot older than the refresh period is taken again", async () => {
  const { host, calls } = fakeHost({
    presence: "snapshot",
    seed: `seeded ${7 * 3600}`,
  });
  const { input } = inputFor(host);
  const start = await prepareColdStart(input);
  await start!.enter();
  start!.answered();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(calls, ["presence", "seed", "volume", "capture"]);
});

test("a cold start that waited seeds from the snapshot the first one left", async () => {
  const captured = deferred();
  const { host, calls } = fakeHost({
    presence: "none",
    captured: captured.promise,
  });
  const { input, logs } = inputFor(host);
  const first = await prepareColdStart(input);
  await first!.enter();
  const second = await prepareColdStart({ ...input, worktree: "/w2" });
  assert.equal(second?.kind, "cold");
  const entered = second!.enter();
  await new Promise((resolve) => setImmediate(resolve));
  // The first start's capture publishes a snapshot.
  first!.answered();
  await new Promise((resolve) => setImmediate(resolve));
  const presence = fakeHost({ presence: "snapshot", seed: "seeded 5" });
  input.host.run = presence.host.run;
  captured.resolve();
  await entered;
  assert.match(logs.join(""), /Seeded the compile cache .*0 min old/);
  // Its cache is fresh: it is not taken again.
  second!.answered();
  assert.equal(calls.filter((call) => call === "capture").length, 1);
  assert.deepEqual(presence.calls, ["presence", "seed"]);
  second!.end();
});
