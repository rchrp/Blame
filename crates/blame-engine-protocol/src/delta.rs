use crate::ids::{RequestId, ToolCallId};
use serde::{Deserialize, Serialize};

/// Something in flight, sent to attached clients and never stored. A client
/// that misses deltas (it was closed, the link dropped) rebuilds the same
/// state from the records that follow.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Delta {
    BlockStarted {
        request: RequestId,
        index: u32,
        kind: BlockKind,
        /// Set for `BlockKind::ToolCall`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        call: Option<ToolCallId>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tool: Option<String>,
    },
    Text {
        request: RequestId,
        index: u32,
        text: String,
    },
    Reasoning {
        request: RequestId,
        index: u32,
        text: String,
    },
    /// A fragment of the tool call's input JSON.
    ToolInput {
        request: RequestId,
        index: u32,
        json: String,
    },
    /// Output of a tool that is still running.
    ToolProgress {
        call: ToolCallId,
        text: String,
    },
    Activity {
        activity: SessionActivity,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BlockKind {
    Text,
    Reasoning,
    ToolCall,
}

/// What a session is doing right now.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum SessionActivity {
    Idle,
    /// A request is sent and nothing has come back yet.
    Waiting,
    Streaming,
    RunningTools,
    AwaitingApproval,
    /// A failed request will be sent again in `in_ms`.
    Retrying {
        in_ms: u64,
    },
    Compacting,
    Rewinding,
}
