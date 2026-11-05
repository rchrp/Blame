import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { LightCommitService } from "./light-commit.js";
import { LightWorkspace } from "./light-workspace.js";
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
        const peek = data(await runner.run({ kind: "inspect", run: initial.run, until: "now" }));
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

test("a run's output comes in pages that skip nothing", { timeout: 15_000 }, async () => {
  await fixture(async root => {
    const controller = new AbortController();
    const runner = new LightTaskRunner({ files: new WorkspaceFiles(root), journal: new SessionJournal(root, "bounded-output"), initialCommandWaitMs: 0 });
    await writeFile(join(root, "noisy.cjs"), "const fs=require('node:fs');process.stdout.write(Array.from({length:3000},(_,i)=>'line '+i).join('\\n')+'\\n',()=>fs.writeFileSync('.blame/printed','x'));const tick=setInterval(()=>{if(fs.existsSync('.blame/go'))clearInterval(tick)},10);\n");
    try {
      const initial = data(await runner.run({ kind: "command", command: "node noisy.cjs" }, { signal: controller.signal }));
      await waitFor(join(root, ".blame/printed"));
      let page = data(await runner.run({ kind: "inspect", run: initial.run, cursor: "0", until: "now" })) as unknown as { output: string; nextOutput?: { cursor: string } };
      let all = page.output;
      while (page.nextOutput) {
        assert.ok(page.output.length <= 12_000, `${page.output.length} characters`);
        page = data(await runner.run({ kind: "inspect", run: initial.run, cursor: page.nextOutput.cursor, until: "now" })) as unknown as typeof page;
        all += page.output;
      }
      assert.equal(all, `${Array.from({ length: 3000 }, (_, index) => `line ${index}`).join("\n")}\n`);
      const latest = data(await runner.run({ kind: "inspect", run: initial.run, until: "now" })) as unknown as { output: string; earlierOutput?: unknown };
      assert.match(latest.output, /line 2999\n$/u);
      assert.ok(latest.earlierOutput, "The latest page says how to read from the start.");
    } finally {
      await writeFile(join(root, ".blame/go"), "go");
      controller.abort();
      await runner.run({ kind: "inspect", run: "r1" });
    }
  });
});

test("inspect waits for the run to end by default, and a finished run's cut output pages whole", { timeout: 15_000 }, async () => {
  await fixture(async root => {
    const runner = new LightTaskRunner({ files: new WorkspaceFiles(root), journal: new SessionJournal(root, "exit-wait"), initialCommandWaitMs: 0 });
    await writeFile(join(root, "slow.cjs"), "setTimeout(()=>{console.log('x'.repeat(10000));console.log('done')},600);\n");
    const initial = data(await runner.run({ kind: "command", command: "node slow.cjs" }));
    assert.equal(initial.process, "running");
    const result = data(await runner.run({ kind: "inspect", run: initial.run })) as unknown as { process: string; completed?: { status: string; data?: { fullOutput?: { cursor: string } } } };
    assert.equal(result.process, "exited");
    assert.equal(result.completed?.status, "ok");
    assert.deepEqual(result.completed?.data?.fullOutput, { kind: "inspect", run: initial.run, cursor: "0", until: "now" });
    const waiting = new LightTaskRunner({ files: new WorkspaceFiles(root), journal: new SessionJournal(root, "exit-wait"), initialCommandWaitMs: 5_000 });
    const quick = await waiting.run({ kind: "command", command: "node -e \"console.log('y'.repeat(9000))\"" }) as { data: { fullOutput?: { run: string } } };
    assert.ok(quick.data.fullOutput, "A command that finished within the wait keeps its output too.");
    const whole = data(await waiting.run({ kind: "inspect", run: quick.data.fullOutput.run, cursor: "0", until: "now" })) as unknown as { output: string };
    assert.match(whole.output, /^y{9000}\n$/u);
  });
});

test("a command sent while another runs waits for it instead of failing on the workspace", { timeout: 15_000 }, async () => {
  await fixture(async root => {
    const runner = new LightTaskRunner({ files: new WorkspaceFiles(root), journal: new SessionJournal(root, "queued"), initialCommandWaitMs: 300 });
    const order = join(root, ".blame/order");
    await writeFile(join(root, "first.cjs"), "const fs=require('node:fs');const tick=setInterval(()=>{if(fs.existsSync('.blame/go')){fs.appendFileSync('.blame/order','a');clearInterval(tick)}},10);\n");
    await writeFile(join(root, "second.cjs"), "require('node:fs').appendFileSync('.blame/order','b');\n");
    const first = data(await runner.run({ kind: "command", command: "node first.cjs" }));
    assert.equal(first.process, "running");
    const second = runner.run({ kind: "command", command: "node second.cjs" });
    await delay(200);
    assert.equal(await readFile(order, "utf8").catch(() => ""), "", "The second command waits for the first.");
    await writeFile(join(root, ".blame/go"), "go");
    const result = await second as { status: string; data?: { exitCode?: number } };
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(result.data?.exitCode, 0);
    assert.equal(await readFile(order, "utf8"), "ab");
  });
});

