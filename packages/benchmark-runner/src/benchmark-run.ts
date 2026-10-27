import {
  BlameAgentRuntime,
  type AgentEvent,
} from "@blame/agent-runtime";
import type {
  BenchmarkConfig,
  BenchmarkEventRecorder,
  BenchmarkResult,
  BenchmarkRunDependencies,
  BenchmarkRuntime,
  BenchmarkSessionInput,
} from "./contracts.js";
import { ProjectMemoryFile } from "./project-memory-file.js";
import { boundedCleanup } from "./bounded-cleanup.js";

class BenchmarkTimeoutError extends Error {}
class BenchmarkCancelledError extends Error {}

type SessionState = { requested: boolean; sessionId?: string; failure?: unknown };

export async function runBenchmark(
  config: BenchmarkConfig,
  dependencies: BenchmarkRunDependencies,
): Promise<BenchmarkResult> {
  const startedAt = (dependencies.now ?? currentDate)();
  const recorder = dependencies.createRecorder();
  const terminal = terminalObserver(recorder);
  const runtime = dependencies.createRuntime(
    terminal.events,
    config.harness,
    config,
  );
  const cleanupTimeoutMs = dependencies.cleanupTimeoutMs ?? 5_000;
  let shutdownIncomplete: boolean;
  let outcome;
  try {
    outcome = await executeSession(
      config,
      runtime,
      terminal.promise,
      cleanupTimeoutMs,
      dependencies.signal,
    );
  } finally {
    shutdownIncomplete = !(await boundedCleanup(() => runtime.shutdown(), cleanupTimeoutMs)).completed;
    terminal.stop();
    await recorder.close();
  }
  const finishedAt = (dependencies.now ?? currentDate)();
  return benchmarkResult({
    config,
    finishedAt,
    recorder,
    startedAt,
    ...outcome,
    cleanupIncomplete: shutdownIncomplete || outcome.cleanupIncomplete,
  });
}

async function executeSession(
  config: BenchmarkConfig,
  runtime: BenchmarkRuntime,
  terminal: Promise<AgentEvent>,
  cleanupTimeoutMs: number,
  signal?: AbortSignal,
) {
  const state: SessionState = { requested: false };
  let usage;
  let terminalEvent: AgentEvent | undefined;
  let cleanupIncomplete = false;
  try {
    if (signal?.aborted) throw new BenchmarkCancelledError("Benchmark cancelled.");
    const execution = startSession(config, runtime, terminal, state, cleanupTimeoutMs);
    terminalEvent = await waitForTerminal(execution, config.timeoutMs, signal);
  } catch (error) {
    state.failure = error;
    cleanupIncomplete = state.requested && !state.sessionId;
    cleanupIncomplete ||= !(await abortSession(runtime, state.sessionId, cleanupTimeoutMs));
  } finally {
    if (state.sessionId) {
      const collected = await boundedCleanup(() => runtime.sessions.usage(state.sessionId!), cleanupTimeoutMs);
      usage = collected.value;
      cleanupIncomplete ||= !collected.completed;
    }
  }
  return { cleanupIncomplete, failure: state.failure, sessionId: state.sessionId, terminalEvent, usage };
}

async function startSession(
  config: BenchmarkConfig,
  runtime: BenchmarkRuntime,
  terminal: Promise<AgentEvent>,
  state: SessionState,
  cleanupTimeoutMs: number,
) {
  state.requested = true;
  const { sessionId } = await runtime.sessions.startDevelopment(sessionInput(config));
  if (state.failure) {
    await abortSession(runtime, sessionId, cleanupTimeoutMs);
    throw state.failure;
  }
  state.sessionId = sessionId;
  return terminal;
}

export function runtimeFactory(
  events: { emit(event: AgentEvent): void },
  harness: BenchmarkConfig["harness"],
  config: BenchmarkConfig,
) {
  return new BlameAgentRuntime(events, {
    developmentHarness: harness,
    modelInactivityTimeoutMs: config.timeoutMs,
    ...(harness === "blame" && config.projectMemoryFile
      ? { projectMemoryPersistence: new ProjectMemoryFile(config.projectMemoryFile) }
      : {}),
  });
}

