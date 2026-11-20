import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  repositoryRoot,
  corpusRoot,
  prepareWorkspace,
  workspaceDiff,
} from "./corpus-utils.mjs";
import { scoreRun } from "./score-run.mjs";
import { reconcileUsage } from "./light-study-accounting.mjs";

const study = resolve(
  process.env.BLAME_STUDY_DIRECTORY ??
    join(repositoryRoot, "docs/experiments/light-harness-2026-10-09"),
);
const root = resolve(
  process.env.BLAME_STUDY_WORK_DIRECTORY ??
    join(repositoryRoot, ".blame/research"),
);
const frozen = join(root, "frozen");
const campaign = join(root, "pilot");
const protocol = JSON.parse(
  await readFile(join(study, "protocol.json"), "utf8"),
);
const mode = process.argv[2];
const suffix =
  "\nWork independently from this checkout. Do not retrieve published solutions, reference patches, or benchmark verifier source.\n";
const diagnosticInstruction =
  'In src/project-label.ts, change labelSeparator to " · ". Run the declared root test script selecting only the test named "label separator". The unrelated test is a known baseline failure outside this request; do not run or repair it. Do not change tests or other files. Report which test ran.\n';

if (mode === "freeze") await freeze(process.argv[3]);
else if (mode === "run") await run();
else if (mode === "analyze") await analyze();
else
  throw new Error(
    "Usage: node tools/terminal_bench/corpus/light-study.mjs freeze <baseline|modified> | run | analyze",
  );

async function freeze(arm) {
  if (!["baseline", "modified"].includes(arm)) throw new Error("Invalid arm");
  const destination = join(frozen, arm);
  // Freeze from a built checkout of the requested version. Refuse overwrites.
  await mkdir(destination, { recursive: false });
  for (const name of ["agent-runtime", "benchmark-runner"]) {
    const target = join(destination, name);
    await mkdir(target);
    await cp(
      join(repositoryRoot, "packages", name, "dist"),
      join(target, "dist"),
      { recursive: true },
    );
    await writeFile(
      join(target, "package.json"),
      JSON.stringify({ type: "module", exports: "./dist/index.js" }),
    );
  }
  await symlink(
    join(repositoryRoot, "packages/agent-runtime/node_modules"),
    join(destination, "agent-runtime/node_modules"),
  );
  await mkdir(join(destination, "benchmark-runner/node_modules/@blame"), {
    recursive: true,
  });
  await symlink(
    join(destination, "agent-runtime"),
    join(destination, "benchmark-runner/node_modules/@blame/agent-runtime"),
  );
  await writeJson(join(destination, "version.json"), {
    commit: git(["rev-parse", "HEAD"]),
    sourcePatch: git(["diff", "HEAD", "--", "packages/agent-runtime"]),
  });
}

