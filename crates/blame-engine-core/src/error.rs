use crate::ports::{CheckpointError, StoreError};
use blame_engine_protocol::{Seq, TurnId};

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Checkpoint(#[from] CheckpointError),
    /// A store write failed earlier: what is on disk may differ from what
    /// this engine holds, so the session must be opened again.
    #[error("the session stopped after a storage failure ({0}); open it again")]
    Broken(String),
    #[error("the session is closed")]
    Closed,
    #[error("cannot rewind to record {to}: {reason}")]
    InvalidRewind { to: Seq, reason: String },
    #[error("the latest record is not a rewind")]
    NothingToUndo,
    #[error("cannot fork at record {at}: {reason}")]
    InvalidFork { at: Seq, reason: String },
    #[error("the stored log is not a valid session: {0}")]
    InvalidLog(String),
    /// A task takes no messages, no rewind and no new configuration.
    #[error("the session is a task: {0}")]
    Task(&'static str),
    #[error("invalid completion contract: {0}")]
    InvalidContract(String),
    /// Withdraw or promote named a turn that is not waiting in the queue
    /// (it runs, ended, or never existed).
    #[error("turn {0} is not waiting in the queue")]
    NotQueued(TurnId),
}
