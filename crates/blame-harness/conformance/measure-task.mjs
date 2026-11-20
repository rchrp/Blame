#!/usr/bin/env node
// run_task and finish_task, Rust harness against the TypeScript runner
// (macOS `footprint` for memory).
//
//   node crates/blame-harness/conformance/measure-task.mjs [--binary target/release/blame-harness] [--runs 5]
//
// Each implementation works on its own copy of a small npm project (a git
// repository with node --test tests and a build script) and repeats the same
// calls: a literal command, a project test task (check observation and its
// journal entry), a build task, a routed shell inspection, a read-only `ls`,
// a Prettier-free failing command (failure assessment) and finish_task after
// an edit (it reruns the build on the final source). The first round
// includes start-up and cold caches; the table shows the warm median.
// Footprint: the harness and its side processes after the rounds.

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
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
const harnessDist = join(repository, "packages/agent-runtime/dist/harness");
const rustEnvironment = {
  BLAME_HARNESS_COMPILER: JSON.stringify([process.execPath, join(harnessDist, "rust-harness-compiler.js")]),
  BLAME_HARNESS_NODE_ASSETS: harnessDist,
  BLAME_HARNESS_NODE_MODULES: join(repository, "packages/agent-runtime/node_modules"),
};

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

function project() {
  const root = mkdtempSync(join(tmpdir(), "measure-task-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "measured", private: true, type: "module",
    scripts: { test: "node --test", build: "node build.js" },
  }, null, 2));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/math.js"), "export function add(a, b) {\n  return a + b;\n}\n");
  writeFileSync(join(root, "build.js"), "import { add } from './src/math.js';\nif (add(1, 2) !== 3) process.exit(1);\nconsole.log('built');\n");
  writeFileSync(join(root, "math.test.js"), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add } from './src/math.js';",
    ...Array.from({ length: 12 }, (_, index) => `test('adds ${index}', () => assert.equal(add(${index}, 1), ${index + 1}));`),
    "",
  ].join("\n"));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git("add", ".");
  git("-c", "user.name=Measure", "-c", "user.email=measure@example.invalid", "commit", "-qm", "fixture");
  return root;
}

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
    child.stdin.write(`${JSON.stringify({ id, request: { tool, input, workspaceRoot, taskContract: { session_id: session }, toolContext: { toolCallId: id } } })}\n`);
  });
  return { child, send, readyAt };
}

const calls = [
  ["literal command (node -e)", "run_task", { command: "node -e \"console.log(40 + 2)\"" }],
  ["project test task (12 node tests)", "run_task", { kind: "project", task: "test" }],
  ["project build task", "run_task", { kind: "project", task: "build" }],
  ["routed inspection (grep -rn)", "run_task", { command: "grep -rn 'add(' src" }],
  ["read-only command (ls)", "run_task", { command: "ls -la" }],
  ["failing command (assessment)", "run_task", { command: "node -e \"process.exit(3)\"" }],
];

async function measure(name, command, args, env) {
  const root = project();
  const harness = server(command, args, env);
  const startup = await harness.readyAt;
  const session = `task-${name}`;
  const rounds = [];
  let finish = [];
  let statuses = [];
  for (let round = 0; round <= runs; round += 1) {
    const times = [];
    for (const [, tool, input] of calls) {
      const answer = await harness.send(tool, input, root, session);
      times.push(answer.ms);
      if (round === 0) statuses.push(answer.result?.status ?? answer.error);
    }
    // finish_task after an edit: the final build runs on the edited source.
    writeFileSync(join(root, "src/math.js"), `export function add(a, b) {\n  return a + b; // ${round}\n}\n`);
    const finished = await harness.send("finish_task", { summary: `round ${round}` }, root, `${session}-finish-${round}`);
    finish.push(finished.ms);
    if (round === 0) statuses.push(finished.result?.status ?? finished.error);
    rounds.push(times);
  }
  const memory = footprint(harness.child.pid) + children(harness.child.pid).reduce((sum, pid) => sum + footprint(pid), 0);
  harness.child.stdin.end();
  await new Promise((done) => harness.child.on("close", done));
  rmSync(root, { recursive: true, force: true });
  return { name, startup, rounds, finish, memory, statuses };
}

const results = [
  await measure("rust", binary, ["serve"], rustEnvironment),
  await measure("ts", process.execPath, [runner, "--serve"], {}),
];
console.log("| call | rust first | rust warm (median) | ts first | ts warm (median) |");
console.log("| --- | --- | --- | --- | --- |");
const labels = [...calls.map(([label]) => label), "finish_task after an edit (reruns the build)"];
labels.forEach((label, index) => {
  const [rust, ts] = results.map((result) => {
    const series = index < calls.length ? result.rounds.map((round) => round[index]) : result.finish;
    return { first: series[0], warm: median(series.slice(1)) };
  });
  console.log(`| ${label} | ${rust.first.toFixed(1)} ms | ${rust.warm.toFixed(1)} ms | ${ts.first.toFixed(1)} ms | ${ts.warm.toFixed(1)} ms |`);
});
for (const result of results)
  console.log(`${result.name}: start-up ${result.startup.toFixed(1)} ms, footprint after ${result.memory.toFixed(1)} MB, first-round statuses ${result.statuses.join(",")}`);
