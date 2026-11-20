// Generated from crates/blame-engine-protocol by `pnpm generate`. Do not edit.

export const PROTOCOL_VERSION = 1;

// prettier-ignore
export type Approval = { decision: ApprovalDecision, };

// prettier-ignore
export type ApprovalDecision = "approved" | "denied";

// prettier-ignore
export type AssistantBlock = { "type": "text", text: string, native?: NativeItem, } | { "type": "reasoning", 
/**
 * Readable summary, possibly empty when the provider hides it.
 */
text: string, native?: NativeItem, } | { "type": "tool_call", call: ToolCallId, name: string, input: JsonValue, native?: NativeItem, } | { "type": "opaque", native: NativeItem, };

// prettier-ignore
export type AuthKind = "api_key" | "subscription" | "optional";

// prettier-ignore
export type BlobPulled = { 
/**
 * The bytes, base64-encoded; absent when the database has no such blob.
 */
data?: string, };

// prettier-ignore
export type BlobRef = { 
/**
 * Lowercase hex SHA-256 of the bytes.
 */
sha256: string, media_type: string, bytes: number, };

// prettier-ignore
export type BlockKind = "text" | "reasoning" | "tool_call";

// prettier-ignore
export type CatalogSource = "snapshot" | "models_dev";

// prettier-ignore
export type CheckpointId = string;

// prettier-ignore
export type ClientRequest = { "method": "initialize", "params": { protocol_version: number, client_name: string, client_version: string, 
/**
 * The client answers `host/log/*` and `host/blob/*`: sessions are
 * then copied to Blame's database and can be reopened from it.
 */
remote_log: boolean, } } | { "method": "session/create", "params": { session?: SessionId, config: SessionConfig, } } | { "method": "session/open", "params": { session: SessionId, } } | { "method": "session/list", "params": Record<symbol, never> } | { "method": "session/read", "params": { session: SessionId, after: number, limit: number, } } | { "method": "session/subscribe", "params": { session: SessionId, after: number, } } | { "method": "session/unsubscribe", "params": { session: SessionId, } } | { "method": "session/send", "params": { session: SessionId, input: Array<UserBlock>, delivery: Delivery, } } | { "method": "session/interrupt", "params": { session: SessionId, } } | { "method": "session/rewind", "params": { session: SessionId, to: number, restore_workspace: boolean, } } | { "method": "session/undo_rewind", "params": { session: SessionId, } } | { "method": "session/fork", "params": { session: SessionId, at: number, workspace_root: string, } } | { "method": "session/compact", "params": { session: SessionId, } } | { "method": "session/configure", "params": { session: SessionId, config: SessionConfig, } } | { "method": "session/close", "params": { session: SessionId, } } | { "method": "blob/put", "params": { media_type: string, 
/**
 * The bytes, base64-encoded.
 */
data: string, } } | { "method": "tool/progress", "params": { call: ToolCallId, text: string, } } | { "method": "catalog/list", "params": { refresh: boolean, } } | { "method": "shutdown", "params": Record<symbol, never> } | { "method": "$/cancel", "params": { id: number, } };

// prettier-ignore
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
 * Text shown to the model in place of the block. Empty removes the
 * block (a tool result rewritten into fewer parts). A later edit of the
 * same block replaces an earlier one.
 */
replacement: string, };

// prettier-ignore
export type Credential = { "type": "api_key", key: string, base_url?: string, } | { "type": "bearer", token: string, account?: string, base_url?: string, } | { "type": "missing" };

// prettier-ignore
export type Delivery = "turn" | "steer";

// prettier-ignore
export type Delta = { "type": "block_started", request: RequestId, index: number, kind: BlockKind, 
/**
 * Set for `BlockKind::ToolCall`.
 */
call?: ToolCallId, tool?: string, } | { "type": "text", request: RequestId, index: number, text: string, } | { "type": "reasoning", request: RequestId, index: number, text: string, } | { "type": "tool_input", request: RequestId, index: number, json: string, } | { "type": "tool_progress", call: ToolCallId, text: string, } | { "type": "activity", activity: SessionActivity, };

// prettier-ignore
export type EngineNotification = { "method": "session/record", "params": { session: SessionId, record: SessionRecord, } } | { "method": "session/delta", "params": { session: SessionId, delta: Delta, } };

