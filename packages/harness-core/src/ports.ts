import type {
  ArtifactRef,
  ChangeReceiptRef,
  EvidenceRef,
  ExecutionId,
  HarnessResult,
  SourceRevisionId,
} from "./result.js";

export type ModelExecutionInput = {
  execution_id: ExecutionId;
  objective: string;
  constraints: string[];
  context: unknown;
};

export type ModelEvent = {
  execution_id: ExecutionId;
  sequence: number;
  type: string;
  payload: unknown;
};

export type StopReceipt = {
  execution_id: ExecutionId;
  status: "confirmed" | "pending";
};

export type DisposeReceipt = {
  runtime_id: string;
  disposed: boolean;
};

export interface ModelRuntimePort {
  start(input: ModelExecutionInput): AsyncIterable<ModelEvent>;
  requestStop(executionId: ExecutionId): Promise<StopReceipt>;
  dispose(runtimeId: string): Promise<DisposeReceipt>;
}

export type SourceRevisionSnapshot = {
  source_revision_id: SourceRevisionId;
  worktree_id: string;
  blob_hashes: Record<string, string>;
};

export type ChangePreparation = {
  source_revision_id: SourceRevisionId;
  operation_indexes: number[];
  operations: unknown[];
};

export type PreparedChange = {
  preparation_id: string;
  source_revision_id: SourceRevisionId;
  operation_indexes: number[];
  effective_paths: string[];
  postcondition_satisfied: boolean;
  payload: unknown;
};

export type CommitRequest = {
  prepared_change: PreparedChange;
  expected_source_revision_id: SourceRevisionId;
};

export type ChangeReceipt = {
  receipt_ref: ChangeReceiptRef;
  source_revision_before: SourceRevisionId;
  source_revision_after: SourceRevisionId;
  changed_paths: string[];
  verified: boolean;
  rollback: "not_required" | "complete" | "incomplete";
  recovery_artifact_ref?: ArtifactRef;
};

export interface WorkspacePort {
  observeRevision(): Promise<SourceRevisionSnapshot>;
  prepareChange(input: ChangePreparation): Promise<PreparedChange>;
  commitChange(input: CommitRequest): Promise<ChangeReceipt>;
}

export type PlannedCheck = {
  check_id: string;
  task_id: string;
  obligation_ids: string[];
  cost: EvidenceCost;
};

export type EvidenceCost = {
  duration_ms: number;
  compute_units: number;
};

export type RunReceipt = {
  run_ref: string;
  source_revision_id: SourceRevisionId;
  status: "passed" | "failed" | "unavailable" | "cancelled";
  evidence_refs: EvidenceRef[];
};

export interface TaskExecutionPort {
  execute(input: PlannedCheck, signal: AbortSignal): Promise<RunReceipt>;
}

export type CompactionInput = {
  execution_id: ExecutionId;
  source_revision_id: SourceRevisionId;
  projection: unknown;
};

export type CompactionResult = {
  projection: unknown;
  source_revision_id: SourceRevisionId;
  compacted_at: string;
};

export interface CompactionPort {
  compact(input: CompactionInput): Promise<CompactionResult>;
}

export type CoreToolDefinition = {
  name: string;
  description: string;
  input_schema: unknown;
};

export interface ToolTransportPort {
  publishDefinitions(tools: CoreToolDefinition[]): Promise<void>;
  publishResult(result: HarnessResult<unknown, unknown>): Promise<void>;
}

export type CoreLifecycleEvent = {
  execution_id: ExecutionId;
  sequence: number;
  state: string;
  occurred_at: string;
  reason?: string;
};

export interface LifecycleEventSink {
  publish(event: CoreLifecycleEvent): Promise<void>;
}

export interface CancellationPort {
  signal(executionId: ExecutionId): AbortSignal;
  request(executionId: ExecutionId): void;
}

export interface ClockPort {
  now(): Date;
}

export type AdapterCapabilityManifest = {
  adapter_id: string;
  adapter_version: string;
  transport: "in_process" | "ipc" | "remote";
  streaming: "native" | "buffered" | "unavailable";
  cancellation: "native" | "cooperative" | "unavailable";
  compaction: "native" | "core" | "unavailable";
};
