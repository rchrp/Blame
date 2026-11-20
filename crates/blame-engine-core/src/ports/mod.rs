//! What the loop needs from the outside world. Each trait has one production
//! implementation in its own crate and an in-memory fake for tests.

mod approval;
mod checkpoint;
mod provider;
mod store;
mod system;
mod tool;

pub use approval::{ApprovalRequest, Approver};
pub use checkpoint::{CheckpointError, Checkpointer, PathChange, PathChangeKind};
pub use provider::{
    CachePlan, ModelEvent, ModelMessage, ModelProvider, ModelRequest, ModelStream, ProviderError,
    ToolResultMessage,
};
pub use store::{BlobSource, RemoteLog, SessionStore, StoreError, StoredSession};
pub use system::{Clock, IdSource};
pub use tool::{InterruptedCall, ToolHost, ToolInvocation, ToolOutput, ToolProgress};