// prettier-ignore
export type EngineRequest = { "method": "host/tool", "params": { session: SessionId, turn: TurnId, call: ToolCallId, name: string, input: JsonValue, } } | { "method": "host/approval", "params": { session: SessionId, turn: TurnId, call: ToolCallId, tool: ToolSpec, input: JsonValue, } } | { "method": "host/credential", "params": { provider: string, 
/**
 * The session the request is for.
 */
session: SessionId, } } | { "method": "host/log/push", "params": { session: SessionId, records: Array<SessionRecord>, } } | { "method": "host/log/pull", "params": { session: SessionId, after: number, } } | { "method": "host/blob/push", "params": { blob: BlobRef, 
/**
 * The bytes, base64-encoded.
 */
data: string, } } | { "method": "host/blob/pull", "params": { sha256: string, } } | { "method": "$/cancel", "params": { id: number, } };

// prettier-ignore
export type ErrorInfo = { kind: ErrorKind, message: string, 
/**
 * How long the provider asked to wait before trying again.
 */
retry_after_ms?: number, };

// prettier-ignore
export type ErrorKind = "rate_limited" | "overloaded" | "context_overflow" | "authentication" | "billing" | "invalid_request" | "model_unavailable" | "transport" | "stalled" | "cancelled" | "internal";

// prettier-ignore
export type Initialized = { protocol_version: number, engine_version: string, };

// prettier-ignore
export type JsonValue = number | string | boolean | Array<JsonValue> | { [key in string]: JsonValue } | null;

// prettier-ignore
export type Limits = { max_requests_per_turn?: number, max_parallel_tool_calls?: number, max_context_tokens?: number, max_cost_micro_usd?: number, };

// prettier-ignore
export type LogPushed = { 
/**
 * Highest seq the database now holds with no gap before it.
 */
acked: number, };

// prettier-ignore
export type MessageAccepted = { turn: TurnId, 
/**
 * False when the message waits for the running turn to end.
 */
started: boolean, };

// prettier-ignore
export type ModelCatalog = { 
/**
 * Every provider the engine serves, in the order to show them.
 */
providers: Array<ProviderInfo>, source: CatalogSource, 
/**
 * When the models.dev data in use was fetched, in milliseconds since
 * the Unix epoch.
 */
fetched_at_ms: number, 
/**
 * Why the last refresh failed, when it did. The list is then the last
 * copy that loaded.
 */
refresh_error?: string, };

// prettier-ignore
export type ModelInfo = { 
/**
 * models.dev's id, which the provider's API takes as is.
 */
id: string, name: string, family?: string, context_window?: number, 
/**
 * When the provider reads less than the context window.
 */
max_input_tokens?: number, max_output_tokens?: number, images: boolean, pdf: boolean, reasoning: ReasoningInfo, 
/**
 * Absent when unknown or billed by subscription.
 */
price?: Price, 
/**
 * `YYYY-MM-DD` or `YYYY-MM`, as models.dev gives it.
 */
release_date?: string, 
/**
 * `alpha` or `beta` while the provider says so.
 */
status?: string, };

// prettier-ignore
export type ModelRef = { 
/**
 * Provider id as the providers crate knows it, e.g. `anthropic`.
 */
provider: string, model: string, };

// prettier-ignore
export type NativeItem = { 
/**
 * Wire family the item belongs to, e.g. `anthropic-messages`.
 */
wire: string, model: ModelRef, item: JsonValue, };

// prettier-ignore
export type NoticeLevel = "info" | "warning";

// prettier-ignore
export type Outcome = { "result": JsonValue } | { "error": RpcError };

// prettier-ignore
export type Price = { input: number, output: number, cache_read?: number, cache_write?: number, };

// prettier-ignore
export type ProviderInfo = { 
/**
 * The id `ModelRef::provider` takes.
 */
id: string, name: string, auth: AuthKind, 
/**
 * Whether the credential must carry a base URL.
 */
needs_base_url: boolean, 
/**
 * The models.dev providers its models come from; empty when the models
 * depend on the server (`openai-compatible`: its own `/models`).
 */
sources: Array<string>, 
/**
 * Newest first. A model missing here can still be used: the provider
 * decides, and says so when it refuses.
 */
models: Array<ModelInfo>, };

