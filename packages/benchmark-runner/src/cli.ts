#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { JsonlEventRecorder } from "./event-recorder.js";
import { parseBenchmarkCommand } from "./config.js";
import { runBenchmark } from "./benchmark-run.js";
import { benchmarkEngine } from "./benchmark-engine.js";
import type { BenchmarkResult } from "./contracts.js";
import { HeadlessConfigurationError } from "./dev-guard.js";

const helpText = `Usage: blame-headless run [options]

Required environment:
  BLAME_HEADLESS_DEV=true
  BLAME_API_URL=<url>
  BLAME_API_TOKEN=<token>
  BLAME_PROVIDER_ID=<provider>
  BLAME_MODEL_ID=<model>

Required option:
  --instruction-file <path>

Options:
  --required-checks-file <path> (trusted JSON catalog task IDs and literal test argv)
  --workspace <path>
  --task-id <id>
  --events <path>
  --harness-trace <path> (each harness call's raw result; default beside the events)
  --result <path>
  --max-iterations <count>
  --timeout-seconds <seconds>`;

async function main() {
  const argumentsList = commandArguments();
  if (argumentsList.includes("--help") || argumentsList.includes("-h")) {
    await writeOutput(process.stdout, `${helpText}\n`);
    return 0;
  }
  if (argumentsList.includes("--version")) {
    await writeOutput(process.stdout, `${await runnerVersion()}\n`);
    return 0;
  }
  const controller = benchmarkAbortController();
  try {
    return await executeBenchmark(argumentsList, controller.signal);
  } catch (error) {
    await writeOutput(process.stderr, `${errorMessage(error)}\n`);
    return error instanceof HeadlessConfigurationError ? 2 : 1;
  }
}

async function runnerVersion() {
  try {
    const url = new URL("../benchmark-provenance.json", import.meta.url);
    const provenance = JSON.parse(await readFile(url, "utf8")) as {
      commit?: string;
    };
    return provenance.commit
      ? `0.0.0+${provenance.commit.slice(0, 12)}`
      : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function executeBenchmark(argumentsList: string[], signal: AbortSignal) {
  const parsed = await parseBenchmarkCommand(
    argumentsList,
    process.env,
    process.cwd(),
  );
  await Promise.all([
    mkdir(dirname(parsed.paths.eventsPath), { recursive: true }),
    mkdir(dirname(parsed.paths.resultPath), { recursive: true }),
  ]);
  const result = await runBenchmark(parsed.config, {
    createRecorder: () => new JsonlEventRecorder(parsed.paths.eventsPath),
    createEngine: benchmarkEngine,
    signal,
  });
  await writeResult(parsed.paths.resultPath, result);
  await writeOutput(process.stdout, `${JSON.stringify(result)}\n`);
  return resultExitCode(result);
}

function commandArguments() {
  const argumentsList = process.argv.slice(2);
  return argumentsList[0] === "--" ? argumentsList.slice(1) : argumentsList;
}

async function writeResult(path: string, result: BenchmarkResult) {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(
    temporaryPath,
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );
  await rename(temporaryPath, path);
}

function benchmarkAbortController() {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  return controller;
}

function resultExitCode(result: BenchmarkResult) {
  if (result.status === "succeeded") return 0;
  if (result.status === "timed_out") return 124;
  if (result.status === "cancelled") return 130;
  return 1;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function writeOutput(stream: NodeJS.WriteStream, value: string) {
  return new Promise<void>((resolve, reject) => {
    stream.write(value, (error) => (error ? reject(error) : resolve()));
  });
}

process.exit(await main());
