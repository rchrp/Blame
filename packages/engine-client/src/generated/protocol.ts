// Generated from crates/blame-engine-protocol by `pnpm generate`. Do not edit.

export const PROTOCOL_VERSION = 1

export type Approval = { decision: ApprovalDecision, };

export type ApprovalDecision = "approved" | "denied";

export type AssistantBlock = { "type": "text", text: string, native?: NativeItem, } | { "type": "reasoning", 
/**
 * Readable summary, possibly empty when the provider hides it.
 */
text: string, native?: NativeItem, } | { "type": "tool_call", call: ToolCallId, name: string, input: JsonValue, native?: NativeItem, } | { "type": "opaque", native: NativeItem, };

export type BlobPulled = { 
/**
 * The bytes, base64-encoded; absent when the database has no such blob.
 */
data?: string, };

export type BlobRef = { 
/**
 * Lowercase hex SHA-256 of the bytes.
 */
sha256: string, media_type: string, bytes: number, };

export type BlockKind = "text" | "reasoning" | "tool_call";

export type CheckpointId = string;

export type ClientRequest = { "method": "initialize", "params": { protocol_version: number, client_name: string, client_version: string, 
/**
 * The client answers `host/log/*` and `host/blob/*`: sessions are
 * then copied to Blame's database and can be reopened from it.
 */
remote_log: boolean, } } | { "method": "session/create", "params": { session?: SessionId, config: SessionConfig, } } | { "method": "session/open", "params": { session: SessionId, } } | { "method": "session/list", "params": Record<symbol, never> } | { "method": "session/read", "params": { session: SessionId, after: number, limit: number, } } | { "method": "session/subscribe", "params": { session: SessionId, after: number, } } | { "method": "session/unsubscribe", "params": { session: SessionId, } } | { "method": "session/send", "params": { session: SessionId, input: Array<UserBlock>, delivery: Delivery, } } | { "method": "session/interrupt", "params": { session: SessionId, } } | { "method": "session/rewind", "params": { session: SessionId, to: number, restore_workspace: boolean, } } | { "method": "session/undo_rewind", "params": { session: SessionId, } } | { "method": "session/fork", "params": { session: SessionId, at: number, workspace_root: string, } } | { "method": "session/compact", "params": { session: SessionId, } } | { "method": "session/configure", "params": { session: SessionId, config: SessionConfig, } } | { "method": "session/close", "params": { session: SessionId, } } | { "method": "shutdown", "params": Record<symbol, never> } | { "method": "$/cancel", "params": { id: number, } };

export type ContextEdit = { 
/**
 * Record holding the block.
 */
target: number, 
/**
 * Index of the block within that record's content.
 */
block: number, 
/**
 * Text shown to the model in place of the block.
 */
replacement: string, };

export type Credential = { "type": "api_key", key: string, base_url?: string, } | { "type": "bearer", token: string, account?: string, base_url?: string, } | { "type": "missing" };

export type Delivery = "turn" | "steer";

export type Delta = { "type": "block_started", request: RequestId, index: number, kind: BlockKind, 
/**
 * Set for `BlockKind::ToolCall`.
 */
call?: ToolCallId, tool?: string, } | { "type": "text", request: RequestId, index: number, text: string, } | { "type": "reasoning", request: RequestId, index: number, text: string, } | { "type": "tool_input", request: RequestId, index: number, json: string, } | { "type": "tool_progress", call: ToolCallId, text: string, } | { "type": "activity", activity: SessionActivity, };

export type EngineNotification = { "method": "session/record", "params": { session: SessionId, record: SessionRecord, } } | { "method": "session/delta", "params": { session: SessionId, delta: Delta, } };

export type EngineRequest = { "method": "host/tool", "params": { session: SessionId, turn: TurnId, call: ToolCallId, name: string, input: JsonValue, } } | { "method": "host/approval", "params": { session: SessionId, turn: TurnId, call: ToolCallId, tool: ToolSpec, input: JsonValue, } } | { "method": "host/credential", "params": { provider: string, } } | { "method": "host/log/push", "params": { session: SessionId, records: Array<SessionRecord>, } } | { "method": "host/log/pull", "params": { session: SessionId, after: number, } } | { "method": "host/blob/push", "params": { blob: BlobRef, 
/**
 * The bytes, base64-encoded.
 */
data: string, } } | { "method": "host/blob/pull", "params": { sha256: string, } } | { "method": "$/cancel", "params": { id: number, } };

export type ErrorInfo = { kind: ErrorKind, message: string, 
/**
 * How long the provider asked to wait before trying again.
 */
retry_after_ms?: number, };

export type ErrorKind = "rate_limited" | "overloaded" | "context_overflow" | "authentication" | "billing" | "invalid_request" | "transport" | "stalled" | "cancelled" | "internal";

export type Initialized = { protocol_version: number, engine_version: string, };

