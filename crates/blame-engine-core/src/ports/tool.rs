use async_trait::async_trait;
use blame_engine_protocol::{
    Refusal, Seq, SessionConfig, SessionId, ToolCallId, ToolOutcome, ToolResultBlock, ToolSpec,
    TurnId,
};
use serde_json::Value;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, PartialEq)]
pub struct ToolInvocation {
    pub session: SessionId,
    pub turn: TurnId,
    pub call: ToolCallId,
    pub name: String,
    pub input: Value,
    pub workspace_root: String,
    /// `through` of the compaction in effect when the call runs; `None` when
    /// the history was never compacted. A tool that remembers what the model
    /// has already seen (the harness's read coverage) must forget it when
    /// this changes: the summary no longer shows what was read before.
    pub compacted_through: Option<Seq>,
    /// A message of the turn asked for ultra mode (`UserBlock::Ultra`): the
    /// call may start helper agents. Read from the log when the call runs,
    /// so it is the same on a restart.
    pub ultra: bool,
    /// The person approved this call (it needed their approval): a harness
    /// command the chat asked about may then change the repository.
    pub approved: bool,
    /// The session's model reads images ([`super::ModelProvider::reads_images`]):
    /// a tool may then answer with one, such as a screenshot or a drawing
    /// the harness reads from the workspace.
    pub images: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ToolOutput {
    pub outcome: ToolOutcome,
    pub content: Vec<ToolResultBlock>,
    /// Why a result tool refused the call, when it says so.
    pub refusal: Option<Refusal>,
}

impl ToolOutput {
    pub fn text(outcome: ToolOutcome, text: impl Into<String>) -> Self {
        Self {
            outcome,
            content: vec![ToolResultBlock::Text { text: text.into() }],
            refusal: None,
        }
    }
}

/// Receives the output of a tool while it runs. Never stored.
pub type ToolProgress = Arc<dyn Fn(String) + Send + Sync>;

/// What became of a call that the engine did not see finish.
#[derive(Clone, Debug, PartialEq)]
pub enum InterruptedCall {
    /// It never took effect: running it again is safe.
    NotApplied,
    /// It did take effect, and this is its result.
    Applied(ToolOutput),
    /// Nobody can tell. The model is told the call was interrupted.
    Unknown,
}

/// A set of tools the engine can run. The harness is one host, the client's
/// tools another, an MCP server a third; the loop treats them alike.
#[async_trait]
pub trait ToolHost: Send + Sync {
    /// The tools offered to a session with this configuration. Called when a
    /// session opens; the answer must be stable for the session's lifetime,
    /// since tool definitions are part of the cached prompt prefix.
    async fn specs(&self, config: &SessionConfig) -> Vec<ToolSpec>;

    /// Runs one call to completion. Failures are reported in the output, as a
    /// result the model can read; a tool never fails the turn. When `cancel`
    /// fires the tool must stop promptly and return `ToolOutcome::Cancelled`.
    async fn call(
        &self,
        invocation: ToolInvocation,
        progress: ToolProgress,
        cancel: CancellationToken,
    ) -> ToolOutput;

    /// Asked once per call found started but not finished when a session is
    /// reopened after a crash.
    async fn interrupted(&self, invocation: &ToolInvocation) -> InterruptedCall;

    /// Whether this call needs the person's approval although its tool does
    /// not always (`ToolSpec::needs_approval`): asked before it runs. The same
    /// answer for the same call, so a restart asks the same.
    async fn needs_approval(&self, _name: &str, _input: &Value, _config: &SessionConfig) -> bool {
        false
    }
}
