// One benchmark run: a development story's agent on Blame's engine, run as
// a task with no person in it (`EngineHost.runStoryTask`). It ends through a
// finish_task the harness accepted, at the request limit (`maxIterations`),
// or at the benchmark's deadline. Its events come from the session's records
// and the harness trace once it has ended.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  JsonValue,
  SessionRecord,
  TaskOutcome,
} from "@blame/engine-client";
import {
  acceptedFinish,
  benchmarkEvents,
  usageSummary,
  type HarnessTraceEntry,
} from "./engine-events.js";
import type {
  BenchmarkConfig,
  BenchmarkEngine,
  BenchmarkResult,
  BenchmarkRunDependencies,
  BenchmarkStatus,
} from "./contracts.js";
import { boundedCleanup } from "./bounded-cleanup.js";

type Ending = { status: BenchmarkStatus; error?: string };

export async function runBenchmark(
  config: BenchmarkConfig,
  dependencies: BenchmarkRunDependencies,
): Promise<BenchmarkResult> {
  const now = dependencies.now ?? (() => new Date());
  const startedAt = now();
  const recorder = dependencies.createRecorder();
  const cleanupTimeoutMs = dependencies.cleanupTimeoutMs ?? 5_000;
  const session = `benchmark-${randomUUID()}`;
  const stop = new AbortController();
  let stopped: BenchmarkStatus | undefined;
  const end = (status: BenchmarkStatus) => {
    stopped ??= status;
    stop.abort();
  };
  const timer = setTimeout(() => end("timed_out"), config.timeoutMs);
  const cancel = () => end("cancelled");
  if (dependencies.signal?.aborted) cancel();
  dependencies.signal?.addEventListener("abort", cancel, { once: true });
  let engine: BenchmarkEngine | undefined;
  let ending: Ending;
  let outcome: TaskOutcome | undefined;
  let records: SessionRecord[] = [];
  let cleanupIncomplete = false;
  try {
    if (stopped) throw new Error("Benchmark cancelled.");
    engine = dependencies.createEngine(config);
    outcome = (await engine.runStoryTask(storyTask(config, session, stop.signal)))
      .outcome;
    ending = stopped
      ? { status: stopped, error: stoppedMessage(stopped) }
      : outcomeEnding(outcome);
    const read = await boundedCleanup(() => engine!.records(session), cleanupTimeoutMs);
    records = read.value ?? [];
    cleanupIncomplete ||= !read.completed;
  } catch (error) {
    ending = stopped
      ? { status: stopped, error: stoppedMessage(stopped) }
      : { status: "failed", error: errorMessage(error) };
  } finally {
    clearTimeout(timer);
    dependencies.signal?.removeEventListener("abort", cancel);
  }
  const trace = await readTrace(config.harnessTracePath);
  for (const { at, event } of benchmarkEvents(session, records, trace))
    recorder.record(event, at);
  if (engine) {
    const shutdown = await boundedCleanup(() => engine!.shutdown(), cleanupTimeoutMs);
    cleanupIncomplete ||= !shutdown.completed;
  }
  await recorder.close();
  const finishedAt = now();
  const finish = acceptedFinish(trace);
  return {
    ...(cleanupIncomplete ? { cleanupIncomplete: true } : {}),
    completion: finish.completion,
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    ...(ending.error ? { error: ending.error } : {}),
    eventCount: recorder.eventCount,
    finishedAt: finishedAt.toISOString(),
    harness: "blame",
    isolatedEnvironment: config.isolatedEnvironment === true,
    metrics: recorder.metrics(startedAt, finishedAt),
    modelId: config.modelId,
    providerId: config.providerId,
    reasoningEffort: config.reasoningEffort,
    maxIterations: config.maxIterations,
    timeoutMs: config.timeoutMs,
    schemaVersion: 1,
    ...(records.length ? { sessionId: session } : {}),
    startedAt: startedAt.toISOString(),
    status: ending.status,
    taskId: config.taskId,
    toolEventCount: recorder.toolEventCount,
    ...(records.length ? { usage: usageSummary(records) } : {}),
    verified: finish.verified,
  };
}

/** The story the benchmark runs: its instruction, isolation, checks and limit. */
function storyTask(config: BenchmarkConfig, session: string, signal: AbortSignal) {
  return {
    session,
    signal,
    instruction: config.instruction,
    settings: {
      workspace: { root: config.workspaceRoot, location: "host" as const },
      // An isolated environment is the run's own, like a story's worktree.
      workspaceMode: config.isolatedEnvironment
        ? ("local-container" as const)
        : ("direct" as const),
      projectId: config.projectId ?? "",
      storyId: config.taskId,
      title: "Requested task",
      model: {
        providerId: config.providerId,
        modelId: config.modelId,
        ...(config.credentialLabel ? { credentialLabel: config.credentialLabel } : {}),
        ...(config.reasoningEffort ? { reasoning: config.reasoningEffort } : {}),
      },
    },
    limits: { max_requests_per_turn: config.maxIterations },
    taskContract: {
      acceptance_criteria: [config.instruction],
      ...(config.requiredChecks
        ? { required_checks: config.requiredChecks as unknown as JsonValue }
        : {}),
    },
  };
}

function outcomeEnding(outcome: TaskOutcome): Ending {
  if (outcome.status === "completed") return { status: "succeeded" };
  if (outcome.status === "interrupted")
    return { status: "cancelled", error: "The run was stopped." };
  const { failure } = outcome;
  switch (failure.kind) {
    case "contract_unmet":
      return {
        status: "failed",
        error: "The agent stopped without a finish_task the harness accepted.",
      };
    case "limit_reached":
      return { status: "failed", error: `The run stopped at its ${failure.limit} limit.` };
    case "provider_error":
      return { status: "failed", error: failure.error.message };
  }
}

function stoppedMessage(status: BenchmarkStatus) {
  return status === "timed_out" ? "Benchmark timed out." : "Benchmark cancelled.";
}

async function readTrace(path: string): Promise<HarnessTraceEntry[]> {
  const text = await readFile(path, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as HarnessTraceEntry];
      } catch {
        return [];
      }
    });
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
