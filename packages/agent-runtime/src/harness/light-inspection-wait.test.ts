import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { startWorkspaceCommand } from "./workspace-command-process.js";
import { LightTaskRunner } from "./light-task-runner.js";
import { SessionJournal } from "./session-journal.js";
import { WorkspaceFiles } from "./workspace-files.js";

test("incremental wait wakes on output, bounds quiet waits and wakes on cancellation", { timeout: 15_000 }, async () => {
  await fixture(async root => {
    const controller = new AbortController();
    const execution = startWorkspaceCommand(process.execPath, ["-e", `const fs=require('node:fs');
fs.writeFileSync('.blame/ready','yes');let wrote=false;
setInterval(()=>{if(!wrote&&fs.existsSync('.blame/go')){wrote=true;console.log('next')}},10);`], { cwd: root, signal: controller.signal });
    try {
      await waitFor(join(root, ".blame/ready"));
      const first = execution.inspect();
      const waiting = execution.waitForUpdate(first.cursor, 5000);
      await writeFile(join(root, ".blame/go"), "go");
      const output = await waiting;
      assert.equal(output.process, "running");
      assert.equal(output.output, "next\n");
      assert.deepEqual(execution.inspect(first.cursor), output);
      const quiet = await execution.waitForUpdate(output.cursor, 20);
      assert.equal(quiet.process, "running");
      assert.equal(quiet.cursor, output.cursor);
      assert.equal(quiet.output, "");
      assert.throws(() => execution.waitForUpdate("invalid", 20), /Invalid run cursor/u);
      const observer = new AbortController();
      const abandoned = execution.waitForUpdate(output.cursor, 5000, observer.signal);
      observer.abort(new Error("stop observing"));
      await assert.rejects(abandoned, /stop observing/u);
      assert.equal(execution.inspect().process, "running", "Cancelling an observation does not fabricate process cancellation.");
      const cancellation = execution.waitForUpdate(output.cursor, 5000);
      controller.abort();
      assert.equal((await cancellation).process, "cancelled");
      const completed = await execution.completion;
      assert.equal(completed.failed, true);
      assert.equal(completed.interruption, "cancelled");
    } finally { controller.abort(); await execution.completion; }
  });
});

test("a quiet command timeout wakes incremental inspection", { timeout: 15_000 }, async () => {
  await fixture(async root => {
    const execution = startWorkspaceCommand(process.execPath, ["-e", "require('node:fs').writeFileSync('.blame/ready','yes');setInterval(()=>{},1000)"], { cwd: root, timeoutMs: 1500 });
    await waitFor(join(root, ".blame/ready"));
    const output = await execution.waitForUpdate(execution.inspect().cursor, 5000);
    assert.equal(output.process, "timed_out");
    assert.equal((await execution.completion).interruption, "timed_out");
  });
});

test("incremental run_task waits for quiet termination and publishes the real finalized result", { timeout: 15_000 }, async () => {
  const previous = process.env.BLAME_AGENT_INSPECT_WAIT;
  process.env.BLAME_AGENT_INSPECT_WAIT = "true";
  try {
    await fixture(async root => {
      const controller = new AbortController();
      const journal = new SessionJournal(root, "wait-result");
      const runner = new LightTaskRunner({ files: new WorkspaceFiles(root), journal, initialCommandWaitMs: 0 });
      await writeFile(join(root, "check.cjs"), "const fs=require('node:fs');fs.appendFileSync('.blame/launches','x');const tick=setInterval(()=>{if(fs.existsSync('.blame/go'))clearInterval(tick)},10);\n");
      try {
        const initial = data(await runner.run({ kind: "command", command: "node check.cjs" }, { signal: controller.signal }));
        await waitFor(join(root, ".blame/launches"));
        const peek = data(await runner.run({ kind: "inspect", run: initial.run }));
        assert.equal(peek.process, "running");
        assert.equal(peek.completed, undefined);
        const pending = runner.run({ kind: "inspect", run: initial.run, cursor: initial.cursor });
        await writeFile(join(root, ".blame/go"), "go");
        const result = data(await pending);
        assert.equal(result.process, "exited");
        assert.equal(result.cursor, initial.cursor, "Quiet completion does not fabricate cursor progress.");
        assert.equal(result.completed?.status, "ok");
        assert.equal(result.completed?.data?.exitCode, 0);
        assert.equal(result.completed?.data?.validation, undefined, "Ordinary zero exit is not admitted verification.");
        assert.equal(await readFile(join(root, ".blame/launches"), "utf8"), "x");
      } finally { controller.abort(); await runner.run({ kind: "inspect", run: "r1" }); }
    });
  } finally {
    if (previous === undefined) delete process.env.BLAME_AGENT_INSPECT_WAIT;
    else process.env.BLAME_AGENT_INSPECT_WAIT = previous;
  }
});

function data(result: unknown) {
  const value = result as { status: string; data: { run: string; cursor: string; process: string; completed?: { status: string; data?: { exitCode: number; validation?: unknown } } } };
  assert.equal(value.status, "ok", JSON.stringify(value));
  return value.data;
}

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "blame-inspection-wait-"));
  try { await mkdir(join(root, ".blame")); await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function waitFor(path: string) {
  for (let n = 0; n < 300; n++) {
    if (await readFile(path).then(() => true, () => false)) return;
    await delay(10);
  }
  throw new Error("Fixture did not start.");
}
