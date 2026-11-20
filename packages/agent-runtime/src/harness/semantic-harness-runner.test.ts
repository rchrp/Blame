import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

test("terminating a semantic runner cancels its detached workspace command", {
  skip: process.platform === "win32", timeout: 10_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-runner-signal-"));
  let runner: ChildProcess | undefined;
  let commandPid: number | undefined;
  try {
    await writeFile(join(root, "child.cjs"), 'require("node:fs").writeFileSync("child.pid", String(process.pid)); setInterval(() => {}, 1000);');
    runner = startRunner(root);
    const closed = once(runner, "close");
    commandPid = await waitForPid(join(root, "child.pid"));
    runner.kill("SIGTERM");
    const [code] = await closed;
    await waitForStopped(commandPid);
    assert.equal(await running(commandPid), false, "The workspace command survived runner cancellation");
    assert.equal(code, 1);
  } finally {
    if (commandPid && await running(commandPid)) terminate(commandPid);
    if (runner?.pid && runner.exitCode === null && runner.signalCode === null) terminate(runner.pid);
    await rm(root, { recursive: true, force: true });
  }
});

test("a serving harness keeps a session's runs between requests and cancels on request", {
  skip: process.platform === "win32", timeout: 20_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-runner-serve-"));
  const path = fileURLToPath(new URL("./semantic-harness-runner.js", import.meta.url));
  const runner = spawn(process.execPath, [path, "--serve"], { cwd: root, stdio: ["pipe", "pipe", "ignore"] });
  const replies = new Map<string, (value: Record<string, unknown>) => void>();
  let ready!: () => void;
  const readyLine = new Promise<void>((resolve) => { ready = resolve; });
  let buffer = "";
  runner.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
    buffer += chunk;
    for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
      const message = JSON.parse(buffer.slice(0, index)) as Record<string, unknown>;
      buffer = buffer.slice(index + 1);
      if (message.ready) ready();
      else replies.get(String(message.id))?.(message);
    }
  });
  const contract = { session_id: "serve-test", environment: { isolated: true, managedPreview: false } };
  const send = (id: string, input: unknown) => new Promise<Record<string, unknown>>((resolve) => {
    replies.set(id, resolve);
    runner.stdin!.write(`${JSON.stringify({ id, request: { workspaceRoot: root, tool: "run_task", input, taskContract: contract } })}\n`);
  });
  try {
    await readyLine;
    const first = await send("one", { kind: "command", command: "node -e \"console.log('z'.repeat(9000))\"" });
    const run = (first.result as { data: { fullOutput: { run: string } } }).data.fullOutput.run;
    const page = await send("two", { kind: "inspect", run, cursor: "0", until: "now" });
    assert.match(JSON.stringify(page.result), /z{9000}/u, "The second request reads the first one's run.");

    const pending = send("three", { kind: "command", command: "node -e \"setInterval(() => {}, 1000)\"" });
    await delay(300);
    runner.stdin!.write(`${JSON.stringify({ id: "three", cancel: true })}\n`);
    assert.match(String((await pending).error), /cancelled/u);
  } finally {
    runner.stdin!.end();
    if (runner.exitCode === null) runner.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

test("a serving harness describes its model tools and presents a call as the model reads it", {
  skip: process.platform === "win32", timeout: 20_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-runner-engine-"));
  const path = fileURLToPath(new URL("./semantic-harness-runner.js", import.meta.url));
  const runner = spawn(process.execPath, [path, "--serve"], { cwd: root, stdio: ["pipe", "pipe", "ignore"] });
  const replies = new Map<string, (value: Record<string, unknown>) => void>();
  let buffer = "";
  runner.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
    buffer += chunk;
    for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
      const message = JSON.parse(buffer.slice(0, index)) as Record<string, unknown>;
      buffer = buffer.slice(index + 1);
      if (!message.ready) replies.get(String(message.id))?.(message);
    }
  });
  const send = (id: string, body: Record<string, unknown>) => new Promise<Record<string, unknown>>((resolve) => {
    replies.set(id, resolve);
    runner.stdin!.write(`${JSON.stringify({ id, ...body })}\n`);
  });
  const contract = { session_id: "engine-test", environment: { isolated: true, managedPreview: false } };
  try {
    await writeFile(join(root, "note.txt"), "first line\nsecond \"line\"\n");
    const described = await send("d", { describe: { taskContract: contract } });
    const tools = described.tools as Array<{ name: string; effect: string; endsTurn: boolean; inputSchema: { type?: string } }>;
    assert.deepEqual(tools.map(({ name, effect, endsTurn }) => [name, effect, endsTurn]), [
      ["search_code", "read_only", false],
      ["read_code", "read_only", false],
      ["edit_code", "workspace_write", false],
      ["run_task", "command", false],
      ["finish_task", "command", true],
    ]);
    assert.ok(tools.every((tool) => tool.inputSchema.type === "object"), "JSON Schema objects, not zod");

    const call = (id: string, tool: string, input: unknown) =>
      send(id, { call: { tool, input, workspaceRoot: root, taskContract: contract, toolContext: { sessionId: "engine-test", toolCallId: id } } });
    const read = (await call("r", "read_code", { target: "note.txt", view: "raw" })).presented as { ok: boolean; content: unknown };
    assert.equal(read.ok, true);
    assert.ok(Array.isArray(read.content), "text with quotes is sent as fenced sections");
    assert.match(JSON.stringify(read.content), /blame_tool_result_v2/u);

    const invalid = (await call("i", "read_code", { nonsense: true })).presented as { ok: boolean; content: unknown };
    assert.equal(invalid.ok, false);
    assert.match(JSON.stringify(invalid.content), /\\"status\\":\\"blocked\\"/u);
  } finally {
    runner.stdin!.end();
    if (runner.exitCode === null) runner.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

function startRunner(root: string) {
  const path = fileURLToPath(new URL("./semantic-harness-runner.js", import.meta.url));
  const runner = spawn(process.execPath, [path], { cwd: root, stdio: ["pipe", "ignore", "ignore"] });
  runner.stdin.end(JSON.stringify({
    workspaceRoot: root, tool: "run_task", input: { kind: "command", command: "node child.cjs" },
    taskContract: { session_id: "signal-test", environment: { isolated: true, managedPreview: false } },
  }));
  return runner;
}

async function waitForPid(path: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await readFile(path, "utf8").catch(() => "");
    if (/^\d+$/u.test(value)) return Number(value);
    await delay(20);
  }
  throw new Error("Workspace command did not start");
}

async function waitForStopped(pid: number) {
  for (let attempt = 0; attempt < 50 && await running(pid); attempt += 1)
    await delay(20);
}

async function running(pid: number) {
  try { process.kill(pid, 0); } catch { return false; }
  if (process.platform !== "linux") return true;
  const status = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
  return Boolean(status) && !/^\d+ \(.*\) Z /u.test(status);
}

function terminate(pid: number) {
  try { process.kill(pid, "SIGKILL"); } catch { return; }
}
