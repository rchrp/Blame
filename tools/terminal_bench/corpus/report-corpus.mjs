import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArguments } from "./corpus-utils.mjs";

export async function writeCampaignReport(campaignDirectory) {
  const entries = await readdir(campaignDirectory, { withFileTypes: true });
  const scores = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => readScore(join(campaignDirectory, entry.name))),
  );
  const runs = scores
    .filter(Boolean)
    .sort((left, right) => left.scenario.localeCompare(right.scenario));
  const report = aggregateRuns(runs);
  await writeFile(
    join(campaignDirectory, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(campaignDirectory, "report.md"),
    markdownReport(report),
    "utf8",
  );
  return report;
}

function aggregateRuns(runs) {
  return {
    missingUsageRuns: runs.filter(
      (run) =>
        run.tokens.input == null ||
        run.tokens.output == null ||
        run.tokens.cost == null,
    ).length,
    runCount: runs.length,
    averageQualityScore: average(runs.map((run) => run.qualityScore)),
    successfulRuns: runs.filter((run) => run.status === "succeeded").length,
    verifiedRuns: runs.filter((run) => run.verified === true).length,
    formattedRuns: runs.filter((run) => run.formattingPassed === true).length,
    totalDurationMs: total(runs, (run) => run.durationMs),
    totalTokens: {
      input: knownTotal(runs, (run) => run.tokens.input),
      output: knownTotal(runs, (run) => run.tokens.output),
      cacheRead: knownTotal(runs, (run) => run.tokens.cacheRead),
      cacheWrite: knownTotal(runs, (run) => run.tokens.cacheWrite),
    },
    totalCost: knownTotal(runs, (run) => run.tokens.cost),
    totalToolCalls: total(runs, (run) => run.metrics?.tools?.calls),
    totalReadCalls: total(runs, (run) => run.metrics?.navigation?.readCalls),
    totalReturnedBytes: total(
      runs,
      (run) => run.metrics?.navigation?.returnedBytes,
    ),
    totalBlockedEdits: total(runs, (run) => run.metrics?.editing?.blocked),
    runs,
  };
}

function markdownReport(report) {
  const header =
    "| Scénario | Score | Format | Statut | Durée | Entrée | Sortie | Cache lu | Coût | Outils | Lectures | Rejets édition |\n| --- | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |";
  const rows = report.runs.map(markdownRow).join("\n");
  return `# Terminal Bench corpus report\n\n${header}\n${rows}\n\nScore moyen : ${report.averageQualityScore}/100  \nFormatage : ${report.formattedRuns}/${report.runCount}  \nTokens d'entrée : ${report.totalTokens.input}  \nTokens de sortie : ${report.totalTokens.output}  \nTokens de cache lus : ${report.totalTokens.cacheRead}  \nCoût : ${report.totalCost?.toFixed(5) ?? "inconnu"}  \n`;
}

function markdownRow(run) {
  return `| ${run.scenario} | ${run.qualityScore} | ${run.formattingPassed ? "oui" : "non"} | ${run.status} | ${(run.durationMs / 1000).toFixed(1)} s | ${run.tokens.input} | ${run.tokens.output} | ${run.tokens.cacheRead} | ${run.tokens.cost?.toFixed(5) ?? "inconnu"} | ${run.metrics?.tools?.calls ?? 0} | ${run.metrics?.navigation?.readCalls ?? 0} | ${run.metrics?.editing?.blocked ?? 0} |`;
}

async function readScore(directory) {
  try {
    return JSON.parse(await readFile(join(directory, "score.json"), "utf8"));
  } catch {
    return undefined;
  }
}

function total(values, read) {
  return values.reduce((sum, value) => sum + (Number(read(value)) || 0), 0);
}

function knownTotal(values, read) {
  return values.every((value) => Number.isFinite(read(value)))
    ? total(values, read)
    : null;
}

function average(values) {
  return values.length
    ? Math.round(
        (values.reduce((sum, value) => sum + value, 0) / values.length) * 10,
      ) / 10
    : 0;
}

if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href
) {
  const options = parseArguments(process.argv.slice(2));
  const campaign = resolve(options.get("campaign") ?? "");
  process.stdout.write(
    `${JSON.stringify(await writeCampaignReport(campaign))}\n`,
  );
}
