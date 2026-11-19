use async_trait::async_trait;
use blame_engine_protocol::SessionId;
use std::path::Path;

#[derive(Debug, thiserror::Error)]
pub enum CheckpointError {
    #[error("{0} is not a workspace that can be snapshotted")]
    Unsupported(String),
    #[error("snapshot {0} no longer exists")]
    MissingSnapshot(String),
    #[error("checkpoint failed: {0}")]
    Failed(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PathChange {
    /// Relative to the workspace root, with forward slashes.
    pub path: String,
    pub kind: PathChangeKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PathChangeKind {
    Added,
    Modified,
    Deleted,
}

/// Snapshots of a workspace's files, so a session can be rewound.
///
/// A snapshot covers every file that is not ignored, tracked or not. It is
/// independent of the branch: commits, merges and rebases made after it never
/// prevent restoring it, and restoring never rewrites history.
#[async_trait]
pub trait Checkpointer: Send + Sync {
    /// Captures the workspace now and returns a reference only this
    /// checkpointer can read. The snapshot is kept until `release`.
    async fn snapshot(
        &self,
        workspace_root: &Path,
        session: &SessionId,
    ) -> Result<String, CheckpointError>;

    /// Makes the workspace's files identical to the snapshot: changed files
    /// are put back, files created since are removed, ignored files are left
    /// alone. Running it twice gives the same result as running it once.
    async fn restore(&self, workspace_root: &Path, snapshot: &str) -> Result<(), CheckpointError>;

    /// What differs between a snapshot and a later one, or the workspace as
    /// it is now when `to` is `None`.
    async fn changes(
        &self,
        workspace_root: &Path,
        from: &str,
        to: Option<&str>,
    ) -> Result<Vec<PathChange>, CheckpointError>;

    /// Lets go of every snapshot taken for the session.
    async fn release(
        &self,
        workspace_root: &Path,
        session: &SessionId,
    ) -> Result<(), CheckpointError>;
}
