//! The plan an agent keeps while it works: a short list of steps it ticks off.
//!
//! The plan is not stored anywhere of its own. It is the input of the
//! session's latest completed `update_plan` call, so it is a projection of
//! the log like everything else: a rewind, a fork and a restart give the plan
//! the log gives.

use serde::{Deserialize, Serialize};

/// Where one step of the plan stands.
///
/// A later state may mean a step was *proven* done (replayed checks); that
/// would be a new variant, and nothing here assumes the four are all.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum StepStatus {
    Pending,
    /// The step being worked on now. A plan has at most one.
    InProgress,
    Completed,
    /// Dropped on purpose; the step says why.
    Abandoned,
}

impl StepStatus {
    /// The step still has to be done or dropped.
    pub fn is_open(self) -> bool {
        matches!(self, Self::Pending | Self::InProgress)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(optional_fields))]
pub struct PlanStep {
    /// One short imperative sentence.
    pub step: String,
    pub status: StepStatus,
    /// Why the step was abandoned. Only abandoned steps have one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// The input of an `update_plan` call: the whole plan, replacing the
/// previous one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct UpdatePlan {
    pub plan: Vec<PlanStep>,
}