// prettier-ignore
export type ReasoningEffort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

// prettier-ignore
export type ReasoningInfo = { supported: boolean, 
/**
 * The levels the model takes, lowest first. A model that takes a
 * token budget lists the levels the engine turns into one. Empty when
 * it reasons but the catalog does not say how it is controlled: any
 * level is then sent as asked.
 */
efforts: Array<ReasoningEffort>, 
/**
 * Whether `ReasoningEffort::Off` turns its reasoning off; otherwise
 * `Off` asks for its lowest level.
 */
can_disable: boolean, default?: ReasoningEffort, };

// prettier-ignore
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

// prettier-ignore
export type Records = { records: Array<SessionRecord>, head: number, };

// prettier-ignore
export type RequestId = string;

// prettier-ignore
export type Rewound = { 
/**
 * Seq of the `RewindFinished` record.
 */
finished: number, };

// prettier-ignore
export type RpcError = { 
/**
 * JSON-RPC code: -32600..-32603 for protocol faults, -32000 otherwise.
 */
code: number, message: string, data?: RpcErrorData, };

// prettier-ignore
export type RpcErrorData = { kind: ErrorKind, };

// prettier-ignore
export type SessionActivity = { "state": "idle" } | { "state": "waiting" } | { "state": "streaming" } | { "state": "running_tools" } | { "state": "awaiting_approval" } | { "state": "retrying", in_ms: number, } | { "state": "compacting" } | { "state": "rewinding" };

// prettier-ignore
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
client_tools: Array<ToolSpec>, 
/**
 * Settings of each engine tool set, by its name in `engine_tools`
 * (the harness takes its task contract here). Opaque to the loop: only
 * the tool host reads them.
 */
tool_options: { [key in string]: JsonValue }, limits: Limits, 
/**
 * Whether a workspace checkpoint is taken at the start of each turn.
 */
checkpoints: boolean, };

// prettier-ignore
export type SessionId = string;

// prettier-ignore
export type SessionList = { sessions: Array<SessionSummary>, };

// prettier-ignore
export type SessionOpened = { session: SessionId, 
/**
 * Seq of the session's latest record.
 */
head: number, activity: SessionActivity, };

// prettier-ignore
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

// prettier-ignore
export type SessionSummary = { session: SessionId, purpose: string, workspace_root: string, head: number, updated_at_ms: number, };

// prettier-ignore
export type StopReason = "end_turn" | "tool_use" | "max_output_tokens" | "refusal" | "other";

// prettier-ignore
export type Subscribed = { head: number, activity: SessionActivity, 
/**
 * Deltas of the reply being streamed right now, so a client that
 * attaches mid-reply shows it from its first character.
 */
in_flight: Array<Delta>, };

// prettier-ignore
export type ToolCallId = string;

// prettier-ignore
export type ToolEffect = "read_only" | "workspace_write" | "command" | "external";

// prettier-ignore
export type ToolOutcome = "completed" | "failed" | "denied" | "cancelled" | "interrupted";

// prettier-ignore
export type ToolResult = { outcome: ToolOutcome, content: Array<ToolResultBlock>, };

// prettier-ignore
export type ToolResultBlock = { "type": "text", text: string, } | { "type": "image", blob: BlobRef, };

// prettier-ignore
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

// prettier-ignore
export type TurnId = string;

// prettier-ignore
export type TurnOutcome = { "status": "completed" } | { "status": "interrupted" } | { "status": "limit_reached", limit: string, } | { "status": "failed", error: ErrorInfo, };

// prettier-ignore
export type Usage = { input_tokens?: number, output_tokens?: number, cache_read_tokens?: number, cache_write_tokens?: number, reasoning_tokens?: number, 
/**
 * Millionths of a US dollar; absent when the price is unknown or the
 * model is billed by subscription.
 */
cost_micro_usd?: number, };

// prettier-ignore
export type UserBlock = { "type": "text", text: string, } | { "type": "image", blob: BlobRef, } | { "type": "document", blob: BlobRef, name: string, };

// prettier-ignore
export type Version = "2.0";

// prettier-ignore
export type WorkspaceRestore = { "status": "restored" } | { "status": "not_requested" } | { "status": "failed", message: string, };
