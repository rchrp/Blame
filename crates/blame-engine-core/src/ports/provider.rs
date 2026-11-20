use super::store::BlobSource;
use async_trait::async_trait;
use blame_engine_protocol::{
    AssistantBlock, BlockKind, ErrorInfo, ErrorKind, ModelRef, ReasoningEffort, StopReason,
    ToolCallId, ToolOutcome, ToolResultBlock, ToolSpec, Usage, UserBlock,
};
use futures_core::Stream;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

/// One call to a model: the full context, in the order it is sent.
#[derive(Clone)]
pub struct ModelRequest {
    pub model: ModelRef,
    pub system: String,
    pub messages: Vec<ModelMessage>,
    /// In a stable order: tool definitions are part of the cached prefix.
    pub tools: Vec<ToolSpec>,
    pub reasoning: Option<ReasoningEffort>,
    pub max_output_tokens: Option<u32>,
    /// The model must call this tool in its reply. Only set when
    /// [`ModelProvider::forces_tool`] said the model can be made to.
    pub forced_tool: Option<String>,
    pub cache: CachePlan,
    /// Where the bytes of the request's images and documents are read from.
    pub blobs: Arc<dyn BlobSource>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ModelMessage {
    User(Vec<UserBlock>),
    Assistant(Vec<AssistantBlock>),
    ToolResults(Vec<ToolResultMessage>),
}

#[derive(Clone, Debug, PartialEq)]
pub struct ToolResultMessage {
    pub call: ToolCallId,
    pub outcome: ToolOutcome,
    pub content: Vec<ToolResultBlock>,
}

/// How the request should use the provider's prompt cache. The loop decides
/// it; each provider maps it to what its API offers and ignores the rest.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CachePlan {
    /// Stable per session, for providers that route by cache key.
    pub key: String,
    /// Indexes into `messages` after which the prefix is worth caching.
    pub breakpoints: Vec<usize>,
    /// Ask for the longest retention on the system prompt and tools, which
    /// stay identical for the whole session.
    pub long_lived_prefix: bool,
}

/// What a provider reports while it answers. `BlockFinished` carries the
/// complete block; the deltas before it are only there to be shown.
#[derive(Clone, Debug, PartialEq)]
pub enum ModelEvent {
    BlockStarted {
        index: u32,
        kind: BlockKind,
        /// Name of the tool, for `BlockKind::ToolCall`.
        tool: Option<String>,
    },
    TextDelta {
        index: u32,
        text: String,
    },
    ReasoningDelta {
        index: u32,
        text: String,
    },
    ToolInputDelta {
        index: u32,
        json: String,
    },
    BlockFinished {
        index: u32,
        block: AssistantBlock,
    },
    /// Always the last event of a stream that did not fail.
    Finished {
        stop: StopReason,
        usage: Usage,
    },
}

pub type ModelStream = Pin<Box<dyn Stream<Item = Result<ModelEvent, ProviderError>> + Send>>;

#[derive(Clone, Debug, thiserror::Error)]
#[error("{message}")]
pub struct ProviderError {
    pub kind: ErrorKind,
    pub message: String,
    pub retry_after: Option<Duration>,
}

impl ProviderError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            retry_after: None,
        }
    }
}

impl From<ProviderError> for ErrorInfo {
    fn from(error: ProviderError) -> Self {
        Self {
            kind: error.kind,
            message: error.message,
            retry_after_ms: error
                .retry_after
                .map(|wait| u64::try_from(wait.as_millis()).unwrap_or(u64::MAX)),
        }
    }
}

/// Access to models. Implementations translate, authenticate and stream;
/// they never retry and never keep conversation state. Retrying, backing off
/// and giving up are the loop's decisions, so they are recorded and behave
/// the same for every provider.
#[async_trait]
pub trait ModelProvider: Send + Sync {
    /// Starts the request. Dropping the stream cancels it.
    async fn stream(&self, request: ModelRequest) -> Result<ModelStream, ProviderError>;

    /// Whether a request to `model` can force the tool the model calls
    /// (`ModelRequest::forced_tool`). The loop only corrects a model in
    /// words where it cannot.
    fn forces_tool(&self, _model: &ModelRef) -> bool {
        false
    }
}