async function run() {
  for (const [name, expected] of [
    ["BLAME_MODEL_ID", protocol.model],
    ["BLAME_REASONING_EFFORT", protocol.effort],
  ])
    if (process.env[name] !== expected)
      throw new Error(`${name} differs from protocol`);
  for (const name of ["BLAME_API_TOKEN", "BLAME_API_URL", "BLAME_PROVIDER_ID"])
    if (!process.env[name]) throw new Error(`Missing ${name}`);
  await mkdir(campaign, { recursive: false });
  const manifests = JSON.parse(
    await readFile(join(corpusRoot, "manifest.json"), "utf8"),
  );
  const versions = {};
  for (const arm of ["baseline", "modified"])
    versions[arm] = {
      runtimeSha256: await treeDigest(join(frozen, arm, "agent-runtime/dist")),
      runnerSha256: await treeDigest(
        join(frozen, arm, "benchmark-runner/dist"),
      ),
      schemaSha256: sha(
        await readFile(
          join(frozen, arm, "agent-runtime/dist/harness/light-contracts.js"),
        ),
      ),
      source:
        arm === "baseline"
          ? protocol.baselineSource
          : JSON.parse(
              await readFile(join(frozen, arm, "version.json"), "utf8"),
            ),
    };
  const provenance = {
    versions,
    protocolSha256: sha(await readFile(join(study, "protocol.json"))),
    lockSha256: sha(await readFile(join(repositoryRoot, "pnpm-lock.yaml"))),
    fixtureSha256: await treeDigest(join(corpusRoot, "fixture")),
    evaluatorSha256: sha(
      await readFile(join(corpusRoot, "scenario-checks.mjs")),
    ),
    driverSha256: sha(await readFile(new URL(import.meta.url))),
    ...(protocol.fault
      ? {
          faultLoaderSha256: sha(
            await readFile(
              join(
                repositoryRoot,
                "tools/terminal_bench/corpus/light-study-fault.mjs",
              ),
            ),
          ),
        }
      : {}),
    model: protocol.model,
    effort: protocol.effort,
    provider: process.env.BLAME_PROVIDER_ID,
    apiUrl: process.env.BLAME_API_URL,
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    sdk: "0.0.82",
    typescript: "5.9.2",
    memory: false,
    nodeUseEnvProxy: true,
    sharedCoreSha256: await treeDigest(
      join(repositoryRoot, "packages/harness-core/dist"),
    ),
    startedAt: new Date().toISOString(),
    instructionHashes: {},
    order: [],
  };
  for (let repetition = 1; repetition <= protocol.repetitions; repetition++) {
    const tasks =
      repetition === 1 ? protocol.tasks : [...protocol.tasks].reverse();
    for (const task of tasks) {
      const index = protocol.tasks.indexOf(task);
      let arms = [
        ...protocol.arms.slice(index),
        ...protocol.arms.slice(0, index),
      ];
      if (repetition === 2) arms = arms.reverse();
      const scenario =
        task.id === "project-arguments"
          ? { ...task, allowedPaths: ["src/project-label.ts"] }
          : { ...manifests.scenarios.find((s) => s.id === task.id), ...task };
      const instruction =
        (task.id === "project-arguments"
          ? diagnosticInstruction
          : await readFile(join(corpusRoot, scenario.instruction), "utf8")) +
        suffix;
      provenance.instructionHashes[task.id] = sha(instruction);
      const conditions = protocol.conditions ?? [undefined];
      for (const condition of repetition === 2
        ? [...conditions].reverse()
        : conditions)
        for (const arm of arms)
          provenance.order.push({
            id: task.id,
            repetition,
            arm,
            ...(condition ? { condition } : {}),
          });
    }
  }
  await writeJson(join(campaign, "provenance.json"), provenance);
  for (const trial of provenance.order) {
    if (protocol.budget.panelObservedCostStopUsd) {
      try {
        const previous = JSON.parse(
          await readFile(join(campaign, "analysis.json"), "utf8"),
        );
        if (
          previous.rows.reduce((sum, row) => sum + (row.usage.cost ?? 0), 0) >=
          protocol.budget.panelObservedCostStopUsd
        )
          throw new Error(
            "Observed campaign cost ceiling reached; remaining planned trials stay unexecuted",
          );
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    for (const arm of ["baseline", "modified"])
      if (
        (await treeDigest(join(frozen, arm, "agent-runtime/dist"))) !==
        versions[arm].runtimeSha256
      )
        throw new Error("Frozen runtime changed");
    const task = protocol.tasks.find((s) => s.id === trial.id);
    const scenario =
      trial.id === "project-arguments"
        ? { ...task, allowedPaths: ["src/project-label.ts"] }
        : { ...manifests.scenarios.find((s) => s.id === trial.id), ...task };
    await executeTrial(trial, scenario);
    await analyze();
  }
}

async function executeTrial(trial, scenario) {
  const name = trialName(trial);
  const directory = join(campaign, name),
    workspace = join(directory, "workspace");
  await mkdir(directory);
  let start = performance.now();
  let base = await prepareWorkspace(workspace, trial.id);
  let instruction =
    trial.id === "project-arguments"
      ? diagnosticInstruction
      : await readFile(join(corpusRoot, scenario.instruction), "utf8");
  if (trial.id === "project-arguments") {
    const manifestPath = join(workspace, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.scripts.test = "node --test";
    await writeJson(manifestPath, manifest);
    await writeFile(
      join(workspace, "project-label-check.test.mjs"),
      `import {test} from 'node:test'; import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs';\ntest('label separator',()=>assert.match(readFileSync('src/project-label.ts','utf8'),/labelSeparator\\s*=\\s*["'] · ["']/u));\ntest('unrelated known baseline failure',()=>assert.fail('outside requested scope'));\n`,
    );
    git(["add", "."], workspace);
    git(["commit", "-m", "test selection fixture"], workspace, {
      ...process.env,
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    });
    base = git(["rev-parse", "HEAD"], workspace);
  }
  await writeFile(join(directory, "instruction.txt"), instruction + suffix);
  const preparationMs = performance.now() - start;
  const runner = join(
    frozen,
    trial.arm === "baseline" ? "baseline" : "modified",
    "benchmark-runner/dist/cli.js",
  );
  const args = [
    runner,
    "run",
    "--workspace",
    workspace,
    "--instruction-file",
    join(directory, "instruction.txt"),
    "--task-id",
    trial.id,
    "--events",
    join(directory, "events.jsonl"),
    "--result",
    join(directory, "result.json"),
    "--max-iterations",
    String(scenario.maxIterations),
    "--timeout-seconds",
    String(scenario.timeoutSeconds),
  ];
  process.stdout.write(`START ${name}\n`);
  start = performance.now();
  const exit = await execute(args, scenario.timeoutSeconds, trial, directory);
  const outerAgentMs = performance.now() - start;
  start = performance.now();
  const scoringScenario =
    trial.id === "project-arguments"
      ? { ...scenario, id: "task-selection" }
      : scenario;
  const score = await scoreRun(directory, workspace, scoringScenario);
  const verificationMs = performance.now() - start;
  await writeFile(join(directory, "workspace.diff"), workspaceDiff(workspace));
  await writeJson(join(directory, "trial.json"), {
    ...trial,
    base,
    preparationMs,
    outerAgentMs,
    verificationMs,
    exit,
    partition: scenario.partition,
  });
  process.stdout.write(
    `END ${name} status=${score.status} score=${score.qualityScore}\n`,
  );
}

async function analyze() {
  const rows = [],
    ledger = [];
  const provenance = JSON.parse(
    await readFile(join(campaign, "provenance.json"), "utf8"),
  );
  for (const planned of provenance.order) {
    const name = trialName(planned),
      directory = join(campaign, name);
    let trial;
    try {
      trial = JSON.parse(await readFile(join(directory, "trial.json"), "utf8"));
    } catch {
      continue;
    }
    const score = JSON.parse(
      await readFile(join(directory, "score.json"), "utf8"),
    );
    let result;
    try {
      result = JSON.parse(
        await readFile(join(directory, "result.json"), "utf8"),
      );
    } catch {
      result = {};
    }
    let raw = "";
    try {
      raw = await readFile(join(directory, "events.jsonl"), "utf8");
    } catch {
      /* retained missing */
    }
    let eventParseErrors = 0;
    const events = raw
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line).event];
        } catch {
          eventParseErrors++;
          return [];
        }
      });
    const tools = events
      .filter((e) => e.type === "tool")
      .map((e) => ({
        ...e.payload,
        tool: e.payload.toolCall?.name ?? e.payload.tool,
        input: e.payload.toolCall?.input ?? e.payload.input,
      }));
    const requests = events.filter(
      (e) =>
        e.type === "notice" &&
        e.payload?.message === "Agent iteration started.",
    ).length;
    const usage = reconcileUsage(
      result.usage,
      events.filter((e) => e.type === "usage").map((e) => e.payload?.usage),
      requests,
    );
    let faultEvents = [];
    try {
      faultEvents = (await readFile(join(directory, "fault.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (faultEvents.some((event) => event.providerUsageLost)) {
      usage.complete = false;
      usage.tokensCostReconciled = false;
      usage.controlledUpstreamUsageMissing = true;
    }
    if (eventParseErrors) {
      usage.complete = false;
      usage.tokensCostReconciled = false;
    }
    const finishedTools = tools.filter((t) => t.phase === "finished");
    const candidates = finishedTools.filter((t) =>
      /https?:\/\/|scenario-checks\.mjs|reference.patch|rescore-corpus|\/docs\/experiments\//iu.test(
        JSON.stringify(t.input),
      ),
    );
    // Requires review of this ledger; the automatic candidate list is not a leakage certificate.
    const argsUsed = finishedTools.filter(
      (t) =>
        t.tool === "run_task" &&
        t.input?.kind === "project" &&
        t.input?.args?.length,
    ).length;
    const refusals = finishedTools.filter((t) =>
      /No project task matches|Project task .* ambiguous/u.test(
        JSON.stringify(t.output),
      ),
    ).length;
    const functional =
      score.checks.every((x) => x.passed) &&
      score.validationPassed &&
      score.unexpectedPaths.length === 0;
    rows.push({
      ...trial,
      name,
      status: result.status ?? "missing",
      eventParseErrors,
      ...(trial.condition ? { faultEvents } : {}),
      error: result.error ?? null,
      qualityScore: score.qualityScore,
      functionalSuccess: functional,
      auditedSuccess: null,
      auditCandidates: candidates.length,
      verified: result.verified ?? null,
      completion: result.completion ?? null,
      checks: score.checks,
      harnessChecks:
        trial.id === "project-arguments" ? [] : score.harnessChecks,
      ...(trial.id === "project-arguments"
        ? { surrogateHarnessChecks: score.harnessChecks }
        : {}),
      unexpectedPaths: score.unexpectedPaths,
      usage,
      durationMs: result.durationMs ?? null,
      argsUsed,
      recoveryNotices: events.filter(
        (event) =>
          event.type === "notice" &&
          /resuming from the persisted session state/u.test(
            event.payload?.message ?? "",
          ),
      ).length,
      taskSelectionRefusals: refusals,
      eventsSha256: sha(raw),
      diffSha256: sha(await readFile(join(directory, "workspace.diff"))),
      metrics: result.metrics ?? null,
    });
    ledger.push({ name, tools: finishedTools, auditCandidates: candidates });
  }
  await writeJson(join(campaign, "analysis.json"), {
    provenance,
    analysisDriverSha256: sha(await readFile(new URL(import.meta.url))),
    planned: provenance.order.length,
    completed: rows.length,
    rows,
  });
  await writeJson(join(campaign, "tool-ledger.json"), ledger);
}

