use blame_engine_core::ports::RemoteLog;
use std::sync::Arc;
use std::time::Duration;

/// How much a returned `append` promises about a power cut. The pragmas each
/// level maps to are in `schema.rs`, what they cost in the crate docs.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Durability {
    /// Survives a power cut. Every commit is flushed through the drive's
    /// cache (`F_FULLFSYNC` on macOS, where plain `fsync` does not do it).
    /// The default: the log is the only copy of the conversation.
    #[default]
    Full,
    /// Survives a crash of the process or of the operating system, but on
    /// macOS the drive's cache may still lose the last commits in a power
    /// cut. Identical to `Full` on Linux, where `fsync` is a real flush.
    OsCrash,
    /// Survives a crash of the process only. The last commits may be lost on
    /// a power cut or kernel panic; the database itself is never corrupted.
    Relaxed,
}

#[derive(Clone, Debug)]
pub struct ReplicationConfig {
    /// Most records sent in one `push`.
    pub batch_records: u32,
    /// Soft cap on the JSON size of one `push` (a single larger record still
    /// goes alone).
    pub batch_bytes: usize,
    /// First retry delay after a failure; doubles on each consecutive one.
    pub backoff_base: Duration,
    pub backoff_max: Duration,
    /// How often an idle replicator looks at the database anyway, to notice
    /// records another engine process appended to the same file.
    pub idle_poll: Duration,
}

impl Default for ReplicationConfig {
    fn default() -> Self {
        Self {
            batch_records: 256,
            batch_bytes: 2 << 20,
            backoff_base: Duration::from_millis(500),
            backoff_max: Duration::from_secs(60),
            idle_poll: Duration::from_secs(5),
        }
    }
}

pub struct StoreOptions {
    pub durability: Durability,
    /// Where to replicate and hydrate from. Without it the store is purely
    /// local.
    pub remote: Option<Arc<dyn RemoteLog>>,
    pub replication: ReplicationConfig,
    /// Blobs up to this size are rows of the database, larger ones files.
    /// 256 KiB sits between the measured crossovers (see the crate docs).
    pub inline_blob_max: usize,
}

impl Default for StoreOptions {
    fn default() -> Self {
        Self {
            durability: Durability::default(),
            remote: None,
            replication: ReplicationConfig::default(),
            inline_blob_max: 256 << 10,
        }
    }
}
