use crate::content::{
    AssistantBlock, ModelRef, ReasoningEffort, ToolResultBlock, Usage, UserBlock,
};
use crate::contract::{CompletionContract, Obligation, SessionKind};
use crate::ids::{CheckpointId, RequestId, Seq, ToolCallId, TurnId};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One durable fact about a session. Records are appended, never changed or
/// deleted: undoing something appends a record that says so.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
// `Record` is a TypeScript built-in; shadowing it would break every
// `Record<K, V>` in the generated file.
#[cfg_attr(feature = "ts", ts(rename = "SessionRecord"))]
pub struct Record {
    pub seq: Seq,
    /// Milliseconds since the Unix epoch, stamped by the store.
    pub at_ms: u64,
    #[serde(flatten)]
    pub body: RecordBody,
}

/// The engine writes a record *before* it acts on it (a tool starts only once
/// `ToolCallStarted` is stored), so after a crash the log says exactly how far
/// each step got.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(optional_fields))]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RecordBody {
    /// Always the first record of a session. The configuration is boxed:
    /// it is by far the largest body and the rarest one.
    SessionCreated {
        config: Box<SessionConfig>,
    },
    /// Replaces the whole configuration from here on (model switch, new
    /// tools). Earlier records keep the meaning they had.
    ConfigChanged {
        config: Box<SessionConfig>,
    },

    /// A message from the user. `Delivery::Turn` opens `turn`; `Steer` is
    /// handed to the model inside the running `turn`, at its next request.
    UserMessage {
        turn: TurnId,
        input: Vec<UserBlock>,
        delivery: Delivery,
    },
    /// The workspace as it was when `turn` opened.
    CheckpointCreated {
        turn: TurnId,
        checkpoint: CheckpointId,
        /// Opaque to everything but the checkpointer that wrote it.
        snapshot: String,
    },
    TurnEnded {
        turn: TurnId,
        outcome: TurnOutcome,
    },

    /// A request is about to be sent. `prefix_digest` identifies the exact
    /// bytes of context sent, so a broken prompt cache can be traced to the
    /// request that changed the prefix.
    RequestStarted {
        turn: TurnId,
        request: RequestId,
        model: ModelRef,
        /// 1 for the first try of this step, then one more per retry.
        attempt: u32,
        prefix_digest: String,
    },
    /// The complete reply to `request`. A reply cut mid-stream is never
    /// stored: the request is recorded as failed and sent again.
    AssistantMessage {
        turn: TurnId,
        request: RequestId,
        blocks: Vec<AssistantBlock>,
        stop: StopReason,
        usage: Usage,
    },
    RequestFailed {
        turn: TurnId,
        request: RequestId,
        error: ErrorInfo,
    },

    ApprovalRequested {
        turn: TurnId,
        call: ToolCallId,
    },
    ApprovalResolved {
        turn: TurnId,
        call: ToolCallId,
        decision: ApprovalDecision,
    },
    /// Written before the tool runs. A `ToolCallStarted` with no matching
    /// `ToolCallFinished` is a call that a crash interrupted.
    ToolCallStarted {
        turn: TurnId,
        call: ToolCallId,
        name: String,
        effect: ToolEffect,
    },
    ToolCallFinished {
        turn: TurnId,
        call: ToolCallId,
        outcome: ToolOutcome,
        content: Vec<ToolResultBlock>,
    },

    /// From the next request on, every record up to `through` is represented
    /// to the model by `summary`. The records themselves stay, so a rewind to
    /// before this point is always possible.
    ContextCompacted {
        through: Seq,
        summary: String,
        usage: Usage,
    },
    /// Changes to how earlier blocks are shown to the model (a stale read
    /// replaced by a pointer). Stored so a restarted engine rebuilds the
    /// byte-identical context and keeps the provider's prompt cache.
    ContextEdited {
        edits: Vec<ContextEdit>,
    },

    /// A rewind is under way. Without a later `RewindFinished` naming this
    /// record, recovery runs the rewind again; it is idempotent.
    RewindStarted {
        /// Last record that stays in effect.
        to: Seq,
        /// Workspace state to restore; absent for a conversation-only rewind.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        checkpoint: Option<CheckpointId>,
        /// The workspace as it was just before the restore, taken so that
        /// `RewindUndone` can put the files back too. Opaque, like
        /// `CheckpointCreated::snapshot`; absent when no files are restored.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        undo_snapshot: Option<String>,
    },
    /// Every record after `to` and up to this one no longer counts.
    RewindFinished {
        /// Seq of the `RewindStarted` record this completes.
        started: Seq,
        to: Seq,
        workspace: WorkspaceRestore,
        /// Commands the undone turns ran, whose effects outside the tracked
        /// files (databases, installed packages) were not undone.
        unreverted_commands: Vec<String>,
    },
    /// Puts back what the rewind finished at `rewind` removed. Only valid as
    /// the next record after that `RewindFinished`.
    RewindUndone {
        rewind: Seq,
    },

    Notice {
        level: NoticeLevel,
        /// Stable identifier for the client to translate or act on.
        code: String,
        text: String,
    },

    /// The call is the turn's result: it met the completion contract. The
    /// turn ends with it.
    ResultAccepted {
        turn: TurnId,
        call: ToolCallId,
    },
    /// A call of the result tool was refused before it took effect; the
    /// model reads why as the call's error and may try again.
    ResultRejected {
        turn: TurnId,
        call: ToolCallId,
        /// Where the input does not match the result tool's schema.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        #[cfg_attr(feature = "ts", ts(as = "Option<Vec<String>>", optional))]
        invalid: Vec<String>,
        /// What the turn still had to do first.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        #[cfg_attr(feature = "ts", ts(as = "Option<Vec<Obligation>>", optional))]
        unmet: Vec<Obligation>,
    },
    /// The model stopped without fulfilling the contract. `text` is sent to
    /// it as the next message of the turn; it is the same for the same
    /// contract and the same unmet obligations.
    ContractCorrection {
        turn: TurnId,
        /// 1 for the first correction of the turn.
        attempt: u32,
        unmet: Vec<Obligation>,
        text: String,
        /// The tool the next request forces the model to call, when the
        /// provider can force a choice.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        forced_tool: Option<String>,
    },
}