function execute(args, seconds, trial, directory) {
  return new Promise((done) => {
    const inject = trial.condition === protocol.fault?.condition;
    const child = spawn(
      process.execPath,
      [
        ...(inject
          ? [
              "--import",
              resolve(
                repositoryRoot,
                "tools/terminal_bench/corpus/light-study-fault.mjs",
              ),
            ]
          : []),
        ...args,
      ],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          BLAME_HEADLESS_DEV: "true",
          NODE_ENV: "development",
          NODE_USE_ENV_PROXY: "1",
          ...(protocol.budget.perTrialSdkCostLimitUsd
            ? {
                BLAME_AGENT_MAX_SESSION_COST_USD: String(
                  protocol.budget.perTrialSdkCostLimitUsd,
                ),
              }
            : {}),
          ...(inject
            ? {
                BLAME_STUDY_FAULT_REQUEST: String(protocol.fault.modelRequest),
                BLAME_STUDY_FAULT_COUNT: String(protocol.fault.count ?? 1),
                BLAME_STUDY_FAULT_LOG: join(directory, "fault.jsonl"),
              }
            : {}),
        },
        detached: true,
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "",
      watchdog = false;
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 4096) stderr += chunk.toString();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      done({ code: null, error: error.message });
    });
    const timer = setTimeout(
      () => {
        watchdog = true;
        process.kill(-child.pid, "SIGKILL");
      },
      (seconds + 25) * 1000,
    );
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      const token = process.env.BLAME_API_TOKEN;
      done({
        code,
        signal,
        watchdog,
        stderr: token ? stderr.replaceAll(token, "[REDACTED]") : stderr,
      });
    });
  });
}

function trialName(trial) {
  return `${trial.repetition}-${trial.id}-${trial.arm}${trial.condition ? `-${trial.condition}` : ""}`;
}

async function treeDigest(directory) {
  const hash = createHash("sha256");
  for (const path of (
    await readdir(directory, { recursive: true, withFileTypes: true })
  )
    .filter((p) => p.isFile())
    .map((p) => join(p.parentPath ?? p.path, p.name))
    .sort()) {
    hash.update(path.slice(directory.length) + "\0");
    hash.update(await readFile(path));
  }
  return hash.digest("hex");
}
function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}
function git(args, cwd = repositoryRoot, env = process.env) {
  return execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
}
async function writeJson(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n");
}