test("work blocked by a long run fails at once and says which run to wait for", async () => {
  await fixture(async root => {
    const files = new WorkspaceFiles(root);
    let finish!: () => void;
    let entered!: () => void;
    const holding = new Promise<void>((resolve) => { entered = resolve; });
    const running = new LightCommitService(files).exclusive(
      () => new Promise<void>((resolve) => { finish = resolve; entered(); }),
      { label: "run r7 (`pnpm test`)", run: "r7" },
    );
    await holding;
    try {
      const started = Date.now();
      await assert.rejects(
        new LightCommitService(files).exclusive(async () => undefined),
        (error: Error) => {
          assert.match(error.message, /The workspace is busy: run r7 \(`pnpm test`\) is still running/);
          assert.match(error.message, /"kind": "inspect", "run": "r7"/);
          return true;
        },
      );
      assert.ok(Date.now() - started < 1_000, "No lock retries behind a long run.");
    } finally {
      finish();
      await running;
    }
  });
});

test("another session in the same folder keeps working while a long command runs", { timeout: 15_000 }, async () => {
  await fixture(async root => {
    const runner = new LightTaskRunner({ files: new WorkspaceFiles(root, "story"), journal: new SessionJournal(root, "story"), initialCommandWaitMs: 0 });
    await writeFile(join(root, "long.cjs"), "const fs=require('node:fs');fs.writeFileSync('.blame/long-started','x');const tick=setInterval(()=>{if(fs.existsSync('.blame/go')){fs.writeFileSync('built.txt','done');clearInterval(tick)}},10);\n");
    const controller = new AbortController();
    try {
      const initial = data(await runner.run({ kind: "command", command: "node long.cjs" }, { signal: controller.signal }));
      await waitFor(join(root, ".blame/long-started"));
      assert.equal(initial.process, "running");

      const chat = new LightCommitService(new WorkspaceFiles(root, "chat"));
      const started = Date.now();
      assert.equal(await chat.exclusive(async () => "read"), "read");
      assert.ok(Date.now() - started < 2_000, "The other session does not wait for the run.");
      await assert.rejects(
        new LightCommitService(new WorkspaceFiles(root, "story")).exclusive(async () => undefined),
        /run r1 .* is still running/,
        "The session that runs the command still takes turns.",
      );
      const reads = Date.now();
      assert.equal(await new LightCommitService(new WorkspaceFiles(root, "story")).readExclusive(async () => "read"), "read",
        "Its own reads and searches go on while its command runs.");
      assert.ok(Date.now() - reads < 2_000);

      await writeFile(join(root, ".blame/go"), "go");
      const result = data(await runner.run({ kind: "inspect", run: initial.run, cursor: initial.cursor }));
      assert.equal(result.completed?.status, "ok");
      assert.equal(await readFile(join(root, "built.txt"), "utf8"), "done");
    } finally {
      await writeFile(join(root, ".blame/go"), "go");
      controller.abort();
    }
  });
});

test("the agent reads and searches code while its own command runs", { timeout: 20_000 }, async () => {
  await fixture(async root => {
    await writeFile(join(root, "value.ts"), "export const value = 1;\n");
    await writeFile(join(root, "long.cjs"), "const fs=require('node:fs');fs.writeFileSync('.blame/long-started','x');const tick=setInterval(()=>{if(fs.existsSync('.blame/go')){fs.writeFileSync('value.ts','export const value = 2;\\n');clearInterval(tick)}},10);\n");
    const workspace = new LightWorkspace(root, { sessionId: "reading", initialCommandWaitMs: 0 });
    const controller = new AbortController();
    try {
      const initial = data(await workspace.runTask({ kind: "command", command: "node long.cjs" }, { signal: controller.signal } as never));
      await waitFor(join(root, ".blame/long-started"));
      const started = Date.now();
      const read = await workspace.readCode({ target: "value.ts" }, {});
      assert.equal(read.status, "ok", JSON.stringify(read));
      assert.equal((await workspace.searchCode({ query: "value" })).status, "ok");
      assert.ok(Date.now() - started < 5_000, "Reads do not wait for the run.");
      assert.match(JSON.stringify(await workspace.editCode({ operations: [{ kind: "patch", path: "value.ts", patch: "*** Begin Patch\n*** Update File: value.ts\n@@\n-export const value = 1;\n+export const value = 3;\n*** End Patch" }] }, {})), /is still running/u,
        "Edits still wait for the run.");
      await writeFile(join(root, ".blame/go"), "go");
      const done = data(await workspace.runTask({ kind: "inspect", run: initial.run, cursor: initial.cursor }, {} as never)) as unknown as { completed: { data: { paths?: string[] } } };
      assert.deepEqual(done.completed.data.paths, ["value.ts"]);
    } finally {
      await writeFile(join(root, ".blame/go"), "go");
      controller.abort();
    }
  });
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
