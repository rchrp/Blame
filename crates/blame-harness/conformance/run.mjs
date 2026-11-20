#!/usr/bin/env node
// Conformance of the Rust harness with the TypeScript harness.
//
// Runs packages/agent-runtime's harness test files (built in dist/) in three
// modes and prints, per file, the passing and failing tests:
// - ts: the tests as they are, against the TypeScript workspace;
// - rust: the tests drive the Rust binary (rust-harness-adapter.ts);
// - compare: the tests run on TypeScript while every search_code/read_code
//   also runs in Rust and is compared byte for byte.
//
// Usage (from the repository root, after `pnpm --filter @blame/agent-runtime build`
// and `cargo build --release -p blame-harness`):
//   node crates/blame-harness/conformance/run.mjs [--binary target/release/blame-harness]
//     [--modes ts,rust,compare] [--files a,b] [--json out.json] [--jobs 4]

import { spawn } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const argument = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : fallback;
};
const repository = resolve(new URL("../../..", import.meta.url).pathname);
const runtime = join(repository, "packages/agent-runtime");
const binary = resolve(argument("binary", join(repository, "target/release/blame-harness")));
const modes = argument("modes", "ts,rust,compare").split(",");
const jobs = Number(argument("jobs", "4"));
const only = argument("files")?.split(",");
const files = readdirSync(join(runtime, "dist/harness"))
  .filter((name) => name.endsWith(".test.js"))
  .map((name) => name.replace(/\.test\.js$/u, ""))
  .filter((name) => !only || only.includes(name))
  .sort();
const scratch = mkdtempSync(join(tmpdir(), "harness-conformance-"));
const register = join(runtime, "dist/harness/rust-harness-register.js");

function environment(mode, file) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  if (mode === "ts") return env;
  env.BLAME_HARNESS_RUST_BINARY = binary;
  if (mode === "rust") env.BLAME_HARNESS_RUST = binary;
  else env.BLAME_HARNESS_COMPARE = join(scratch, `${file}.compare.jsonl`);
  return env;
}

function runFile(mode, file) {
  return new Promise((done) => {
    // The hooks go on the test runner's command line, which it passes to each
    // test file's process: through NODE_OPTIONS they also reached the pnpm and
    // Prettier processes the tests start, which cannot resolve them.
    const hooks = mode === "ts" ? [] : [`--import=${register}`];
    const child = spawn(process.execPath, [...hooks, "--test", "--test-reporter=tap", `dist/harness/${file}.test.js`], {
      cwd: runtime, env: environment(mode, file), stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", () => {});
    const timer = setTimeout(() => child.kill("SIGKILL"), 15 * 60_000);
    child.on("close", () => {
      clearTimeout(timer);
      const count = (name) => Number(new RegExp(`^# ${name} (\\d+)`, "mu").exec(output)?.[1] ?? 0);
      // Top-level tests only: subtests are indented.
      const failed = [...output.matchAll(/^not ok \d+ - (.*)$/gmu)].map((match) => {
        // The YAML block after a failure: its first error line says why.
        const block = output.slice(match.index).split("\n  ...")[0];
        const error = /^  error: (?:\|-\n\s*)?'?(.*?)'?$/mu.exec(block)?.[1] ?? "";
        return { name: match[1], error: error.slice(0, 200) };
      });
      done({ pass: count("pass"), fail: count("fail"), skipped: count("skipped"), failed });
    });
  });
}

function compareSummary(file) {
  let lines = [];
  try { lines = readFileSync(join(scratch, `${file}.compare.jsonl`), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
  catch { return undefined; }
  const summary = { calls: lines.length, equal: 0, links_only: 0, different: 0, rust_error: 0, skipped_after_edit: 0, examples: [] };
  for (const line of lines) {
    summary[line.outcome] += 1;
    if ((line.outcome === "different" || line.outcome === "rust_error") && summary.examples.length < 3) summary.examples.push(line);
  }
  return summary;
}

const results = Object.fromEntries(files.map((file) => [file, {}]));
const queue = modes.flatMap((mode) => files.map((file) => ({ mode, file })));
await Promise.all(Array.from({ length: jobs }, async () => {
  for (let next = queue.shift(); next; next = queue.shift()) {
    const started = Date.now();
    results[next.file][next.mode] = await runFile(next.mode, next.file);
    if (next.mode === "compare") results[next.file].comparison = compareSummary(next.file);
    process.stderr.write(`${next.mode.padEnd(7)} ${next.file} ${JSON.stringify({ ...results[next.file][next.mode], failed: undefined })} ${Date.now() - started} ms\n`);
  }
}));

const output = argument("json");
if (output) writeFileSync(output, `${JSON.stringify(results, null, 1)}\n`);
const cell = (result) => result ? `${result.pass}/${result.pass + result.fail}` : "";
console.log("| file | ts | rust | compare | compared calls | equal | links only | different | rust error | after edit |");
console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const file of files) {
  const { ts, rust, compare, comparison: c } = results[file];
  console.log(`| ${file} | ${cell(ts)} | ${cell(rust)} | ${cell(compare)} | ${c?.calls ?? ""} | ${c?.equal ?? ""} | ${c?.links_only ?? ""} | ${c?.different ?? ""} | ${c?.rust_error ?? ""} | ${c?.skipped_after_edit ?? ""} |`);
}
if (!process.argv.includes("--keep")) rmSync(scratch, { recursive: true, force: true });
else console.error(`compare logs kept in ${scratch}`);
