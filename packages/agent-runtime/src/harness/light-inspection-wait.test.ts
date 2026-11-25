import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { LightWorkspace } from "./test-client/light-workspace.js";
import { HarnessProcess } from "./test-client/harness.js";
import { SessionJournal } from "./session-journal.js";

/** One harness serving several sessions of a folder, as the engine's does: turns are per harness. */
function sessions(root: string) {
  const harness = new HarnessProcess();
  return (session: string, tool: string, input: unknown, signal?: AbortSignal) => harness.send("request", {
    tool, input, workspaceRoot: root, taskContract: { session_id: session }, workspaceOptions: { initialCommandWaitMs: 0 },
  }, signal) as Promise<{ status: string; data?: unknown }>;
}

/** The runner alone of a session's workspace, as `LightTaskRunner` was. */
function taskRunner(root: string, sessionId: string, initialCommandWaitMs: number) {
  return new LightWorkspace(root, { sessionId, initialCommandWaitMs }).tasks;
}

// "incremental wait wakes on output, bounds quiet waits and wakes on
// cancellation" and "a quiet command timeout wakes incremental inspection"
// drove the TypeScript process handle's in-process `waitForUpdate`; the
// harness exposes those waits only through run_task's inspection, which the
// tests below drive.

test("incremental run_task waits for quiet termination and publishes the real finalized result", { timeout: 15_000 }, async () => {
  const previous = process.env.BLAME_AGENT_INSPECT_WAIT;
  process.env.BLAME_AGENT_INSPECT_WAIT = "true";
  try {
    await fixture(async root => {
      const controller = new AbortController();
      const journal = new SessionJournal(root, "wait-result");
      const runner = taskRunner(root, "wait-result", 0);
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
    const runner = taskRunner(root, "bounded-output", 0);
    await writeFile(join(root, "noisy.cjs"), "const fs=require('node:fs');process.stdout.write(Array.from({length:6000},(_,i)=>'line '+i).join('\\n')+'\\n',()=>fs.writeFileSync('.blame/printed','x'));const tick=setInterval(()=>{if(fs.existsSync('.blame/go'))clearInterval(tick)},10);\n");
    try {
      const initial = data(await runner.run({ kind: "command", command: "node noisy.cjs" }, { signal: controller.signal }));
      await waitFor(join(root, ".blame/printed"));
      let page = data(await runner.run({ kind: "inspect", run: initial.run, cursor: "0", until: "now" })) as unknown as { output: string; nextOutput?: { cursor: string } };
      let all = page.output;
      while (page.nextOutput) {
        assert.ok(page.output.length <= 24_000, `${page.output.length} characters`);
        page = data(await runner.run({ kind: "inspect", run: initial.run, cursor: page.nextOutput.cursor, until: "now" })) as unknown as typeof page;
        all += page.output;
      }
      assert.equal(all, `${Array.from({ length: 6000 }, (_, index) => `line ${index}`).join("\n")}\n`);
      const latest = data(await runner.run({ kind: "inspect", run: initial.run, until: "now" })) as unknown as { output: string; earlierOutput?: unknown };
      assert.match(latest.output, /line 5999\n$/u);
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
    const runner = taskRunner(root, "exit-wait", 0);
    await writeFile(join(root, "slow.cjs"), "setTimeout(()=>{console.log('x'.repeat(14000));console.log('done')},600);\n");
    const initial = data(await runner.run({ kind: "command", command: "node slow.cjs" }));
    assert.equal(initial.process, "running");
    const result = data(await runner.run({ kind: "inspect", run: initial.run })) as unknown as { process: string; command?: string; output?: string; cursor?: string; completed?: { status: string; data?: { command?: string; output?: string; fullOutput?: { cursor: string } } } };
    assert.equal(result.process, "exited");
    assert.equal(result.completed?.status, "ok");
    assert.deepEqual(result.completed?.data?.fullOutput, { kind: "inspect", run: initial.run, cursor: "0", until: "now" });
    // The result says what the run printed once: no latest page beside it, no second copy of the command.
    assert.equal(result.command, "node slow.cjs");
    assert.equal(result.completed?.data?.command, undefined);
    assert.match(result.completed?.data?.output ?? "", /done$/u);
    assert.equal(result.output, undefined);
    assert.equal(result.cursor, undefined);
    const waiting = taskRunner(root, "exit-wait", 5_000);
    const quick = await waiting.run({ kind: "command", command: "node -e \"console.log('y'.repeat(14000))\"" }) as { data: { fullOutput?: { run: string } } };
    assert.ok(quick.data.fullOutput, "A command that finished within the wait keeps its output too.");
    const whole = data(await waiting.run({ kind: "inspect", run: quick.data.fullOutput.run, cursor: "0", until: "now" })) as unknown as { output: string };
    assert.match(whole.output, /^y{14000}\n$/u);
  });
});

test("a command sent while another runs waits for it instead of failing on the workspace", { timeout: 15_000 }, async () => {
  await fixture(async root => {
    const runner = taskRunner(root, "queued", 300);
    const order = join(root, ".blame/order");
    await writeFile(join(root, "first.cjs"), "const fs=require('node:fs');const tick=setInterval(()=>{if(fs.existsSync('.blame/go')){fs.appendFileSync('.blame/order','a');clearInterval(tick)}},10);\n");
    await writeFile(join(root, "second.cjs"), "require('node:fs').appendFileSync('.blame/order','b');\n");
    const first = data(await runner.run({ kind: "command", command: "node first.cjs" }));
    assert.equal(first.process, "running");
    const second = runner.run({ kind: "command", command: "node second.cjs" });
    await delay(200);
    const orderWhileFirstRuns = await readFile(order, "utf8").catch(() => "");
    await writeFile(join(root, ".blame/go"), "go");
    const result = await second as { status: string; data?: { exitCode?: number; run?: string } };
    assert.equal(result.status, "ok", JSON.stringify(result));
    // A managed run can write its output before the harness finishes journaling it.
    const completed = result.data?.run
      ? data(await runner.run({ kind: "inspect", run: result.data.run })).completed
      : result;
    assert.equal(completed?.status, "ok", JSON.stringify(completed));
    assert.equal(completed.data?.exitCode, 0);
    assert.equal(orderWhileFirstRuns, "", "The second command waits for the first.");
    assert.equal(await readFile(order, "utf8"), "ab");
  });
});

test("work blocked by a long run fails at once and says which run to wait for", { timeout: 15_000 }, async () => {
  await fixture(async root => {
    // The run holds its session's turn; the session's edit is refused at once.
    await writeFile(join(root, "a.txt"), "before\n");
    await writeFile(join(root, "long.cjs"), "const fs=require('node:fs');fs.writeFileSync('.blame/long-started','x');const tick=setInterval(()=>{if(fs.existsSync('.blame/go'))clearInterval(tick)},10);\n");
    const send = sessions(root);
    const controller = new AbortController();
    try {
      const initial = data(await send("blocked", "run_task", { kind: "command", command: "node long.cjs" }, controller.signal) as never);
      await waitFor(join(root, ".blame/long-started"));
      const started = Date.now();
      const blocked = await send("blocked", "edit_code", {
        operations: [{ kind: "patch", patch: "*** Begin Patch\n*** Update File: a.txt\n@@\n-before\n+after\n*** End Patch" }],
      });
      assert.notEqual(blocked.status, "ok");
      assert.match(JSON.stringify(blocked), new RegExp(`The workspace is busy: run ${initial.run} \\(\`node long.cjs\`\\) is still running`));
      assert.match(JSON.stringify(blocked), new RegExp(`\\\\"kind\\\\": \\\\"inspect\\\\", \\\\"run\\\\": \\\\"${initial.run}\\\\"`));
      assert.ok(Date.now() - started < 3_000, "No lock retries behind a long run.");
      assert.equal(await readFile(join(root, "a.txt"), "utf8"), "before\n");
    } finally {
      await writeFile(join(root, ".blame/go"), "go");
      controller.abort();
    }
  });
});

test("another session in the same folder keeps working while a long command runs", { timeout: 15_000 }, async () => {
  await fixture(async root => {
    const send = sessions(root);
    await writeFile(join(root, "long.cjs"), "const fs=require('node:fs');fs.writeFileSync('.blame/long-started','x');const tick=setInterval(()=>{if(fs.existsSync('.blame/go')){fs.writeFileSync('built.txt','done');clearInterval(tick)}},10);\n");
    const controller = new AbortController();
    try {
      const initial = data(await send("story", "run_task", { kind: "command", command: "node long.cjs" }, controller.signal) as never);
      await waitFor(join(root, ".blame/long-started"));
      assert.equal(initial.process, "running");

      const edit = { operations: [{ kind: "patch", patch: "*** Begin Patch\n*** Add File: notes.txt\n+note\n*** End Patch" }] };
      const started = Date.now();
      const chat = await send("chat", "edit_code", edit);
      assert.equal(chat.status, "ok", JSON.stringify(chat));
      assert.ok(Date.now() - started < 3_000, "The other session does not wait for the run.");
      const story = await send("story", "edit_code", { operations: [{ kind: "patch", patch: "*** Begin Patch\n*** Add File: story.txt\n+story\n*** End Patch" }] });
      assert.match(JSON.stringify(story), /run r1 .* is still running/, "The session that runs the command still takes turns.");
      const reads = Date.now();
      const read = await send("story", "read_code", { target: "long.cjs" });
      assert.equal(read.status, "ok", "Its own reads and searches go on while its command runs.");
      assert.ok(Date.now() - reads < 3_000);

      await writeFile(join(root, ".blame/go"), "go");
      const result = data(await send("story", "run_task", { kind: "inspect", run: initial.run, cursor: initial.cursor }) as never);
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

test("the journal records alias changes and replays the same list", async () => {
  await fixture(async root => {
    const journal = new SessionJournal(root, "aliases");
    const alias = (index: number, end = 10) => ({ alias: `s${index}`, kind: "path", path: `src/file${index}.ts`, start: 0, end }) as never;
    let entries = Array.from({ length: 300 }, (_, index) => alias(index));
    await journal.recordAliases(entries);
    for (let step = 0; step < 120; step += 1) {
      entries = [...entries.filter((_, index) => index !== step % 7), alias(300 + step, step)];
      await journal.recordAliases(entries);
    }
    const reloaded = new SessionJournal(root, "aliases");
    await reloaded.hydrate();
    assert.deepEqual(reloaded.currentAliases(), entries);
    const file = join(root, ".blame/harness/light", `${createHash("sha256").update("aliases").digest("hex").slice(0, 24)}.jsonl`);
    const full = Buffer.byteLength(JSON.stringify(entries));
    // A full list each time would take about 121 times one list.
    assert.ok((await stat(file)).size < full * 20, `${(await stat(file)).size} bytes`);
  });
});
