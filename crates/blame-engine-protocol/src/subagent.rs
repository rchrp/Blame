//! Helper agents ("ultra mode"): what the lead's `run_agents` call carries,
//! what it returns, and how a helper's session is named.
//!
//! A helper is a task session of its own (its own records, see
//! [`SessionKind`](crate::SessionKind)) that the engine starts for one call
//! of the lead. The link is the call: the helper at position `index` of the
//! call `call` is the session [`sub_agent_session`] names, whoever asks.
//! Its configuration says the same in `tool_options.subagent`
//! ([`SubAgentOrigin`]).

use crate::ids::{SessionId, ToolCallId};
use serde::{Deserialize, Serialize};

/// The lead's tool.
pub const RUN_AGENTS: &str = "run_agents";
/// The tool a helper ends with; its input is a [`SubAgentReport`].
pub const REPORT: &str = "report";
/// The name of a helper's engine tool set, and of its `tool_options` entry.
pub const SUBAGENTS: &str = "subagents";
/// `SessionConfig::purpose` of a helper is this, then `:` and its role.
pub const SUB_AGENT_PURPOSE: &str = "sub-agent";
/// Most helpers one call may start.
pub const MAX_AGENTS_PER_CALL: usize = 4;

/// Read-only roles, fixed by the engine: the lead picks one and writes the
/// brief, never a prompt or a permission.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum SubAgentRole {
    /// Reads the code of the workspace.
    Explore,
    /// Reads the web.
    Research,
    /// Reads the workspace's current changes and reports findings.
    Review,
}

impl SubAgentRole {
    pub const ALL: [Self; 3] = [Self::Explore, Self::Research, Self::Review];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Explore => "explore",
            Self::Research => "research",
            Self::Review => "review",
        }
    }
}

/// One helper the lead asks for.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct SubAgentBrief {
    pub role: SubAgentRole,
    /// A few words naming the question, shown to the person.
    pub title: String,
    /// All the helper knows: what to find out, where, and what to hand back.
    pub brief: String,
}

/// Input of `run_agents`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct RunAgentsInput {
    pub agents: Vec<SubAgentBrief>,
}

/// One thing a helper points at: `path:line` in the workspace, or a URL.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct SubAgentReference {
    #[serde(rename = "ref")]
    #[cfg_attr(feature = "ts", ts(rename = "ref"))]
    pub reference: String,
    pub note: String,
}

/// Input of a helper's `report`: its result, once accepted.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct SubAgentReport {
    pub summary: String,
    pub references: Vec<SubAgentReference>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum SubAgentStatus {
    Completed,
    Failed,
    /// Stopped with the lead's turn (an interrupt, a rewind, the engine
    /// stopping), or by the person.
    Cancelled,
}

/// How one helper ended, as the lead reads it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(optional_fields))]
pub struct SubAgentResult {
    pub index: u32,
    pub role: SubAgentRole,
    pub title: String,
    pub status: SubAgentStatus,
    /// Its own session: the thread behind the result.
    pub session: SessionId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub report: Option<SubAgentReport>,
    /// Why it did not complete.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Tokens of every request it made: input, cache reads and writes, output.
    pub tokens: u64,
    pub duration_ms: u64,
}

/// What the lead reads back from `run_agents`, as JSON text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct RunAgentsResult {
    pub agents: Vec<SubAgentResult>,
    /// Tokens of all of them together.
    pub tokens: u64,
}

/// What `run_agents` reports while it waits (`tool/progress`, never stored):
/// the helpers that wait for a free slot. The records of the others say the
/// rest.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct RunAgentsProgress {
    pub queued: Vec<u32>,
}

/// `tool_options.subagent` of a helper's configuration: where it comes from.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct SubAgentOrigin {
    /// The lead's session.
    pub lead: SessionId,
    pub call: ToolCallId,
    pub index: u32,
    pub role: SubAgentRole,
}

/// The session of the helper at position `index` of the call `call`. Call
/// ids are random and engine-made, so this never repeats; it stays within the
/// 64 characters a session id may have in Blame's database.
pub fn sub_agent_session(call: &ToolCallId, index: u32) -> SessionId {
    SessionId(format!("{call}.{index}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_helper_is_named_by_its_call() {
        let call = ToolCallId::from("call-0123456789abcdef0123456789abcdef");
        assert_eq!(
            sub_agent_session(&call, 2).as_str(),
            "call-0123456789abcdef0123456789abcdef.2"
        );
    }

    #[test]
    fn a_reference_is_written_ref() {
        let reference = SubAgentReference {
            reference: "src/a.ts:12".into(),
            note: "the entry point".into(),
        };
        assert_eq!(
            serde_json::to_value(&reference).expect("serializes"),
            serde_json::json!({ "ref": "src/a.ts:12", "note": "the entry point" })
        );
    }
}
