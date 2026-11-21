//! The vocabulary shared by every part of the Blame agent engine.
//!
//! One set of types serves three purposes, so they can never drift apart:
//!
//! - [`Record`] is what the engine stores. A session *is* its ordered list of
//!   records; the model's history, the UI transcript and crash recovery are
//!   all derived from it.
//! - [`Delta`] is what the engine shows while something is in flight (text
//!   being streamed, a tool still printing). Deltas are never stored: losing
//!   one loses nothing that the next record does not restate.
//! - [`rpc`] is how a client (the desktop app today, a phone through the cloud
//!   later) drives the engine, over any transport that carries JSON lines.
//!
//! This crate has no I/O and no async: it only describes data.

pub mod catalog;
mod content;
mod contract;
mod delta;
mod ids;
mod record;
pub mod rpc;
mod subagent;
#[cfg(feature = "ts")]
pub mod typescript;

pub use content::{
    AssistantBlock, BlobRef, ModelRef, NativeItem, ReasoningEffort, ToolResultBlock, ULTRA_NOTICE,
    Usage, UserBlock,
};
pub use contract::{
    CompletionContract, Obligation, Refusal, ResultTool, SessionKind, TaskFailure, TaskOutcome,
};
pub use delta::{BlockKind, Delta, SessionActivity};
pub use ids::{CheckpointId, RequestId, Seq, SessionId, ToolCallId, TurnId};
pub use record::{
    ApprovalDecision, ContextEdit, Delivery, ErrorInfo, ErrorKind, Limits, NoticeLevel, Record,
    RecordBody, SessionConfig, StopReason, ToolEffect, ToolOutcome, ToolSpec, TurnOutcome,
    WorkspaceRestore,
};
pub use subagent::{
    MAX_AGENTS_PER_CALL, REPORT, RUN_AGENTS, RunAgentsInput, RunAgentsProgress, RunAgentsResult,
    SUB_AGENT_PURPOSE, SUBAGENTS, SubAgentBrief, SubAgentOrigin, SubAgentReference, SubAgentReport,
    SubAgentResult, SubAgentRole, SubAgentStatus, sub_agent_session,
};

/// Bumped on any change a client or a stored session could not read.
pub const PROTOCOL_VERSION: u32 = 1;
