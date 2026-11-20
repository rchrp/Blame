import { createHash } from "node:crypto";
import { spawn, execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile, symlink, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { performance } from "node:perf_hooks";
import { reconcileUsage } from "../corpus/light-study-accounting.mjs";

const repo = resolve(new URL("../../..", import.meta.url).pathname);
const study = join(repo, "docs/experiments/light-harness-npm-formatter-confirmation-2026-10-11");
const work = join(repo, ".blame/research/npm-formatter-confirmation");
const upstream = join(work, "date-fns");
const campaign = join(work, "pilot");
const protocol = JSON.parse(await readFile(join(study, "protocol.json"), "utf8"));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const writeJson = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + "\n");
const git = (args, cwd = repo) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
async function tree(path) {
  const hash = createHash("sha256");
  for (const entry of (await readdir(path, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath ?? entry.path, entry.name)).sort()) {
    hash.update("/" + entry.slice(path.length + 1) + "\0"); hash.update(await readFile(entry));
  }
  return hash.digest("hex");
}
async function bindings() {
  const inputs = {};
  for (const path of [
    "tools/terminal_bench/npm-formatter-confirmation/run.mjs", "tools/terminal_bench/npm-formatter-confirmation/feature-checks.ts",
    "tools/terminal_bench/npm-formatter-confirmation/run.py",
    "tools/terminal_bench/corpus/light-study-accounting.mjs",
    "docs/experiments/light-harness-npm-formatter-confirmation-2026-10-11/protocol.json",
    "pnpm-lock.yaml", "packages/agent-runtime/dist/usage-audit.js",
  ]) inputs[path] = sha(await readFile(join(repo, path)));
  const versions = {};
  for (const arm of ["baseline", "modified"]) {
    const directory = join(work, "frozen", arm);
    versions[arm] = {
      runtime: await tree(join(directory, "agent-runtime/dist")),
      runner: await tree(join(directory, "benchmark-runner/dist")),
      source: JSON.parse(await readFile(join(directory, "version.json"), "utf8")),
    };
  }
  return { inputs, versions, sharedCore: await tree(join(repo, "packages/harness-core/dist")),
    upstream: git(["rev-parse", "HEAD"], upstream).trim(),
    upstreamLock: sha(await readFile(join(upstream, "package-lock.json"))),
    upstreamArchiveSha256: sha(execFileSync("git", ["archive", "HEAD"], { cwd: upstream, maxBuffer: 16 * 1024 * 1024 })),
    node: process.version, vitest: JSON.parse(await readFile(join(upstream, "node_modules/vitest/package.json"))).version,
    typescript: JSON.parse(await readFile(join(upstream, "node_modules/typescript/package.json"))).version };
}
async function verifyBindings() {
  const expected = JSON.parse(await readFile(join(study, "execution-bindings.json"), "utf8"));
  const actual = await bindings();
  if (git(["diff", "HEAD", "--"], upstream)) throw new Error("Upstream source workspace changed");
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Frozen execution bindings changed");
  for (const [name, value] of Object.entries({
    BLAME_MODEL_ID: protocol.model, BLAME_REASONING_EFFORT: protocol.effort,
    BLAME_PROVIDER_ID: protocol.provider, BLAME_API_URL: protocol.apiUrl,
  })) if (process.env[name] !== value) throw new Error(name + " differs from preregistration");
  if (!process.env.BLAME_API_TOKEN) throw new Error("Credential unavailable");
  return expected;
}
async function executeModel(args, directory) {
  return new Promise((done) => {
    const child = spawn(process.execPath, args, {
      cwd: repo, detached: true, stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, BLAME_HEADLESS_DEV: "true", NODE_ENV: "development",
        NODE_USE_ENV_PROXY: "1", TZ: "UTC",
        BLAME_AGENT_MAX_SESSION_COST_USD: String(protocol.budgets.perTrialSdkCostLimitUsd) },
    });
    let stderr = "", watchdog = false, settled = false;
    const timer = setTimeout(() => { watchdog = true; process.kill(-child.pid, "SIGKILL"); },
      (protocol.budgets.timeoutSeconds + protocol.budgets.outerWatchdogExtraSeconds) * 1000);
    const finish = (exit) => {
      if (settled) return; settled = true; clearTimeout(timer);
      done({ ...exit, watchdog, stderr: stderr.replaceAll(process.env.BLAME_API_TOKEN, "[REDACTED]") });
    };
    child.stderr.on("data", (data) => { if (stderr.length < 4096) stderr += data.toString(); });
    child.once("error", (error) => finish({ error: error.message, code: null }));
    child.once("close", (code, signal) => finish({ code, signal }));
  });
}
function runCheck(argv, cwd, timeout = 120000, extraEnv = {}) {
  const started = performance.now();
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd, encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, TZ: "UTC", ...extraEnv },
  });
  return { argv, cwd, exitCode: result.status, signal: result.signal,
    error: result.error?.code ?? null, durationMs: performance.now() - started,
    stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
async function score(directory, workspace, task) {
  const feature = runCheck([process.execPath, join(upstream, "node_modules/tsx/dist/cli.mjs"),
    join(repo, "tools/terminal_bench/npm-formatter-confirmation/feature-checks.ts"), workspace, task.id], repo, 10000);
  let featureChecks = [];
  try { featureChecks = JSON.parse(feature.stdout.trim()).checks; } catch {}
  const nonUtcFeature = runCheck([process.execPath, join(upstream, "node_modules/tsx/dist/cli.mjs"),
    join(repo, "tools/terminal_bench/npm-formatter-confirmation/feature-checks.ts"), workspace, task.id], repo, 10000,
    { TZ: "America/New_York" });
  try { featureChecks.push(...JSON.parse(nonUtcFeature.stdout.trim()).checks
    .map((check) => ({ ...check, name: "non-UTC:" + check.name }))); } catch {}
  const selected = runCheck(["npm", "test", "--", "--maxWorkers=1", "--minWorkers=1", "--pool=forks",
    "src/formatISO9075/test.ts", "src/formatISODuration/test.ts", "src/eachDayOfInterval/test.ts"], workspace);
  const types = runCheck(["npm", "run", "types"], workspace);
  const full = runCheck(["npm", "test", "--", "--maxWorkers=1", "--minWorkers=1", "--pool=forks"], workspace);
  const paths = git(["status", "--porcelain", "--untracked-files=all"], workspace)
    .trimEnd().split("\n").filter(Boolean).map((line) => line.slice(3));
  const unexpected = paths.filter((path) => !task.allowedPaths.includes(path));
  const score = { featureChecks, featureInvocation: feature, nonUtcFeatureInvocation: nonUtcFeature, selected, types, full,
    changedPaths: paths, unexpectedPaths: unexpected,
    sourceSha256: Object.fromEntries(await Promise.all(task.allowedPaths.map(async (path) =>
      [path, sha(await readFile(join(workspace, path)))]))),
    independentFunctionalSuccess: feature.exitCode === 0 && nonUtcFeature.exitCode === 0 && featureChecks.length > 0 &&
      featureChecks.every((check) => check.passed) && selected.exitCode === 0 && types.exitCode === 0 &&
      full.exitCode === 0 && unexpected.length === 0 };
  await writeJson(join(directory, "score.json"), score);
  return score;
}
async function run() {
  const frozen = await verifyBindings();
  await mkdir(campaign);
  const order = [];
  for (let repetition = 1; repetition <= protocol.repetitions; repetition++) {
    const tasks = repetition === 1 ? protocol.tasks : [...protocol.tasks].reverse();
    for (const task of tasks) {
      const index = protocol.tasks.indexOf(task);
      let arms = [...protocol.arms.slice(index), ...protocol.arms.slice(0, index)];
      if (repetition === 2) arms.reverse();
      for (const arm of arms) order.push({ repetition, id: task.id, arm });
    }
  }
  await writeJson(join(campaign, "provenance.json"), { frozen, order,
    startedAt: new Date().toISOString(), protocolSha256: sha(await readFile(join(study, "protocol.json"))) });
  let observedCost = 0;
  for (const trial of order) {
    if (observedCost >= protocol.budgets.panelObservedCostStopUsd) {
      await writeJson(join(campaign, "budget-stop.json"), { observedCost, remainingFrom: trial });
      break;
    }
    await verifyBindings();
    const task = protocol.tasks.find((task) => task.id === trial.id);
    const name = [trial.repetition, trial.id, trial.arm].join("-");
    const directory = join(campaign, name), workspace = join(directory, "workspace");
    await mkdir(directory);
    let started = performance.now();
    git(["clone", "--shared", "--no-hardlinks", "--quiet", upstream, workspace]);
    await writeFile(join(workspace, ".git/info/exclude"), ".blame/\n");
    await symlink(join(upstream, "node_modules"), join(workspace, "node_modules"));
    await writeFile(join(directory, "instruction.txt"), task.instruction);
    const preparationMs = performance.now() - started;
    const runner = join(work, "frozen", trial.arm === "baseline" ? "baseline" : "modified",
      "benchmark-runner/dist/cli.js");
    const args = [runner, "run", "--workspace", workspace, "--instruction-file", join(directory, "instruction.txt"),
      "--task-id", task.id, "--events", join(directory, "events.jsonl"), "--result", join(directory, "result.json"),
      ...harnessArguments(trial.arm), "--max-iterations", String(protocol.budgets.maxIterations),
      "--timeout-seconds", String(protocol.budgets.timeoutSeconds)];
    process.stdout.write("START " + name + "\n");
    started = performance.now();
    const exit = await executeModel(args, directory);
    const outerAgentMs = performance.now() - started;
    started = performance.now();
    const grade = await score(directory, workspace, task);
    const verificationMs = performance.now() - started;
    await writeFile(join(directory, "workspace.diff"), git(["diff", "--binary", "HEAD"], workspace));
    await writeJson(join(directory, "trial.json"), { ...trial, name, exit, preparationMs, outerAgentMs, verificationMs });
    const rows = await analyze();
    observedCost = rows.reduce((sum, row) => sum + (row.usage.cost ?? 0), 0);
    process.stdout.write("END " + name + " functional=" + grade.independentFunctionalSuccess + "\n");
  }
}
async function analyze() {
  const provenance = JSON.parse(await readFile(join(campaign, "provenance.json"), "utf8"));
  const rows = [], ledger = [];
  for (const trial of provenance.order) {
    const name = [trial.repetition, trial.id, trial.arm].join("-");
    const directory = join(campaign, name);
    let data;
    try { data = JSON.parse(await readFile(join(directory, "trial.json"), "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; continue; }
    const score = JSON.parse(await readFile(join(directory, "score.json"), "utf8"));
    let result = {}, raw = "", events = [], parseErrors = 0;
    try { result = JSON.parse(await readFile(join(directory, "result.json"), "utf8")); } catch {}
    try { raw = await readFile(join(directory, "events.jsonl"), "utf8"); } catch {}
    for (const line of raw.split("\n").filter(Boolean)) {
      try { events.push(JSON.parse(line).event); } catch { parseErrors++; }
    }
    const requests = events.filter((event) => event.type === "notice" &&
      event.payload?.message === "Agent iteration started.").length;
    const usage = reconcileUsage(result.usage,
      events.filter((event) => event.type === "usage").map((event) => event.payload?.usage), requests);
    if (parseErrors) { usage.complete = false; usage.tokensCostReconciled = false; }
    const tools = events.filter((event) => event.type === "tool").map((event) => ({
      ...event.payload, tool: event.payload.toolCall?.name ?? event.payload.tool,
      input: event.payload.toolCall?.input ?? event.payload.input,
    })).filter((tool) => tool.phase === "finished");
    rows.push({ ...data, status: result.status ?? "missing", officialRuntimeSuccess: result.status === "succeeded",
      independentFunctionalSuccess: score.independentFunctionalSuccess,
      auditedCompletion: null, usage, durationMs: result.durationMs ?? null, metrics: result.metrics ?? null,
      completion: result.completion ?? null, parseErrors, error: result.error ?? null,
      eventsSha256: sha(raw), diffSha256: sha(await readFile(join(directory, "workspace.diff"))),
      scoreSha256: sha(await readFile(join(directory, "score.json"))) });
    ledger.push({ name, tools });
  }
  await writeJson(join(campaign, "analysis.json"), { planned: provenance.order.length, completed: rows.length, provenance, rows });
  await writeJson(join(campaign, "tool-ledger.json"), ledger);
  return rows;
}
if (process.argv[2] === "bind") await writeJson(join(study, "execution-bindings.json"), await bindings());
else if (process.argv[2] === "run") await run();
else if (process.argv[2] === "analyze") await analyze();
else if (process.argv[2] === "score") {
  const task = protocol.tasks.find((task) => task.id === process.argv[5]);
  await score(resolve(process.argv[3]), resolve(process.argv[4]), task);
} else throw new Error("Use bind, run, analyze or score <output> <workspace> <task>");

// Only Blame's harness is left: a study arm on Cline cannot run any more.
function harnessArguments(arm) {
  if (arm === "cline")
    throw new Error("The Cline arm is gone: the benchmark runner has only Blame's harness.");
  return [];
}
