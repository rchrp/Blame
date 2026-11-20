#!/usr/bin/env node
// The harness's behavioural suite, file by file, against one blame-harness
// binary: packages/agent-runtime's harness test files (built in dist/) drive
// it through their test client (src/harness/test-client/), and this prints,
// per file, the passing and failing tests.
//
// Usage (from the repository root, after `pnpm --filter @blame/agent-runtime build`
// and `cargo build --release -p blame-harness`):
//   node crates/blame-harness/conformance/run.mjs [--binary target/release/blame-harness]
//     [--files a,b] [--json out.json] [--jobs 4]

import { spawn } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const argument = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : fallback;
};
const repository = resolve(new URL("../../..", import.meta.url).pathname);
const runtime = join(repository, "packages/agent-runtime");
const binary = resolve(argument("binary", join(repository, "target/release/blame-harness")));
const jobs = Number(argument("jobs", "4"));
const only = argument("files")?.split(",");
const files = readdirSync(join(runtime, "dist/harness"))
  .filter((name) => name.endsWith(".test.js"))
  .map((name) => name.replace(/\.test\.js$/u, ""))
  .filter((name) => !only || only.includes(name))
  .sort();

function runFile(file) {
  return new Promise((done) => {
    const env = { ...process.env, BLAME_HARNESS_BIN: binary };
    delete env.NODE_OPTIONS;
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", `dist/harness/${file}.test.js`], {
      cwd: runtime, env, stdio: ["ignore", "pipe", "pipe"],
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

const results = {};
const queue = [...files];
await Promise.all(Array.from({ length: jobs }, async () => {
  for (let file = queue.shift(); file; file = queue.shift()) {
    const started = Date.now();
    results[file] = await runFile(file);
    process.stderr.write(`${file} ${JSON.stringify({ ...results[file], failed: undefined })} ${Date.now() - started} ms\n`);
  }
}));

const output = argument("json");
if (output) writeFileSync(output, `${JSON.stringify(results, null, 1)}\n`);
console.log("| file | pass | fail | skipped |");
console.log("| --- | --- | --- | --- |");
for (const file of files) {
  const { pass, fail, skipped } = results[file];
  console.log(`| ${file} | ${pass} | ${fail} | ${skipped} |`);
}
for (const file of files)
  for (const failure of results[file].failed) console.log(`${file}: ${failure.name} — ${failure.error}`);
process.exitCode = files.some((file) => results[file].fail) ? 1 : 0;
