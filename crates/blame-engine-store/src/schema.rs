//! Opening connections: durability pragmas and the versioned schema.

use crate::config::Durability;
use crate::error::sql;
use blame_engine_core::ports::StoreError;
use rusqlite::{Connection, OpenFlags, TransactionBehavior};
use std::path::Path;
use std::time::Duration;

/// Bumped whenever the tables change. There is no migration: a database of
/// another version is refused rather than guessed at.
pub(crate) const SCHEMA_VERSION: i32 = 1;

const SCHEMA: &str = "
CREATE TABLE sessions (
    id            TEXT PRIMARY KEY,
    head          INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    -- Highest seq the remote has acknowledged. Losing an update of it only
    -- makes the replicator push again, which is harmless.
    remote_head   INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
CREATE INDEX sessions_unreplicated ON sessions (updated_at_ms) WHERE head > remote_head;

-- A rowid table on purpose: records are tens of KiB, far above the size
-- WITHOUT ROWID is good for.
CREATE TABLE records (
    session TEXT NOT NULL,
    seq     INTEGER NOT NULL,
    at_ms   INTEGER NOT NULL,
    body    TEXT NOT NULL,
    PRIMARY KEY (session, seq)
);

CREATE TABLE blobs (
    sha256     TEXT PRIMARY KEY,
    media_type TEXT NOT NULL,
    bytes      INTEGER NOT NULL,
    -- NULL when the content is a file beside the database.
    data       BLOB,
    pushed     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX blobs_unpushed ON blobs (sha256) WHERE pushed = 0;
";

/// How long a connection waits for another one (this process's writer, or
/// another engine on the same file) to release the write lock.
const BUSY_TIMEOUT: Duration = Duration::from_secs(10);

/// What a connection promises about its commits.
#[derive(Clone, Copy)]
pub(crate) enum Role {
    /// Commits are the durable record: they follow the configured level.
    Writer(Durability),
    /// Reads, plus replication marks. Losing a mark in a power cut costs one
    /// repeated push, so its commits never wait for the disk.
    Side,
}

pub(crate) fn open(path: &Path, role: Role) -> Result<Connection, StoreError> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(sql)?;
    connection.busy_timeout(BUSY_TIMEOUT).map_err(sql)?;

    // WAL: readers never block the writer and the writer never blocks readers,
    // and a commit costs one sequential append plus one sync instead of the
    // rollback journal's several.
    let mode: String = connection
        .query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))
        .map_err(sql)?;
    if !mode.eq_ignore_ascii_case("wal") {
        return Err(StoreError::Io(format!(
            "the database cannot use WAL (journal mode is {mode}); is it on a network drive?"
        )));
    }

    let (synchronous, fullfsync) = match role {
        // FULL syncs the WAL on every commit. With WAL, NORMAL would sync only
        // at checkpoints and could lose acknowledged commits in a power cut.
        Role::Writer(Durability::Full) => ("FULL", true),
        Role::Writer(Durability::OsCrash) => ("FULL", false),
        Role::Writer(Durability::Relaxed) | Role::Side => ("NORMAL", false),
    };
    connection
        .execute_batch(&format!(
            "PRAGMA synchronous = {synchronous};
             -- macOS only: fsync() does not flush the drive's own cache there,
             -- F_FULLFSYNC does. Ignored on every other platform.
             PRAGMA fullfsync = {fullfsync};
             PRAGMA checkpoint_fullfsync = {fullfsync};
             -- Keep the WAL file from staying huge after a big checkpoint.
             PRAGMA journal_size_limit = 67108864;
             PRAGMA cache_size = -4096;"
        ))
        .map_err(sql)?;
    Ok(connection)
}

/// Creates the tables of a new database or checks the version of an existing
/// one. Safe to race: two engines starting on a fresh file serialize on the
/// write lock and the second finds the tables there.
pub(crate) fn ensure_schema(connection: &mut Connection) -> Result<(), StoreError> {
    let version = user_version(connection)?;
    if version == SCHEMA_VERSION {
        return Ok(());
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sql)?;
    match user_version(&transaction)? {
        SCHEMA_VERSION => Ok(()),
        0 => {
            let tables: i64 = transaction
                .query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get(0))
                .map_err(sql)?;
            if tables != 0 {
                return Err(StoreError::Corrupt(
                    "the file is a SQLite database that is not a Blame session store".into(),
                ));
            }
            transaction.execute_batch(SCHEMA).map_err(sql)?;
            transaction
                .pragma_update(None, "user_version", SCHEMA_VERSION)
                .map_err(sql)?;
            transaction.commit().map_err(sql)
        }
        other => Err(StoreError::Corrupt(format!(
            "the database has schema version {other}, this engine reads version {SCHEMA_VERSION}"
        ))),
    }
}

fn user_version(connection: &Connection) -> Result<i32, StoreError> {
    connection
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(sql)
}
