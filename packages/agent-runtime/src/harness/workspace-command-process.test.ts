import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  executeWorkspaceCommand,
  startWorkspaceCommand,
} from "./workspace-command-process.js";
import { LightWorkspace } from "./light-workspace.js";
import { SessionJournal } from "./session-journal.js";

test("command results preserve nonzero status and diagnostic streams", async () => {
  const result = await run("process.stdout.write('out'); process.stderr.write('err'); process.exitCode=7");
  assert.equal(result.exitCode, 7);
  assert.equal(result.failed, true);
  assert.match(result.all, /out/u);
  assert.match(result.all, /err/u);
});

test("a completed parent does not wait for a child's inherited output", async () => {
  const script = "const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},3000)'],{detached:true,stdio:['ignore',1,2]}); console.log(c.pid); c.unref()";
  const started = performance.now();
  const result = await run(script);
  const childPid = Number(result.all.trim());
  try {
    assert.equal(result.failed, false, result.all);
    assert.ok(performance.now() - started < 1500);
    assert.ok(childPid > 0);
    assert.doesNotThrow(() => process.kill(childPid, 0));
  } finally {
    terminateFixture(childPid);
  }
});

test("normal completion drains a large output without losing its final bytes", async () => {
  const text = "é漢🙂".repeat(20_000);
  const result = await run("process.stdout.write('é漢🙂'.repeat(20000))");
  assert.equal(result.failed, false);
  assert.equal(result.all, text);
});

test("UTF-8 decoding remains separate when stdout and stderr interleave", async () => {
  const script = "process.stdout.write(Buffer.from([0xe2])); setTimeout(()=>{process.stderr.write('error'); setTimeout(()=>process.stdout.write(Buffer.from([0x82,0xac])),50)},50)";
  const result = await run(script);
  assert.equal(result.failed, false);
  assert.equal(result.all, "error€");
});

