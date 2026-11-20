import type { SessionRecord, TaskOutcome } from "@blame/engine-client";
import type {
  EngineHost,
  ReasoningSelection,
  RequiredProjectCheck,
} from "@blame/agent-runtime/engine";
import type { BenchmarkEvent, usageSummary } from "./engine-events.js";

export type BenchmarkConfig = {
  isolatedEnvironment?: boolean;
  apiUrl: string;
  apiToken: string;
  credentialLabel?: string;
  /** Where the harness writes each call's raw result (next to the events). */
  harnessTracePath: string;
  instruction: string;
  requiredChecks?: RequiredProjectCheck[];
  maxIterations: number;
  modelId: string;
  projectMemoryFile?: string;
  providerId: string;
  projectId?: string;
  reasoningEffort?: ReasoningSelection;
  taskId: string;
  timeoutMs: number;
  workspaceRoot: string;
};

export type BenchmarkStatus =
  | "cancelled"
  | "failed"
  | "succeeded"
  | "timed_out";

export type BenchmarkResult = {
  isolatedEnvironment?: boolean;
  cleanupIncomplete?: boolean;
  reasoningEffort?: ReasoningSelection;
  maxIterations: number;
  timeoutMs: number;
  completion?: unknown;
  durationMs: number;
  error?: string;
  eventCount: number;
  finishedAt: string;
  /** Blame's harness: the only one since the Cline runtime left. */
  harness: "blame";
  metrics: BenchmarkMetrics;
  modelId: string;
  providerId: string;
  schemaVersion: 1;
  sessionId?: string;
  startedAt: string;
  status: BenchmarkStatus;
  taskId: string;
  toolEventCount: number;
  usage?: ReturnType<typeof usageSummary>;
  verified?: boolean;
};

export type BenchmarkMetrics = {
  context: BenchmarkContextMetrics;
  editing: BenchmarkEditingMetrics;
  navigation: BenchmarkNavigationMetrics;
  toolFreeGaps: BenchmarkToolFreeGapMetrics;
  tools: BenchmarkToolMetrics;
  toolsByName: Record<string, BenchmarkNamedToolMetrics>;
};

export type BenchmarkContextMetrics = {
  averageInputTokens: number | null;
  compactions: number;
  maximumInputTokens: number | null;
  /** Requests sent to the model, retries included (from the engine's records). */
  modelRequests: number | null;
  requestObservations: {
    schemaVersion: "request-observations-v1";
    coverage: "engine_records";
    iterationStartEvents: number;
    usageReportEvents: number;
    inputTokenReportEvents: number;
    transportAttempts: number | null;
    completedResponses: number | null;
  };
  toolPayloadBytes: number;
  toolPayloadReplayExposureBytes: number;
};

export type BenchmarkEditingMetrics = {
  attempts: number;
  blocked: number;
  firstAttemptMs?: number;
  firstSuccessMs?: number;
  hybridCalls: number;
  patchOperations: number;
  successful: number;
  symbolOperations: number;
};

export type BenchmarkNavigationMetrics = {
  deduplicatedReads: number;
  readCalls: number;
  returnedBytes: number;
  searchCalls: number;
};

export type BenchmarkToolFreeGapMetrics = {
  countOverThirtySeconds: number;
  maximumMs: number;
  totalOverThirtySecondsMs: number;
};

export type BenchmarkToolMetrics = BenchmarkNamedToolMetrics & {
  distinctTools: number;
};

export type BenchmarkNamedToolMetrics = {
  blockedCalls: number;
  calls: number;
  failedCalls: number;
  inputBytes: number;
  outputBytes: number;
  replayExposureBytes: number;
};

export type BenchmarkPaths = {
  eventsPath: string;
  harnessTracePath: string;
  resultPath: string;
};

/** What a run needs of the engine (a fake one in tests). */
export type BenchmarkEngine = {
  runStoryTask(
    input: Parameters<EngineHost["runStoryTask"]>[0],
  ): Promise<{ session: string; outcome: TaskOutcome }>;
  /** Every record of the run's session, once it has ended. */
  records(session: string): Promise<SessionRecord[]>;
  shutdown(): Promise<void>;
};

export type BenchmarkEventRecorder = {
  readonly eventCount: number;
  readonly toolEventCount: number;
  close(): Promise<void>;
  metrics(startedAt: Date, finishedAt: Date): BenchmarkMetrics;
  record(event: BenchmarkEvent, at?: number): void;
};

export type BenchmarkRunDependencies = {
  cleanupTimeoutMs?: number;
  createRecorder(): BenchmarkEventRecorder;
  createEngine(config: BenchmarkConfig): BenchmarkEngine;
  now?(): Date;
  signal?: AbortSignal;
};
