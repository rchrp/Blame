#!/usr/bin/env node
// Latency and memory of representative search_code/read_code calls, Rust
// harness against the TypeScript runner, on one workspace (this monorepo by
// default). macOS only for memory: it samples `footprint` (dirty memory of
// the process). The TypeScript side also reports its V8 heap after a GC.
//
//   node crates/blame-harness/conformance/measure.mjs [--root .] [--binary target/release/blame-harness] [--runs 5]
//
// Each implementation starts fresh, with its own session journal (removed
// afterwards). The first round includes start-up and cold caches; later
// rounds repeat the same calls warm and report their median.

import { execFileSync, spawn } from "node:child_process";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const argument = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : fallback;
};
const repository = resolve(new URL("../../..", import.meta.url).pathname);
const root = resolve(argument("root", repository));
const binary = resolve(argument("binary", join(repository, "target/release/blame-harness")));
const runs = Number(argument("runs", "5"));
const runner = join(repository, "packages/agent-runtime/dist/harness/semantic-harness-runner.js");

const calls = [
  ["search auto (symbol + declarations)", "search_code", { query: "parseCode" }],
  ["search text, two terms", "search_code", { query: "snapshot revision" }],
  ["search regex", "search_code", { query: "fn \\w+_range", mode: "regex" }],
  ["search files output", "search_code", { query: "LightWorkspace", output: "files" }],
  ["search symbol mode", "search_code", { query: "sourceRevision", mode: "symbol" }],
  ["read folded file", "read_code", { target: "packages/agent-runtime/src/harness/light-workspace.ts" }],
  ["read path#symbol", "read_code", { target: "packages/agent-runtime/src/harness/code-intelligence.ts#parseCode" }],
  ["read line range", "read_code", { target: "crates/README.md", range: { startLine: 1, endLine: 30 } }],
  ["read directory", "read_code", { target: "packages/agent-runtime/src/harness" }],
];

const probe = join(tmpdir(), "blame-harness-heap-probe.mjs");
writeFileSync(probe, `process.on("SIGUSR2", () => { globalThis.gc?.(); process.stderr.write("HEAP " + JSON.stringify(process.memoryUsage()) + "\\n"); });\n`);

function descendants(pid) {
  try { return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).trim().split("\n").filter(Boolean).map(Number); }
  catch { return []; }
}

function footprint(pid) {
  try {
    const output = execFileSync("footprint", [String(pid)], { encoding: "utf8" });
    const match = /Footprint: ([\d.]+) (KB|MB|GB)/u.exec(output);
    if (!match) return undefined;
    return Number(match[1]) * { KB: 1 / 1024, MB: 1, GB: 1024 }[match[2]];
  } catch { return undefined; }
}

async function measure(name, command, args, session) {
  const started = process.hrtime.bigint();
  const child = spawn(command, args, { cwd: repository, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const waiting = new Map();
  let ready;
  const readyLine = new Promise((resolveReady) => { ready = resolveReady; });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.ready) return ready(process.hrtime.bigint());
    waiting.get(message.id)?.(message);
  });
  let heap;
  child.stderr.on("data", (chunk) => {
    const match = /HEAP (.*)/u.exec(String(chunk));
    if (match) heap = JSON.parse(match[1]);
  });
  const startup = Number((await readyLine) - started) / 1e6;
  let sequence = 0;
  const send = (tool, input) => new Promise((done) => {
    const id = `m${++sequence}`;
    const sent = process.hrtime.bigint();
    waiting.set(id, (message) => done({ ms: Number(process.hrtime.bigint() - sent) / 1e6, bytes: JSON.stringify(message.result ?? message.error).length, status: message.result?.status ?? "error", result: message.result }));
    child.stdin.write(`${JSON.stringify({ id, request: { tool, input, workspaceRoot: root, taskContract: { session_id: session } } })}\n`);
  });
  const rounds = [];
  let peak = 0;
  for (let round = 0; round <= runs; round += 1) {
    const results = [];
    for (const [, tool, input] of calls) {
      const answer = await send(tool, input);
      // The harness and its compiler side process, if it started one.
      answer.footprint = (footprint(child.pid) ?? 0) + descendants(child.pid).reduce((sum, pid) => sum + (footprint(pid) ?? 0), 0);
      peak = Math.max(peak, answer.footprint);
      results.push(answer);
    }
    rounds.push(results);
  }
  if (command === process.execPath) {
    child.kill("SIGUSR2");
    await new Promise((done) => setTimeout(done, 300));
  }
  const final = footprint(child.pid);
  child.stdin.end();
  await new Promise((done) => child.on("close", done));
  return { name, startup, rounds, peak, final, heap };
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const results = [
  await measure("rust", binary, ["serve", "--compiler-command", JSON.stringify([process.execPath, join(repository, "packages/agent-runtime/dist/harness/rust-harness-compiler.js")])], `measure-rust-${process.pid}`),
  await measure("ts", process.execPath, ["--expose-gc", `--import=${probe}`, runner, "--serve"], `measure-ts-${process.pid}`),
];
// The journals the two sessions wrote.
const journals = join(root, ".blame/harness/light");
for (const file of readdirSync(journals, { withFileTypes: true }))
  if (file.isFile() && file.name.endsWith(".jsonl")) {
    // Only this run's sessions: their names are the hash of the session id.
    const { createHash } = await import("node:crypto");
    const ours = ["rust", "ts"].map((kind) => createHash("sha256").update(`measure-${kind}-${process.pid}`).digest("hex").slice(0, 24));
    if (ours.some((hash) => file.name.startsWith(hash))) rmSync(join(journals, file.name));
  }

console.log(`workspace ${root}`);
// What the model would read, compared on the first round (the diagnostic id
// is time-based; `links` come from the compiler tier, not ported).
const comparable = (value, links) => JSON.stringify(value, (key, item) => key === "diagnosticId" ? undefined : key === "links" && !links ? undefined : item);
const verdict = (index) => {
  const [rust, ts] = results.map((result) => result.rounds[0][index].result);
  if (comparable(rust, true) === comparable(ts, true)) return "identical";
  return comparable(rust, false) === comparable(ts, false) ? "identical but links" : "different";
};
console.log("| call | rust first | rust warm (median) | ts first | ts warm (median) | result | footprint after first rust/ts |");
console.log("| --- | --- | --- | --- | --- | --- | --- |");
calls.forEach(([label], index) => {
  const [rust, ts] = results.map((result) => ({ first: result.rounds[0][index], warm: median(result.rounds.slice(1).map((round) => round[index].ms)) }));
  console.log(`| ${label} | ${rust.first.ms.toFixed(1)} ms | ${rust.warm.toFixed(1)} ms | ${ts.first.ms.toFixed(1)} ms | ${ts.warm.toFixed(1)} ms | ${verdict(index)} | ${rust.first.footprint.toFixed(1)}/${ts.first.footprint.toFixed(1)} MB |`);
});
for (const result of results)
  console.log(`${result.name}: start-up ${result.startup.toFixed(1)} ms, footprint peak ${result.peak.toFixed(1)} MB, final ${result.final?.toFixed(1)} MB${result.heap ? `, V8 heap used after GC ${(result.heap.heapUsed / 1048576).toFixed(1)} MB` : ""}`);
