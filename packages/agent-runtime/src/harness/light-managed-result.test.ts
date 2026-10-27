import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { SessionJournal } from "./session-journal.js";
import { WorkspaceFiles } from "./workspace-files.js";
import type { LightToolResult } from "./light-contracts.js";

const { LightTaskRunner } = await import(
  process.env.BLAME_MANAGED_RESULT_RUNTIME ?? "./light-task-runner.js"
) as typeof import("./light-task-runner.js");

type Snapshot = {
  run: string;
  cursor: string;
  output: string;
  process: string;
  completed?: LightToolResult<unknown>;
};

for (const outcome of ["success", "failure", "cancelled", "unknown-test"] as const) {
  test(`first terminal inspection preserves finalized ${outcome} evidence`, { timeout: 15_000 }, async () => {
    await fixture(outcome, async ({ root, runner, initial, ready, release, controller, journal }) => {
      if (outcome === "cancelled") controller.abort();
      else await writeFile(join(root, ".blame/release"), "go");
      // Hold actual post-process recording after the child has already exited.
      // The historical inspect path returned an exited-only snapshot here.
      await ready;
      const inspected = runner.run({ kind: "inspect", run: initial.run, cursor: initial.cursor });
      release();
      const result = snapshot(await inspected);
      assert.notEqual(result.process, "running");
      assert.ok(result.completed, "A terminal process must expose its finalized outcome on this inspection.");
      assert.equal(await readFile(join(root, ".blame/launches"), "utf8"), "x");
      assert.ok(Number(result.cursor) >= Number(initial.cursor));
      if (outcome === "failure" || outcome === "cancelled") {
        assert.equal(result.completed.status, "blocked");
        assert.match(JSON.stringify(result.completed), outcome === "failure" ? /code 7/u : /cancelled/u);
        if (outcome === "cancelled") {
          const state = await journal.completionSnapshot();
          assert.ok(state.validations.every(v => v.status !== "passed"));
        }
      } else {
        assert.equal(result.completed.status, "ok", JSON.stringify(result.completed));
        const data = (result.completed as { data: { exitCode?: number; output: string; validation: { status: string }; check?: { outcome: string } } }).data;
        assert.equal(data.exitCode, 0);
        assert.match(data.output, /custom checks passed/u);
        if (outcome === "unknown-test") {
          assert.equal(data.check?.outcome, "unknown");
          assert.equal(data.validation.status, "unknown");
          const state = await journal.completionSnapshot();
          assert.ok(state.validations.every(v => v.status !== "passed"));
        }
      }
      // Reading the same cursor is repeatable and never launches the command again.
      const repeated = snapshot(await runner.run({ kind: "inspect", run: initial.run, cursor: initial.cursor }));
      assert.deepEqual(repeated, result);
    });
  });
}

test("a still-running inspection does not wait for process or journal completion", { timeout: 15_000 }, async () => {
  await fixture("success", async ({ runner, initial, controller }) => {
    const result = snapshot(await runner.run({ kind: "inspect", run: initial.run }));
    assert.equal(result.process, "running");
    assert.equal(result.completed, undefined);
    controller.abort();
  });
});

async function fixture(
  outcome: "success" | "failure" | "cancelled" | "unknown-test",
  run: (value: {
    root: string; runner: InstanceType<typeof LightTaskRunner>; initial: Snapshot;
    ready: Promise<void>; release: () => void; controller: AbortController; journal: SessionJournal;
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "blame-managed-result-"));
  const controller = new AbortController(), recording = deferred(), release = deferred();
  const journal = new SessionJournal(root, "managed-result");
  const record = journal.recordValidation.bind(journal);
  journal.recordValidation = async input => {
    recording.resolve();
    await release.promise;
    return record(input);
  };
  const runner = new LightTaskRunner({ files: new WorkspaceFiles(root), journal, initialCommandWaitMs: 0 });
  let initial: Snapshot | undefined;
  try {
    await mkdir(join(root, ".blame"));
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: outcome === "unknown-test" ? { test: "node check.cjs" } : {} }));
    await writeFile(join(root, "check.cjs"), `const fs=require('node:fs');
fs.appendFileSync('.blame/launches','x');
const tick=setInterval(()=>{if(fs.existsSync('.blame/release')){
 clearInterval(tick);console.log('custom checks passed');process.exitCode=${outcome === "failure" ? 7 : 0};
}},10);`);
    initial = snapshot(await runner.run(outcome === "unknown-test"
      ? { kind: "project", task: "test" }
      : { kind: "command", command: "node check.cjs" }, { signal: controller.signal }));
    assert.equal(initial.process, "running");
    await waitFor(join(root, ".blame/launches"));
    await run({ root, runner, initial, ready: recording.promise, release: release.resolve, controller, journal });
  } finally {
    release.resolve();
    controller.abort();
    if (initial) {
      // Also drain the unchanged reference implementation after an expected failure.
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const result = snapshot(await runner.run({ kind: "inspect", run: initial.run }));
        if (result.completed) break;
        await delay(10);
      }
    }
    await rm(root, { recursive: true, force: true });
  }
}

function snapshot(result: LightToolResult<unknown>) {
  assert.equal(result.status, "ok", JSON.stringify(result));
  return (result as { data: Snapshot }).data;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(path: string) {
  for (let n = 0; n < 300; n++) {
    if (await readFile(path).then(() => true, () => false)) return;
    await delay(10);
  }
  throw new Error("Fixture command did not start.");
}