test("a timeout stops the owned process group and preserves partial output", { skip: process.platform === "win32" }, async () => {
  await fixture(async (root) => {
    const descendant = "setTimeout(()=>require('fs').writeFileSync('survived','yes'),900)";
    const script = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'inherit'}); console.log('started'); setTimeout(()=>{},3000)`;
    const started = performance.now();
    const result = await run(script, { cwd: root, timeoutMs: 200 });
    assert.equal(result.failed, true);
    assert.equal(result.interruption, "timed_out");
    assert.match(result.all, /started/u);
    assert.ok(performance.now() - started < 1000);
    await delay(1000);
    await assert.rejects(access(join(root, "survived")));
  });
});

test("a cancelled command returns a bounded failure", async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 150);
  const started = performance.now();
  try {
    const result = await run("setTimeout(()=>{},3000)", { signal: controller.signal });
    assert.equal(result.failed, true);
    assert.equal(result.interruption, "cancelled");
    assert.ok(performance.now() - started < 1000);
  } finally {
    clearTimeout(timer);
  }
});

test("a pre-cancelled command is never started", () => {
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => run("process.exit(0)", { signal: controller.signal }), /abort/iu);
});

test("capture overflow terminates the command instead of claiming success", async () => {
  const result = await run("process.stdout.write('x'.repeat(100000));setTimeout(()=>{},3000)", {
    maximumOutputBytes: 1024,
  });
  assert.equal(result.failed, true);
  assert.equal(result.interruption, "output_limit");
  assert.match(result.all, /captured output limit/u);
  assert.ok(Buffer.byteLength(result.all) < 1200);
});

test("a running command exposes stable incremental output cursors", async () => {
  await fixture(async root => {
    const controller = new AbortController();
    const execution = startWorkspaceCommand(process.execPath,
      ["-e", "console.log('first');const fs=require('node:fs');const timer=setInterval(()=>{if(fs.existsSync('release')){clearInterval(timer);console.log('second')}},10)"],
      { cwd: root, signal: controller.signal });
    try {
      // Child startup is not guaranteed within 50ms under concurrent compilers.
      // Hold the second chunk until the first cursor has actually been observed.
      const deadline = Date.now() + 3000;
      while (!execution.inspect().output.includes("first") && Date.now() < deadline) await delay(10);
      const first = execution.inspect();
      assert.equal(first.process, "running"); assert.match(first.output, /first/u);
      await writeFile(join(root, "release"), "ready");
      await execution.completion;
      const second = execution.inspect(first.cursor);
      assert.equal(second.process, "exited"); assert.equal(second.output.trim(), "second");
    } finally { controller.abort(); await execution.completion; }
  });
});

test("run_task inspects a long command without launching it again", async () => {
  await fixture(async (root) => {
    const workspace = new LightWorkspace(root, {
      sessionId: "inspect-run",
      initialCommandWaitMs: 20,
    });
    const controller = new AbortController();
    const started = await workspace.runTask(
      {
        kind: "command",
        command:
          "node -e \"require('fs').appendFileSync('launches','x');console.log('first');setTimeout(()=>console.log('second'),80);setTimeout(()=>{},3000)\"",
      },
      { signal: controller.signal },
    );
    assert.equal(started.status, "ok", JSON.stringify(started));
    const initial = started as {
      data: { cursor: string; process: string; run: string };
    };
    assert.equal(initial.data.process, "running");
    // The child may start well after the initial wait on a loaded runner, and
    // the echoed command also contains "second": wait for the real output.
    let inspected: Awaited<ReturnType<typeof workspace.runTask>>;
    const deadline = Date.now() + 5000;
    do {
      await delay(50);
      inspected = await workspace.runTask(
        { kind: "inspect", run: initial.data.run, cursor: initial.data.cursor },
        {},
      );
      assert.equal(inspected.status, "ok", JSON.stringify(inspected));
    } while (
      !(inspected as { data: { output: string } }).data.output.includes("second") &&
      Date.now() < deadline
    );
    assert.match((inspected as { data: { output: string } }).data.output, /second/u);
    controller.abort();
    await delay(150);
    const cancelled = await workspace.runTask(
      {
        kind: "inspect",
        run: initial.data.run,
        cursor: (inspected as { data: { cursor: string } }).data.cursor,
      },
      {},
    );
    assert.match(JSON.stringify(cancelled), /cancelled/u);
    assert.match(JSON.stringify(cancelled), /completed/u);
    assert.equal(await readFile(join(root, "launches"), "utf8"), "x");
  });
});

test("spawn failures retain their environment diagnostic", async () => {
  const result = await executeWorkspaceCommand("blame-nonexistent-test-executable", [], { cwd: tmpdir() });
  assert.equal(result.failed, true);
  assert.equal(result.exitCode, undefined);
  assert.match(result.all, /ENOENT/u);
});

test("Windows command scripts preserve argument boundaries", { skip: process.platform !== "win32" }, async () => {
  await fixture(async (root) => {
    const command = join(root, "echo argument.cmd");
    await writeFile(command, "@echo off\r\necho %~1\r\n");
    const result = await executeWorkspaceCommand(command, ["two words & literal"], { cwd: root });
    assert.equal(result.failed, false, result.all);
    assert.equal(result.all.trim(), "two words & literal");
  });
});

test("an interrupted project test never receives a passed validation", async () => {
  await fixture(async (root) => {
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node check.cjs" } }));
    await writeFile(join(root, "check.cjs"), "process.on('SIGTERM',()=>process.exit(0));require('fs').writeFileSync('.blame/ready','yes');setTimeout(()=>{},3000)");
    const workspace = new LightWorkspace(root, { sessionId: "command-interruption" });
    const controller = new AbortController();
    const pending = workspace.runTask({ kind: "project", task: "test" }, { signal: controller.signal });
    await waitFor(join(root, ".blame/ready"));
    controller.abort();
    const result = await pending;
    assert.equal(result.status, "ok", JSON.stringify(result));
    const state = await new SessionJournal(root, "command-interruption").completionSnapshot();
    assert.ok(state.validations.length > 0);
    assert.ok(state.validations.every((value) => value.status === "unknown"));
    assert.match(JSON.stringify(result), /cancelled/u);
  });
});

function run(script: string, options: Partial<Parameters<typeof executeWorkspaceCommand>[2]> = {}) {
  return executeWorkspaceCommand(process.execPath, ["-e", script], { cwd: tmpdir(), ...options });
}

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "blame-command-process-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function waitFor(path: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await readFile(path).then(() => true, () => false)) return;
    await delay(50);
  }
  throw new Error(`Fixture did not become ready: ${path}`);
}

function terminateFixture(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

test("an isolated workspace can configure a repository and run a detached service", { skip: process.platform === "win32" }, async () => {
  await fixture(async (root) => {
    const workspace = new LightWorkspace(root, { sessionId: "isolated-service",
      taskContract: { session_id: "isolated-service", acceptance_criteria: ["Configure the environment"],
        effect_requirement: "none", environment: { isolated: true, managedPreview: false } } });
    const setup = await workspace.runTask({ kind: "command", command: "git init fixture" }, {});
    assert.equal(setup.status, "ok", JSON.stringify(setup));
    await writeFile(join(root, "service.cjs"), "setTimeout(()=>{},3000)");
    const started = performance.now();
    const result = await workspace.runTask({ kind: "command",
      command: "nohup node service.cjs > service.log 2>&1 < /dev/null & echo $! > service.pid" }, {});
    const pid = Number(await readFile(join(root, "service.pid"), "utf8"));
    try {
      assert.equal(result.status, "ok", JSON.stringify(result));
      assert.ok(performance.now() - started < 1500);
      assert.doesNotThrow(() => process.kill(pid, 0));
    } finally {
      terminateFixture(pid);
    }
  });
});
