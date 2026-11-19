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