/// Everything the engine needs to run a session, stored with it so the
/// session can be reopened by another engine, on another machine.
/// Credentials are never part of it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(optional_fields))]
pub struct SessionConfig {
    /// What the session is for (`development`, `title`, `merge-conflict`…).
    pub purpose: String,
    /// Absolute path as seen by the engine process.
    pub workspace_root: String,
    pub model: ModelRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<ReasoningEffort>,
    pub system_prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u32>,
    /// Tool sets that run inside the engine, next to the workspace, by name.
    #[serde(default)]
    pub engine_tools: Vec<String>,
    /// Tools the client runs on the engine's behalf (previews, anything that
    /// needs the desktop). Unavailable while no client is attached.
    #[serde(default)]
    pub client_tools: Vec<ToolSpec>,
    /// Settings of each engine tool set, by its name in `engine_tools`
    /// (the harness takes its task contract here). Opaque to the loop: only
    /// the tool host reads them.
    #[serde(default)]
    pub tool_options: serde_json::Map<String, Value>,
    #[serde(default)]
    pub limits: Limits,
    /// Whether a workspace checkpoint is taken at the start of each turn.
    #[serde(default)]
    pub checkpoints: bool,
    /// A conversation, or a task (see `task/run`).
    #[serde(default, skip_serializing_if = "SessionKind::is_conversation")]
    #[cfg_attr(feature = "ts", ts(as = "Option<SessionKind>", optional))]
    pub kind: SessionKind,
    /// How each turn must end, enforced by the engine. A task always has
    /// one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contract: Option<CompletionContract>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(optional_fields))]
pub struct Limits {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_requests_per_turn: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_parallel_tool_calls: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_context_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_cost_micro_usd: Option<u64>,
    /// Wall time of one turn, from the message that opened it. A request or
    /// a tool still running then is stopped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_turn_ms: Option<u64>,
    /// Tokens of one turn, every request counted (input, cache reads and
    /// writes, output). Checked before each request.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_turn_tokens: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    /// JSON Schema of the input object.
    pub input_schema: Value,
    pub effect: ToolEffect,
    /// The turn ends when this tool succeeds (`finish_task`).
    #[serde(default)]
    pub ends_turn: bool,
    /// The user must approve each call.
    #[serde(default)]
    pub needs_approval: bool,
}

/// What a tool can change. It decides whether calls may run side by side and
/// what recovery does with a call that a crash interrupted.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum ToolEffect {
    /// Changes nothing: safe to run in parallel and to run again.
    ReadOnly,
    /// Changes workspace files only; a checkpoint can undo it.
    WorkspaceWrite,
    /// Runs a command whose effects may reach outside the workspace.
    Command,
    /// Acts on something outside the machine (an API, a deployment).
    External,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum ToolOutcome {
    Completed,
    /// The tool ran and reported an error.
    Failed,
    /// The user or a policy refused the call; it did not run.
    Denied,
    /// The user stopped the turn while it ran.
    Cancelled,
    /// The engine died while it ran: what it did is unknown. The model is
    /// told so instead of being left with a call that never returns.
    Interrupted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum Delivery {
    /// Opens a new turn.
    Turn,
    /// Joins the turn already running.
    Steer,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum TurnOutcome {
    Completed,
    /// Stopped by the user.
    Interrupted,
    /// Stopped by a limit of the session's configuration.
    LimitReached {
        limit: String,
    },
    Failed {
        error: ErrorInfo,
    },
    /// The model kept stopping without fulfilling the completion contract,
    /// past its corrections.
    ContractUnmet {
        unmet: Vec<Obligation>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    EndTurn,
    ToolUse,
    MaxOutputTokens,
    Refusal,
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum ApprovalDecision {
    Approved,
    Denied,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct ContextEdit {
    /// Record holding the block.
    pub target: Seq,
    /// Index of the block within that record's content.
    pub block: u32,
    /// Text shown to the model in place of the block.
    pub replacement: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum WorkspaceRestore {
    Restored,
    /// The rewind was asked for the conversation only.
    NotRequested,
    Failed {
        message: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum NoticeLevel {
    Info,
    Warning,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(optional_fields))]
pub struct ErrorInfo {
    pub kind: ErrorKind,
    pub message: String,
    /// How long the provider asked to wait before trying again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    RateLimited,
    Overloaded,
    /// The request no longer fits the model's context window.
    ContextOverflow,
    Authentication,
    /// Quota, credit or subscription limits.
    Billing,
    InvalidRequest,
    /// The connection failed or dropped.
    Transport,
    /// The provider stopped sending without closing the stream.
    Stalled,
    Cancelled,
    Internal,
}

impl ErrorKind {
    /// Whether sending the same request again can succeed.
    pub fn is_retryable(self) -> bool {
        matches!(
            self,
            Self::RateLimited | Self::Overloaded | Self::Transport | Self::Stalled
        )
    }
}
