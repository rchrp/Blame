import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type {
  ReasoningSelection,
  RequiredProjectCheck,
} from "@blame/agent-runtime/engine";
import type { BenchmarkConfig, BenchmarkPaths } from "./contracts.js";
import {
  assertHeadlessDevelopment,
  HeadlessConfigurationError,
} from "./dev-guard.js";

export type ParsedBenchmarkCommand = {
  config: BenchmarkConfig;
  paths: BenchmarkPaths;
};

const reasoningValues = new Set<ReasoningSelection>([
  "none",
  "enabled",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export async function parseBenchmarkCommand(
  argumentsList: string[],
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Promise<ParsedBenchmarkCommand> {
  assertHeadlessDevelopment(environment);
  if (argumentsList[0] !== "run") {
    throw new HeadlessConfigurationError("Expected the run command.");
  }
  const options = optionValues(argumentsList.slice(1));
  if (options.has("harness"))
    throw new HeadlessConfigurationError(
      "--harness is gone: every run uses Blame's harness on the engine.",
    );
  const instructionPath = requiredOption(options, "instruction-file");
  const instruction = await readFile(resolve(cwd, instructionPath), "utf8");
  const checksPath = options.get("required-checks-file");
  const requiredChecks = checksPath ? requiredChecksValue(
    JSON.parse(await readFile(resolve(cwd, checksPath), "utf8")),
  ) : undefined;
  const paths = benchmarkPaths(options, cwd);
  return {
    config: {
      ...benchmarkConfig(options, environment, cwd, instruction),
      harnessTracePath: paths.harnessTracePath,
      ...(requiredChecks ? { requiredChecks } : {}),
    },
    paths,
  };
}

function benchmarkConfig(
  options: Map<string, string>,
  environment: NodeJS.ProcessEnv,
  cwd: string,
  instruction: string,
): Omit<BenchmarkConfig, "harnessTracePath"> {
  const reasoningEffort = reasoningValue(environment.BLAME_REASONING_EFFORT);
  return {
    apiUrl: requiredEnvironment(environment, "BLAME_API_URL"),
    isolatedEnvironment: isolatedEnvironmentValue(environment.BLAME_ISOLATED_ENVIRONMENT),
    apiToken: requiredEnvironment(environment, "BLAME_API_TOKEN"),
    credentialLabel: optionalEnvironment(environment, "BLAME_CREDENTIAL_LABEL"),
    instruction,
    maxIterations: positiveInteger(
      options.get("max-iterations") ?? environment.BLAME_MAX_ITERATIONS,
      64,
      "max iterations",
    ),
    modelId: requiredEnvironment(environment, "BLAME_MODEL_ID"),
    projectMemoryFile: options.get("project-memory-file")
      ? resolve(cwd, options.get("project-memory-file")!)
      : undefined,
    providerId: requiredEnvironment(environment, "BLAME_PROVIDER_ID"),
    projectId:
      options.get("project-id")?.trim() ||
      (options.has("project-memory-file") ? "terminal-bench" : undefined),
    reasoningEffort,
    taskId: options.get("task-id")?.trim() || "terminal-bench",
    timeoutMs:
      positiveInteger(
        options.get("timeout-seconds") ?? environment.BLAME_TIMEOUT_SECONDS,
        900,
        "timeout seconds",
      ) * 1_000,
    workspaceRoot: resolve(cwd, options.get("workspace") ?? cwd),
  };
}

// Validate the checks before starting a paid session; the harness validates
// the contract again when the task starts.
function requiredChecksValue(value: unknown): RequiredProjectCheck[] {
  const invalid = () => { throw new HeadlessConfigurationError("Invalid required-checks file: expected at most 16 unique IDs, catalog tasks and literal test argv."); };
  if (!Array.isArray(value) || value.length > 16) return invalid();
  const ids = new Set<string>();
  return value.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return invalid();
    const check = item as Record<string, unknown>;
    if (Object.keys(check).some(key => !["id", "task", "args"].includes(key)) ||
      typeof check.id !== "string" || !/^[A-Za-z0-9_.:-]{1,120}$/u.test(check.id) || ids.has(check.id) ||
      typeof check.task !== "string" || !check.task.trim() || check.task.trim().length > 300 ||
      (check.args !== undefined && (!Array.isArray(check.args) || check.args.length > 32 ||
        check.args.some(arg => typeof arg !== "string" || !arg.length || arg.length > 2048 || arg.includes("\0"))))) return invalid();
    ids.add(check.id);
    return { id: check.id, task: check.task.trim(), ...(check.args !== undefined ? { args: check.args as string[] } : {}) };
  });
}

function isolatedEnvironmentValue(value: string | undefined) {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new HeadlessConfigurationError("BLAME_ISOLATED_ENVIRONMENT must be true or false.");
}

function benchmarkPaths(options: Map<string, string>, cwd: string) {
  const defaultRoot = resolve(cwd, ".blame", "benchmarks");
  const eventsPath = resolve(
    cwd,
    options.get("events") ?? `${defaultRoot}/events.jsonl`,
  );
  return {
    eventsPath,
    // Each harness call's raw result, beside the events.
    harnessTracePath: resolve(
      cwd,
      options.get("harness-trace") ?? join(dirname(eventsPath), "harness-trace.jsonl"),
    ),
    resultPath: resolve(
      cwd,
      options.get("result") ?? `${defaultRoot}/result.json`,
    ),
  };
}

function optionValues(argumentsList: string[]) {
  const options = new Map<string, string>();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--")) {
      throw new HeadlessConfigurationError(
        `Invalid option near ${name ?? "end"}.`,
      );
    }
    options.set(name.slice(2), value);
  }
  return options;
}

function requiredOption(options: Map<string, string>, name: string) {
  const value = options.get(name)?.trim();
  if (!value) throw new HeadlessConfigurationError(`Missing --${name}.`);
  return value;
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string) {
  const value = environment[name]?.trim();
  if (!value) throw new HeadlessConfigurationError(`Missing ${name}.`);
  return value;
}

function optionalEnvironment(environment: NodeJS.ProcessEnv, name: string) {
  return environment[name]?.trim() || undefined;
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  throw new HeadlessConfigurationError(`Invalid ${name}: ${value}.`);
}

function reasoningValue(value: string | undefined) {
  const normalized = value?.trim() as ReasoningSelection | undefined;
  if (!normalized) return undefined;
  if (reasoningValues.has(normalized)) return normalized;
  throw new HeadlessConfigurationError(`Invalid reasoning effort: ${value}.`);
}
