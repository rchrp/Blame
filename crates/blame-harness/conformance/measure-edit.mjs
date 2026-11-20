#!/usr/bin/env node
// Edits and the compiler side process, Rust harness against the TypeScript
// runner (macOS `footprint` for memory).
//
//   node crates/blame-harness/conformance/measure-edit.mjs [--binary target/release/blame-harness] [--runs 5]
//
// 1. Edits: each implementation works on its own copy of
//    packages/agent-runtime/src/harness (91 TypeScript files, not a git
//    repository): a symbol read, then replace_body and file-patch edits
//    toggled back and forth, TypeScript validation included.
// 2. Side process: a compiler reference query on this monorepo, cold then
//    warm, the memory of the harness, its side process and worker, and the
//    idle stops (worker after 30 s, side process after
//    BLAME_HARNESS_COMPILER_IDLE_MS, here 45 s).

import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const argument = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : fallback;
};
const repository = resolve(new URL("../../..", import.meta.url).pathname);
const binary = resolve(argument("binary", join(repository, "target/release/blame-harness")));
const runs = Number(argument("runs", "5"));
const runner = join(repository, "packages/agent-runtime/dist/harness/semantic-harness-runner.js");
const compiler = JSON.stringify([process.execPath, join(repository, "packages/agent-runtime/dist/harness/rust-harness-compiler.js")]);

function footprint(pid) {
  try {
    const match = /Footprint: ([\d.]+) (KB|MB|GB)/u.exec(execFileSync("footprint", [String(pid)], { encoding: "utf8" }));
    return match ? Number(match[1]) * { KB: 1 / 1024, MB: 1, GB: 1024 }[match[2]] : 0;
  } catch { return 0; }
}
const children = (pid) => {
  try { return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).trim().split("\n").filter(Boolean).map(Number); }
  catch { return []; }
};
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function server(command, args, env = {}) {
  const started = process.hrtime.bigint();
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, ...env } });
  const waiting = new Map();
  let ready;
  const readyAt = new Promise((done) => { ready = done; });
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.ready) return ready(Number(process.hrtime.bigint() - started) / 1e6);
    waiting.get(message.id)?.(message);
  });
  let sequence = 0;
  const send = (tool, input, workspaceRoot, session) => new Promise((done) => {
    const id = `m${++sequence}`;
    const sent = process.hrtime.bigint();
    waiting.set(id, (message) => done({ ms: Number(process.hrtime.bigint() - sent) / 1e6, result: message.result, error: message.error }));
    child.stdin.write(`${JSON.stringify({ id, request: { tool, input, workspaceRoot, taskContract: { session_id: session } } })}\n`);
  });
  return { child, send, readyAt };
}

async function edits(name, command, args, env) {
  const root = mkdtempSync(join(tmpdir(), `measure-edit-${name}-`));
  cpSync(join(repository, "packages/agent-runtime/src/harness"), root, { recursive: true });
  const harness = server(command, args, env);
  await harness.readyAt;
  const session = `edit-${name}`;
  const target = "read-coverage.ts#ReadCoverage.invalidatePath";
  await harness.send("read_code", { target }, root, session);
  const body = (n) => `{\n    for (const [key, entry] of this.entries)\n      if (entry.path === path) this.entries.delete(key);\n    void ${n};\n  }`;
  const patch = (from, to) => `*** Begin Patch\n*** Update File: light-identity.ts\n@@\n-${from}\n+${to}\n*** End Patch`;
  const line = 'export function sha256(value: string | Uint8Array) {';
  const changed = 'export function sha256(value: string | Uint8Array /* measured */) {';
  const timings = { body: [], patch: [] };
  let first;
  for (let round = 0; round < runs; round += 1) {
    const replace = await harness.send("edit_code", { operations: [{ kind: "symbol", target, action: "replace_body", content: body(round) }] }, root, session);
    first ??= replace;
    timings.body.push(replace.ms);
    await harness.send("read_code", { target }, root, session);
    const forward = await harness.send("edit_code", { operations: [{ kind: "patch", patch: patch(round % 2 ? changed : line, round % 2 ? line : changed) }] }, root, session);
    timings.patch.push(forward.ms);
  }
  const memory = footprint(harness.child.pid) + children(harness.child.pid).reduce((sum, pid) => sum + footprint(pid), 0);
  harness.child.stdin.end();
  await new Promise((done) => harness.child.on("close", done));
  rmSync(root, { recursive: true, force: true });
  return { name, first: first.ms, status: first.result?.status ?? first.error, body: median(timings.body), patch: median(timings.patch), memory };
}

const rows = [
  await edits("rust", binary, ["serve"], { BLAME_HARNESS_COMPILER: compiler }),
  await edits("ts", process.execPath, [runner, "--serve"], {}),
];
console.log("| implementation | first replace_body (cold) | replace_body (median) | file patch (median) | footprint after (incl. side process) |");
console.log("| --- | --- | --- | --- | --- |");
for (const row of rows)
  console.log(`| ${row.name} | ${row.first.toFixed(1)} ms (${row.status}) | ${row.body.toFixed(1)} ms | ${row.patch.toFixed(1)} ms | ${row.memory.toFixed(1)} MB |`);

// The side process on this monorepo.
const harness = server(binary, ["serve"], { BLAME_HARNESS_COMPILER: compiler, BLAME_HARNESS_COMPILER_IDLE_MS: "45000" });
const startup = await harness.readyAt;
const session = `side-${process.pid}`;
const query = { query: "packages/agent-runtime/src/harness/light-identity.ts#sha256", mode: "references" };
const before = footprint(harness.child.pid);
const cold = await harness.send("search_code", query, repository, session);
const side = children(harness.child.pid);
const afterCold = { rust: footprint(harness.child.pid), node: side.reduce((sum, pid) => sum + footprint(pid), 0) };
const warm = [];
for (let round = 0; round < runs; round += 1) warm.push((await harness.send("search_code", query, repository, session)).ms);
await sleep(35_000);
const afterWorker = side.reduce((sum, pid) => sum + footprint(pid), 0);
await sleep(15_000);
const alive = children(harness.child.pid).length;
harness.child.stdin.end();
await new Promise((done) => harness.child.on("close", done));
console.log(`side process: harness start-up ${startup.toFixed(1)} ms, harness footprint ${before.toFixed(1)} MB before the first query`);
console.log(`cold reference query ${cold.ms.toFixed(0)} ms (engine ${cold.result?.data?.engine}, ${cold.result?.data?.referenceCount} references; side process + compiler program load), warm median ${median(warm).toFixed(0)} ms`);
console.log(`after the query: harness ${afterCold.rust.toFixed(1)} MB, side process with its worker ${afterCold.node.toFixed(1)} MB`);
console.log(`35 s idle (worker stopped after 30 s): side process ${afterWorker.toFixed(1)} MB; 50 s idle: side processes still running ${alive} (exits after 45 s)`);
// This run's session journal in the monorepo.
const { createHash } = await import("node:crypto");
rmSync(join(repository, ".blame/harness/light", `${createHash("sha256").update(session).digest("hex").slice(0, 24)}.jsonl`), { force: true });
