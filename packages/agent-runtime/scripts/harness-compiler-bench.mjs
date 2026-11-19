#!/usr/bin/env node
// CPU and memory of the semantic harness's compiler-backed searches, measured
// in this process (process.cpuUsage counts every thread, compiler workers
// included; git child processes are not counted).
//
//   node scripts/harness-compiler-bench.mjs <scenario> [--dist <dir>] [--settle-ms <ms,...>] <worktree>...
//
// Scenarios:
//   burst    one agent's burst of searches in the first worktree
//   stories  the same burst in every worktree at once, one workspace each
//   index    the import index built in each worktree, one after the other
//
// The worktrees are checkouts of this repository with installed
// dependencies. Compare builds by passing another --dist (a copy of `dist`
// inside this package, so it resolves the same node_modules) and alternate
// runs of the two: the Mac's load changes CPU times between runs.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  if (at < 0) return fallback;
  const [value] = args.splice(at, 2).slice(1);
  return value;
};
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const dist = resolve(packageRoot, option("--dist", "dist"));
// Memory samples after the scenario, at these delays (ms, comma-separated).
const settleMs = option("--settle-ms", "").split(",").filter(Boolean).map(Number);
const [scenario, ...roots] = args;
if (!["burst", "stories", "index"].includes(scenario) || !roots.length)
  throw new Error("Usage: harness-compiler-bench.mjs burst|stories|index [--dist dir] [--settle-ms ms,...] <worktree>...");

const load = (path) => import(pathToFileURL(join(dist, path)).href);
const { LightWorkspace } = await load("harness/light-workspace.js");

// Three functions of one file, installed declarations read from two
// consumers, then an edit of the project and one more search: what an agent
// asks before and while changing a shared helper. The edit is undone after.
const file = "packages/agent-runtime/src/harness/workspace-files.ts";
const edited = "packages/agent-runtime/src/harness/light-identity.ts";
const burst = [
  { tool: "search", query: `${file}#languageName` },
  { tool: "search", query: `${file}#assertMutableWorkspacePath` },
  { tool: "search", query: `${file}#WorkspaceFiles` },
  { tool: "read", target: "packages/agent-runtime/src/harness/import-index.ts#ts.createSourceFile" },
  { tool: "read", target: "packages/agent-runtime/src/harness/light-dependency-read.ts#realpath" },
  { tool: "edit", path: edited },
  { tool: "search", query: `${file}#languageName` },
];

let peakRss = 0;
const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage.rss()); }, 10);
const cpuMs = (since) => {
  const { user, system } = process.cpuUsage(since);
  return Math.round((user + system) / 1000);
};
// This thread only: the rest of the process time is the compiler workers'.
const mainCpuMs = (since) => {
  const { user, system } = process.threadCpuUsage(since);
  return Math.round((user + system) / 1000);
};
// The macOS footprint counts compressed pages, unlike RSS (Linux: RSS).
const footprintMb = () => {
  if (process.platform !== "darwin") return Math.round(process.memoryUsage.rss() / 2 ** 20);
  const output = execFileSync("footprint", ["-p", String(process.pid)], { encoding: "utf8" });
  const match = /Footprint:\s+([\d.]+)\s+(KB|MB|GB)/u.exec(output);
  if (!match) return undefined;
  return Math.round(Number(match[1]) * { KB: 1 / 1024, MB: 1, GB: 1024 }[match[2]]);
};
// A live compiler worker shows as threads of its own.
const threads = () => process.platform === "darwin"
  ? execFileSync("ps", ["-M", "-p", String(process.pid)], { encoding: "utf8" }).trim().split("\n").length - 1
  : Number(/Threads:\s+(\d+)/u.exec(readFileSync("/proc/self/status", "utf8"))?.[1]);
const memory = () => {
  const { rss, heapUsed, external } = process.memoryUsage();
  const mb = (bytes) => Math.round(bytes / 2 ** 20);
  return { footprintMb: footprintMb(), rssMb: mb(rss), mainHeapMb: mb(heapUsed), mainExternalMb: mb(external), threads: threads() };
};

async function runBurst(root) {
  const workspace = new LightWorkspace(root, { sessionId: "harness-compiler-bench" });
  const calls = [];
  const original = await readFile(join(root, edited));
  try {
    for (const step of burst) calls.push(...await runStep(workspace, root, step));
  } finally {
    await writeFile(join(root, edited), original);
  }
  return calls;
}

async function runStep(workspace, root, step) {
  if (step.tool === "edit") {
    await appendFile(join(root, step.path), "\n// edited by the bench\n");
    return [];
  }
  const cpu = process.cpuUsage();
  const main = process.threadCpuUsage();
  const result = step.tool === "search"
    ? await workspace.searchCode({ query: step.query, mode: "references" })
    : await workspace.readCode({ target: step.target, view: "declaration" }, {});
  const data = result.data ?? {};
  return [{
    step: step.query ?? step.target,
    status: result.status,
    engine: data.engine,
    ...(data.semanticFallback ? { fallback: data.semanticFallback } : {}),
    ...(data.referenceCount !== undefined ? { references: data.referenceCount } : {}),
    loadedFiles: data.project?.loadedFiles,
    cpuMs: cpuMs(cpu),
    mainCpuMs: mainCpuMs(main),
    ...(result.status !== "ok" ? { message: String(result.message ?? "").slice(0, 160) } : {}),
  }];
}

async function runIndex(root) {
  const { ImportIndex } = await load("harness/import-index.js");
  const { WorkspaceFiles } = await load("harness/workspace-files.js");
  const files = new WorkspaceFiles(root);
  const snapshot = await files.snapshot();
  const index = new ImportIndex(files);
  const content = await readFile(join(root, file));
  const cpu = process.cpuUsage();
  const started = performance.now();
  // A cold index answers nothing until built; wait for the build itself.
  await index.briefLinks(file, content, new Set(), undefined, { snapshot });
  await index.building;
  const links = await index.briefLinks(file, content, new Set(), undefined, { snapshot });
  return { root, cpuMs: cpuMs(cpu), wallMs: Math.round(performance.now() - started), linked: Boolean(links), index };
}

const before = memory();
const cpu = process.cpuUsage();
const main = process.threadCpuUsage();
const started = performance.now();
let result;
if (scenario === "burst") result = { calls: await runBurst(roots[0]) };
else if (scenario === "stories") result = { stories: await Promise.all(roots.map(runBurst)) };
else {
  const builds = [];
  for (const root of roots) builds.push(await runIndex(root));
  result = { builds: builds.map(({ index: _index, ...rest }) => rest) };
  globalThis.keep = builds;
}
const report = {
  scenario,
  dist: dist.slice(packageRoot.length),
  cpuMs: cpuMs(cpu),
  mainCpuMs: mainCpuMs(main),
  wallMs: Math.round(performance.now() - started),
  memory: { before, after: memory(), peakRssMb: Math.round(peakRss / 2 ** 20) },
  ...result,
};
const ended = performance.now();
report.memory.settled = [];
for (const delay of settleMs) {
  await new Promise((done) => setTimeout(done, Math.max(0, ended + delay - performance.now())));
  report.memory.settled.push({ afterMs: delay, ...memory() });
}
clearInterval(sampler);
console.log(JSON.stringify(report));
process.exit(0);
