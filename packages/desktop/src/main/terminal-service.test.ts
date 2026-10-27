import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { writeProjectCommand } from "../../../app/src/components/backlog/board/project-runner-terminal.ts";
import { terminalShell } from "./terminal-shell.ts";

test("the project runner starts a native pnpm dev server through the terminal", {
  timeout: 40_000,
}, async (t) => {
  const { spawn } = createRequire(import.meta.url)("node-pty") as typeof import("node-pty");
  let pty: import("node-pty").IPty | undefined;
  let data: { dispose(): void } | undefined;
  const root = await realpath(await mkdtemp(join(tmpdir(), "blame service [test] & ")));
  let childPid: number | undefined;
  let output = "";
  t.after(async () => {
    try { pty?.kill(); } catch {}
    // Own only this fixture's child; never leave a dev server behind on failure.
    if (childPid) { try { process.kill(childPid); } catch {} }
    data?.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const readyFile = join(root, "ready.json");
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "native-service-fixture",
    private: true,
    scripts: { dev: "node server.cjs" },
  }));
  await writeFile(join(root, "server.cjs"), `
const http = require("node:http");
const fs = require("node:fs");
const server = http.createServer((request, response) => response.end("native-service-ok"));
server.listen(0, "127.0.0.1", () => {
  fs.writeFileSync("ready.json", JSON.stringify({ port: server.address().port, pid: process.pid, cwd: process.cwd() }));
  console.log("native-service-ready");
});
`);
  const shell = terminalShell(root);
  assert.equal(shell.runtime, false);
  pty = spawn(shell.command, shell.args, {
    cwd: root,
    cols: 120,
    rows: 32,
    env: Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)) as Record<string, string>,
    name: "xterm-256color",
  });
  data = pty.onData((chunk) => { output = (output + chunk).slice(-12_000); });

  // This is the same write path used by the header's service manager, sent
  // immediately after terminal.start (no prompt detection or fixed delay).
  await writeProjectCommand({ write: async ({ data }) => {
    pty!.write(data);
    return true;
  } }, "fixture", "pnpm dev");

  let ready: { port: number; pid: number; cwd: string } | undefined;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !ready) {
    try { ready = JSON.parse(await readFile(readyFile, "utf8")); } catch {}
    if (!ready) await delay(50);
  }
  assert.ok(ready, `pnpm dev never started its server. Terminal output:\n${output}`);
  childPid = ready.pid;
  assert.equal(await realpath(ready.cwd), root);
  const response = await fetch(`http://127.0.0.1:${ready.port}`, { signal: AbortSignal.timeout(3_000) });
  assert.equal(await response.text(), "native-service-ok");
});
