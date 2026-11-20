//! Durable storage for session logs.
//!
//! Implements the core's `SessionStore` on an embedded SQLite database that
//! lives on the machine the engine runs on, and replicates it to a
//! `RemoteLog` in the background so a session can be reopened elsewhere.
//!
//! The layout in short:
//!
//! - one SQLite file in WAL mode holds every session (`records` keyed by
//!   `(session, seq)`), the small blobs and the replication marks;
//! - blobs above [`StoreOptions::inline_blob_max`] live as files in a
//!   directory beside the database, written and synced *before* their
//!   catalog row commits;
//! - SQLite calls run on three plain threads (writer, reader/replication,
//!   file I/O) so no async worker ever blocks, and the crate needs nothing
//!   from tokio but its channels (`sync`): it never spawns, and it sleeps
//!   through the injected `Clock`.

//! # Durability and what it costs
//!
//! Measured on an Apple SSD (APFS), three records of 2 KB per append, release
//! build, `cargo test -p blame-engine-store --release --test bench -- --ignored`:
//!
//! | level | appends/s | p50 | p99 |
//! | --- | --- | --- | --- |
//! | [`Durability::Full`] (default) | ~200 | 5.0 ms | 12 ms |
//! | [`Durability::OsCrash`] | ~10 800 | 0.07 ms | 0.4 ms |
//! | [`Durability::Relaxed`] | ~12 500 | 0.05 ms | 0.14 ms |
//!
//! The 50x gap is the point: on macOS `fsync` returns without asking the drive
//! to empty its cache, so only `F_FULLFSYNC` (what `Full` uses) makes a commit
//! survive a power cut. The loop stores a handful of records per model
//! request, a request lasts seconds, so 5 ms per append is noise and the
//! default stays the safe one. Three sessions appending at once queue behind
//! one writer (p50 14 ms); group commit would remove that and is not needed
//! at this rate.
//!
//! # Blobs: rows or files
//!
//! Measured the same way, durable writes, per blob (rows | files):
//!
//! | size | write | read |
//! | --- | --- | --- |
//! | 64 KiB | 5.4 ms \| 14.1 ms | 0.07 \| 0.06 ms |
//! | 1 MiB | 14.0 ms \| 16.8 ms | 1.07 \| 0.26 ms |
//! | 5 MiB | 38.3 ms \| 22.7 ms | 3.7 \| 0.7 ms |
//! | 20 MiB | 84.1 ms \| 38.3 ms | 15.3 \| 1.6 ms |
//!
//! Rows also write every byte twice (WAL, then checkpoint), keep the WAL and
//! the main file large for ever, and make every backup and replication scan of
//! the database carry the images. Files win from about 1 MiB; rows win below
//! 256 KiB because a file costs two flushes (file, directory). Hence the
//! hybrid: up to [`StoreOptions::inline_blob_max`] a row, above a file.
//!
mod blobs;
mod config;
mod db;
mod error;
mod race;
mod replication;
mod schema;
mod store;

pub use config::{Durability, ReplicationConfig, StoreOptions};
pub use replication::{ReplicationLag, Replicator, SessionLag};
pub use store::SqliteStore;