export type JsonValue = number | string | boolean | Array<JsonValue> | { [key in string]: JsonValue } | null;

export type Limits = { max_requests_per_turn?: number, max_parallel_tool_calls?: number, max_context_tokens?: number, max_cost_micro_usd?: number, };

export type LogPushed = { 
/**
 * Highest seq the database now holds with no gap before it.
 */
acked: number, };

export type MessageAccepted = { turn: TurnId, 
/**
 * False when the message waits for the running turn to end.
 */
started: boolean, };

export type ModelRef = { 
/**
 * Provider id as the providers crate knows it, e.g. `anthropic`.
 */
provider: string, model: string, };

export type NativeItem = { 
/**
 * Wire family the item belongs to, e.g. `anthropic-messages`.
 */
wire: string, model: ModelRef, item: JsonValue, };

export type NoticeLevel = "info" | "warning";

export type Outcome = { "result": JsonValue } | { "error": RpcError };

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

export type RecordBody = { "type": "session_created", config: SessionConfig, } | { "type": "config_changed", config: SessionConfig, } | { "type": "user_message", turn: TurnId, input: Array<UserBlock>, delivery: Delivery, } | { "type": "checkpoint_created", turn: TurnId, checkpoint: CheckpointId, 
/**
 * Opaque to everything but the checkpointer that wrote it.
 */
snapshot: string, } | { "type": "turn_ended", turn: TurnId, outcome: TurnOutcome, } | { "type": "request_started", turn: TurnId, request: RequestId, model: ModelRef, 
/**
 * 1 for the first try of this step, then one more per retry.
 */
attempt: number, prefix_digest: string, } | { "type": "assistant_message", turn: TurnId, request: RequestId, blocks: Array<AssistantBlock>, stop: StopReason, usage: Usage, } | { "type": "request_failed", turn: TurnId, request: RequestId, error: ErrorInfo, } | { "type": "approval_requested", turn: TurnId, call: ToolCallId, } | { "type": "approval_resolved", turn: TurnId, call: ToolCallId, decision: ApprovalDecision, } | { "type": "tool_call_started", turn: TurnId, call: ToolCallId, name: string, effect: ToolEffect, } | { "type": "tool_call_finished", turn: TurnId, call: ToolCallId, outcome: ToolOutcome, content: Array<ToolResultBlock>, } | { "type": "context_compacted", through: number, summary: string, usage: Usage, } | { "type": "context_edited", edits: Array<ContextEdit>, } | { "type": "rewind_started", 
/**
 * Last record that stays in effect.
 */
to: number, 
/**
 * Workspace state to restore; absent for a conversation-only rewind.
 */
checkpoint?: CheckpointId, 
/**
 * The workspace as it was just before the restore, taken so that
 * `RewindUndone` can put the files back too. Opaque, like
 * `CheckpointCreated::snapshot`; absent when no files are restored.
 */
undo_snapshot?: string, } | { "type": "rewind_finished", 
/**
 * Seq of the `RewindStarted` record this completes.
 */
started: number, to: number, workspace: WorkspaceRestore, 
/**
 * Commands the undone turns ran, whose effects outside the tracked
 * files (databases, installed packages) were not undone.
 */
unreverted_commands: Array<string>, } | { "type": "rewind_undone", rewind: number, } | { "type": "notice", level: NoticeLevel, 
/**
 * Stable identifier for the client to translate or act on.
 */
code: string, text: string, };

export type Records = { records: Array<SessionRecord>, head: number, };

export type RequestId = string;

export type Rewound = { 
/**
 * Seq of the `RewindFinished` record.
 */
finished: number, };

export type RpcError = { 
/**
 * JSON-RPC code: -32600..-32603 for protocol faults, -32000 otherwise.
 */
code: number, message: string, data?: RpcErrorData, };

export type RpcErrorData = { kind: ErrorKind, };

export type SessionActivity = { "state": "idle" } | { "state": "waiting" } | { "state": "streaming" } | { "state": "running_tools" } | { "state": "awaiting_approval" } | { "state": "retrying", in_ms: number, } | { "state": "compacting" } | { "state": "rewinding" };

export type SessionConfig = { 
/**
 * What the session is for (`development`, `title`, `merge-conflict`…).
 */
purpose: string, 
/**
 * Absolute path as seen by the engine process.
 */
workspace_root: string, model: ModelRef, reasoning?: ReasoningEffort, system_prompt: string, max_output_tokens?: number, 
/**
 * Tool sets that run inside the engine, next to the workspace, by name.
 */
engine_tools: Array<string>, 
/**
 * Tools the client runs on the engine's behalf (previews, anything that
 * needs the desktop). Unavailable while no client is attached.
 */
client_tools: Array<ToolSpec>, limits: Limits, 
/**
 * Whether a workspace checkpoint is taken at the start of each turn.
 */
checkpoints: boolean, };

