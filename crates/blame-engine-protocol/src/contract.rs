//! Tasks and completion contracts.
//!
//! A *task* is an agent run with no user in it: Blame gives an instruction,
//! tools and a contract, and gets back a typed outcome. It is a session like
//! a conversation (the same log, the same recovery), of its own kind: nothing
//! can be sent to it, and it ends by itself.
//!
//! A *completion contract* says how a turn may end. The engine enforces it,
//! not a prompt: the turn ends only through an accepted call of the result
//! tool, made once the required tools completed. A model that stops early is
//! corrected, then forced, and the turn fails when it still does not comply.
//! Conversations carry one too (a development story's turn must end through
//! the harness's `finish_task`), so every enforcement step is a record either
//! way.

use crate::ids::ToolCallId;
use crate::record::ErrorInfo;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// What a session is. Stored in its configuration, which a task never
/// changes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SessionKind {
    /// Driven by messages; runs as many turns as it is sent.
    #[default]
    Conversation,
    /// One turn opened by its instruction, ended by its contract.
    Task {
        /// Copy the log to Blame's database, as conversations are. Otherwise
        /// it stays on this machine only, and the engine deletes it a few
        /// days after it ended: long enough to look into a failure.
        #[serde(default)]
        #[cfg_attr(feature = "ts", ts(as = "Option<bool>", optional))]
        replicate: bool,
    },
}

impl SessionKind {
    pub fn is_conversation(&self) -> bool {
        *self == Self::Conversation
    }

    pub fn is_task(&self) -> bool {
        matches!(self, Self::Task { .. })
    }
}

/// How a turn must end. The engine checks it after every reply.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(optional_fields))]
pub struct CompletionContract {
    /// The call that ends the turn; its input, once accepted, is the result.
    pub result: ResultTool,
    /// Tools that must have completed in the turn, in a reply before the one
    /// that calls the result tool, for a result to be accepted.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[cfg_attr(feature = "ts", ts(as = "Option<Vec<String>>", optional))]
    pub required: Vec<String>,
    /// When set, the only tools the model is offered, besides the result
    /// tool. Absent: every tool of the session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed: Option<Vec<String>>,
    /// Corrective messages sent when the model stops without fulfilling the
    /// contract. The last one also forces the tool choice where the provider
    /// can. Past it the turn fails as `contract_unmet`.
    #[serde(default = "default_corrections")]
    #[cfg_attr(feature = "ts", ts(as = "Option<u32>", optional))]
    pub max_corrections: u32,
}

fn default_corrections() -> u32 {
    2
}

/// Where the result tool comes from.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(tag = "source", rename_all = "snake_case")]
pub enum ResultTool {
    /// A tool the engine offers and answers itself: a call is accepted when
    /// its input matches `input_schema` and the required tools completed.
    Submit {
        name: String,
        description: String,
        input_schema: Value,
    },
    /// One of the session's own tools (the harness's `finish_task`). Its
    /// input is checked against the tool's schema and the obligations before
    /// it runs; the call is accepted once the tool completes. A tool that
    /// fails refuses the result itself, and the model goes on.
    Tool { name: String },
}

impl ResultTool {
    pub fn name(&self) -> &str {
        match self {
            Self::Submit { name, .. } | Self::Tool { name } => name,
        }
    }
}

/// Why the result tool itself refused a call it ran, when it says so in a
/// form the client can act on (the harness's `finish_task`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Refusal {
    /// Checks of the work are still failing, by task: the work is not
    /// verified.
    FailingChecks { tasks: Vec<String> },
}

/// Something a contract asks for that the turn has not done.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Obligation {
    /// A required tool has not completed in this turn.
    Call { tool: String },
    /// No call of the result tool was accepted.
    Result { tool: String },
}

/// How a task ended: the answer to `task/run`, and what the log of a task
/// says once its turn ended.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum TaskOutcome {
    Completed {
        /// The accepted call.
        call: ToolCallId,
        /// Its input, which matched the result tool's schema.
        result: Value,
    },
    Failed {
        failure: TaskFailure,
    },
    /// Cancelled by the client, or stopped by the engine stopping.
    Interrupted,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TaskFailure {
    /// The model ran out of corrections with these obligations unmet.
    ContractUnmet { unmet: Vec<Obligation> },
    /// A limit of the configuration stopped it (`max_turn_ms`…).
    LimitReached { limit: String },
    /// The provider failed in a way retrying did not fix.
    ProviderError { error: ErrorInfo },
}
