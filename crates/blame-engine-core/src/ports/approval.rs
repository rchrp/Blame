use async_trait::async_trait;
use blame_engine_protocol::{ApprovalDecision, SessionId, ToolCallId, ToolSpec, TurnId};
use serde_json::Value;

/// One tool call waiting for the user's decision.
#[derive(Clone, Debug, PartialEq)]
pub struct ApprovalRequest {
    pub session: SessionId,
    pub turn: TurnId,
    pub call: ToolCallId,
    pub tool: ToolSpec,
    pub input: Value,
}

/// Asks the user whether a tool call may run. The binary maps it to the
/// `host/approval` request of the client that owns the session.
#[async_trait]
pub trait Approver: Send + Sync {
    /// Resolves once the user has decided. The loop drops the future when
    /// the turn is interrupted, so an implementation must withdraw its
    /// question (`$/cancel`) when dropped. With no client attached, waiting
    /// for one and denying are both valid; the loop records either.
    async fn approve(&self, request: ApprovalRequest) -> ApprovalDecision;
}
