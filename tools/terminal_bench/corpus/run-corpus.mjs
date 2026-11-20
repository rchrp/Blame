import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  corpusRoot,
  parseArguments,
  prepareWorkspace,
  readManifest,
  repositoryRoot,
  runProcess,
  workspaceDiff,
} from "./corpus-utils.mjs";
import { scoreRun } from "./score-run.mjs";
import { writeCampaignReport } from "./report-corpus.mjs";
import { selectedScenarios } from "./select-scenarios.mjs";
import { recordCampaignProvenance } from "./campaign-provenance.mjs";

const options = parseArguments(process.argv.slice(2));
const label = requiredOption(options, "label");
const output = resolve(
  options.get("output") ?? join(repositoryRoot, ".blame/benchmarks/corpus"),
);
const campaign = join(output, label);
const manifest = await readManifest();
const scenarios = selectedScenarios(
  manifest.scenarios,
  options.get("scenarios"),
);

await mkdir(output, { recursive: true });
await mkdir(campaign, { recursive: false });
await recordCampaignProvenance(campaign, scenarios);
for (const [index, scenario] of scenarios.entries())
  await executeScenario(campaign, scenario, index);
const report = await writeCampaignReport(campaign);
process.stdout.write(`${JSON.stringify({ campaign, ...report })}\n`);

async function executeScenario(campaignDirectory, scenario, index) {
  const runDirectory = join(
    campaignDirectory,
    `${String(index + 1).padStart(2, "0")}-${scenario.id}-blame`,
  );
  const workspace = join(runDirectory, "workspace");
  await mkdir(runDirectory, { recursive: true });
  const baseRevision = await prepareWorkspace(workspace, scenario.id);
  await writeFile(
    join(runDirectory, "base-revision.txt"),
    `${baseRevision}\n`,
    "utf8",
  );
  process.stdout.write(`START ${scenario.id}\n`);
  const run = await executeRunner(runDirectory, workspace, scenario);
  await writeFile(
    join(runDirectory, "runner-exit.json"),
    `${JSON.stringify(run, null, 2)}\n`,
    "utf8",
  );
  const score = await scoreRun(runDirectory, workspace, scenario);
  await writeFile(
    join(runDirectory, "workspace.diff"),
    workspaceDiff(workspace),
    "utf8",
  );
  process.stdout.write(
    `END ${scenario.id} score=${score.qualityScore} status=${score.status} input=${score.tokens.input}\n`,
  );
}

function executeRunner(runDirectory, workspace, scenario) {
  const runner = join(repositoryRoot, "packages/benchmark-runner/dist/cli.js");
  const instruction = join(corpusRoot, scenario.instruction);
  const args = [
    runner,
    "run",
    "--workspace",
    workspace,
    "--instruction-file",
    instruction,
    "--task-id",
    scenario.id,
    "--events",
    join(runDirectory, "events.jsonl"),
    "--result",
    join(runDirectory, "result.json"),
    "--max-iterations",
    String(scenario.maxIterations),
    "--timeout-seconds",
    String(scenario.timeoutSeconds),
  ];
  return runProcess(process.execPath, args, repositoryRoot, {
    ...process.env,
    BLAME_HEADLESS_DEV: "true",
    NODE_ENV: "development",
  });
}

function requiredOption(values, name) {
  const value = values.get(name)?.trim();
  if (!value) throw new Error(`Missing --${name}.`);
  return value;
}
