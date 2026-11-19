use async_trait::async_trait;
use blame_engine_protocol::{BlobRef, Record, RecordBody, Seq, SessionId};

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("session {0} does not exist")]
    UnknownSession(SessionId),
    #[error("session {0} already exists")]
    SessionExists(SessionId),
    /// Another engine holds the session, or the caller's view of it is stale.
    #[error("session {session} is at record {head}, not {expected}")]
    Conflict {
        session: SessionId,
        expected: Seq,
        head: Seq,
    },
    #[error("stored data cannot be read: {0}")]
    Corrupt(String),
    #[error("storage failed: {0}")]
    Io(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredSession {
    pub session: SessionId,
    pub head: Seq,
    pub updated_at_ms: u64,
}

/// The durable log of every session this engine runs. It is the only source
/// of truth: the loop holds nothing that cannot be rebuilt from it.
#[async_trait]
pub trait SessionStore: BlobSource {
    /// Appends `bodies` after record `expected_head` (0 for a new session) and
    /// returns them with their seq and timestamp. The records are on disk
    /// when this returns: the loop acts on a record only after storing it.
    /// All of `bodies` are stored, or none.
    async fn append(
        &self,
        session: &SessionId,
        expected_head: Seq,
        bodies: Vec<RecordBody>,
    ) -> Result<Vec<Record>, StoreError>;

    /// Records with a seq above `after`, oldest first, at most `limit`.
    async fn read(
        &self,
        session: &SessionId,
        after: Seq,
        limit: Option<u32>,
    ) -> Result<Vec<Record>, StoreError>;

    async fn sessions(&self) -> Result<Vec<StoredSession>, StoreError>;

    /// Stores `bytes` once per distinct content and returns its address.
    async fn put_blob(&self, media_type: &str, bytes: Vec<u8>) -> Result<BlobRef, StoreError>;
}

/// Read access to stored bytes, for whoever turns a `BlobRef` back into an
/// image to send to a model.
#[async_trait]
pub trait BlobSource: Send + Sync {
    async fn blob(&self, sha256: &str) -> Result<Option<Vec<u8>>, StoreError>;
}

/// The copy of the logs kept in Blame's database, which outlives the machine
/// the engine runs on. The local store stays the source of truth while a
/// session runs; records are pushed here in the background and pulled from
/// here when a session is opened on an engine that has never seen it.
#[async_trait]
pub trait RemoteLog: Send + Sync {
    /// Offers records in seq order and returns the highest seq the remote now
    /// holds. Pushing a record twice is harmless.
    async fn push(&self, session: &SessionId, records: &[Record]) -> Result<Seq, StoreError>;

    async fn pull(&self, session: &SessionId, after: Seq) -> Result<Vec<Record>, StoreError>;

    async fn push_blob(&self, blob: &BlobRef, bytes: &[u8]) -> Result<(), StoreError>;

    async fn pull_blob(&self, sha256: &str) -> Result<Option<Vec<u8>>, StoreError>;
}