function sessionInput(config: BenchmarkConfig): BenchmarkSessionInput {
  return {
    isolatedEnvironment: config.isolatedEnvironment,
    apiConnection: { token: config.apiToken, url: config.apiUrl },
    credentialLabel: config.credentialLabel,
    cwd: config.workspaceRoot,
    maxIterations: config.maxIterations,
    modelId: config.modelId,
    providerId: config.providerId,
    projectId: config.projectId,
    reasoningEffort: config.reasoningEffort,
    summary: config.instruction,
    ...(config.requiredChecks ? { requiredChecks: config.requiredChecks } : {}),
    title: "Requested task",
    workspaceRoot: config.workspaceRoot,
  };
}

function terminalObserver(recorder: BenchmarkEventRecorder) {
  let active = true;
  let resolveTerminal: (event: AgentEvent) => void = () => undefined;
  const promise = new Promise<AgentEvent>((resolve) => {
    resolveTerminal = resolve;
  });
  const record = (event: AgentEvent) => {
    if (!active) return false;
    recorder.record(event);
    return true;
  };
  return {
    events: {
      captureHiddenToolEvent: record,
      emit(event: AgentEvent) {
        if (record(event) && isTerminalEvent(event)) resolveTerminal(event);
      },
    },
    promise,
    stop: () => { active = false; },
  };
}

function isTerminalEvent(event: AgentEvent) {
  if (event.type === "done") return true;
  if (event.type !== "error") return false;
  return recordValue(event.payload)?.recoverable !== true;
}

function waitForTerminal(
  terminal: Promise<AgentEvent>,
  timeoutMs: number,
  signal?: AbortSignal,
) {
  return new Promise<AgentEvent>((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      return true;
    };
    const resolveOnce = (event: AgentEvent) => {
      if (finish()) resolve(event);
    };
    const rejectOnce = (error: unknown) => {
      if (finish()) reject(error);
    };
    const timer = setTimeout(
      () => rejectOnce(new BenchmarkTimeoutError("Benchmark timed out.")),
      timeoutMs,
    );
    const cancel = () =>
      rejectOnce(new BenchmarkCancelledError("Benchmark cancelled."));
    if (signal?.aborted) return cancel();
    signal?.addEventListener("abort", cancel, { once: true });
    terminal.then(resolveOnce, rejectOnce);
  });
}

async function abortSession(runtime: BenchmarkRuntime, sessionId: string | undefined, timeoutMs: number) {
  if (!sessionId) return true;
  return (await boundedCleanup(() => runtime.sessions.abort(sessionId), timeoutMs)).completed;
}

function benchmarkResult(input: {
  cleanupIncomplete?: boolean;
  config: BenchmarkConfig;
  failure?: unknown;
  finishedAt: Date;
  recorder: BenchmarkEventRecorder;
  sessionId?: string;
  startedAt: Date;
  terminalEvent?: AgentEvent;
  usage?: BenchmarkResult["usage"];
}): BenchmarkResult {
  const terminalPayload = recordValue(input.terminalEvent?.payload);
  return {
    ...(input.cleanupIncomplete ? { cleanupIncomplete: true } : {}),
    completion: terminalPayload?.completion,
    durationMs: input.finishedAt.getTime() - input.startedAt.getTime(),
    error: resultError(input.failure, input.terminalEvent),
    eventCount: input.recorder.eventCount,
    finishedAt: input.finishedAt.toISOString(),
    harness: input.config.harness,
    isolatedEnvironment: input.config.isolatedEnvironment === true,
    metrics: input.recorder.metrics(input.startedAt, input.finishedAt),
    modelId: input.config.modelId,
    providerId: input.config.providerId,
    reasoningEffort: input.config.reasoningEffort,
    maxIterations: input.config.maxIterations,
    timeoutMs: input.config.timeoutMs,
    schemaVersion: 1,
    sessionId: input.sessionId,
    startedAt: input.startedAt.toISOString(),
    status: resultStatus(input.failure, input.terminalEvent),
    taskId: input.config.taskId,
    toolEventCount: input.recorder.toolEventCount,
    usage: input.usage,
    verified: booleanValue(terminalPayload?.verified),
  };
}

function resultStatus(failure: unknown, terminal?: AgentEvent) {
  if (failure instanceof BenchmarkTimeoutError) return "timed_out" as const;
  if (failure instanceof BenchmarkCancelledError) return "cancelled" as const;
  if (failure || terminal?.type === "error") return "failed" as const;
  return "succeeded" as const;
}

function resultError(failure: unknown, terminal?: AgentEvent) {
  if (failure) return errorMessage(failure);
  if (terminal?.type !== "error") return undefined;
  return String(
    recordValue(terminal.payload)?.message ?? "Agent session failed.",
  );
}

function recordValue(value: unknown) {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function booleanValue(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function currentDate() {
  return new Date();
}