export type SessionId = string;

export type SessionList = { sessions: Array<SessionSummary>, };

export type SessionOpened = { session: SessionId, 
/**
 * Seq of the session's latest record.
 */
head: number, activity: SessionActivity, };

export type SessionRecord = { seq: number, 
/**
 * Milliseconds since the Unix epoch, stamped by the store.
 */
at_ms: number, } & ({ "type": "session_created", config: SessionConfig, } | { "type": "config_changed", config: SessionConfig, } | { "type": "user_message", turn: TurnId, input: Array<UserBlock>, delivery: Delivery, } | { "type": "checkpoint_created", turn: TurnId, checkpoint: CheckpointId, 
/**
 * Opaque to everything but the checkpointer that wrote it.
 */
snapshot: string, } | { "type": "turn_ended", turn: TurnId, outcome: TurnOutcome, } | { "type": "request_started", turn: TurnId, request: RequestId, model: ModelRef, 
/**
 * 1 for the first try of this step, then one more per retry.
 */
attempt: number, prefix_digest: string, } | { "type": "assistant_message", turn: TurnId, request: RequestId, blocks: Array<AssistantBlock>, stop: StopReason, usage: Usage, } | { "type": "request_failed", turn: TurnId, request: RequestId, error: ErrorInfo, } | { "type": "approval_requested", turn: TurnId, call: ToolCallId, } | { "type": "approval_resolved", turn: TurnId, call: ToolCallId, decision: ApprovalDecision, } | { "type": "tool_call_started", turn: TurnId, call: ToolCallId, name: string, effect: ToolEffect, } | { "type": "tool_call_finished", turn: TurnId, call: ToolCallId, outcome: ToolOutcome, content: Array<ToolResultBlock>, } | { "type": "context_compacted", through: number, summary: string, usage: Usage, } | { "type": "context_edited", edits: Array<ContextEdit>, } | { "type": "rewind_started", 
/**
 * Last record that stays in effect.
 */
to: number, 
/**
 * Workspace state to restore; absent for a conversation-only rewind.
 */
checkpoint?: CheckpointId, 
/**
 * The workspace as it was just before the restore, taken so that
 * `RewindUndone` can put the files back too. Opaque, like
 * `CheckpointCreated::snapshot`; absent when no files are restored.
 */
undo_snapshot?: string, } | { "type": "rewind_finished", 
/**
 * Seq of the `RewindStarted` record this completes.
 */
started: number, to: number, workspace: WorkspaceRestore, 
/**
 * Commands the undone turns ran, whose effects outside the tracked
 * files (databases, installed packages) were not undone.
 */
unreverted_commands: Array<string>, } | { "type": "rewind_undone", rewind: number, } | { "type": "notice", level: NoticeLevel, 
/**
 * Stable identifier for the client to translate or act on.
 */
code: string, text: string, });

export type SessionSummary = { session: SessionId, purpose: string, workspace_root: string, head: number, updated_at_ms: number, };

export type StopReason = "end_turn" | "tool_use" | "max_output_tokens" | "refusal" | "other";

export type Subscribed = { head: number, activity: SessionActivity, 
/**
 * Deltas of the reply being streamed right now, so a client that
 * attaches mid-reply shows it from its first character.
 */
in_flight: Array<Delta>, };

export type ToolCallId = string;

export type ToolEffect = "read_only" | "workspace_write" | "command" | "external";

export type ToolOutcome = "completed" | "failed" | "denied" | "cancelled" | "interrupted";

export type ToolResult = { outcome: ToolOutcome, content: Array<ToolResultBlock>, };

export type ToolResultBlock = { "type": "text", text: string, } | { "type": "image", blob: BlobRef, };

export type ToolSpec = { name: string, description: string, 
/**
 * JSON Schema of the input object.
 */
input_schema: JsonValue, effect: ToolEffect, 
/**
 * The turn ends when this tool succeeds (`finish_task`).
 */
ends_turn: boolean, 
/**
 * The user must approve each call.
 */
needs_approval: boolean, };

export type TurnId = string;

export type TurnOutcome = { "status": "completed" } | { "status": "interrupted" } | { "status": "limit_reached", limit: string, } | { "status": "failed", error: ErrorInfo, };

export type Usage = { input_tokens?: number, output_tokens?: number, cache_read_tokens?: number, cache_write_tokens?: number, reasoning_tokens?: number, 
/**
 * Millionths of a US dollar; absent when the price is unknown or the
 * model is billed by subscription.
 */
cost_micro_usd?: number, };

export type UserBlock = { "type": "text", text: string, } | { "type": "image", blob: BlobRef, } | { "type": "document", blob: BlobRef, name: string, };

export type Version = "2.0";

export type WorkspaceRestore = { "status": "restored" } | { "status": "not_requested" } | { "status": "failed", message: string, };
