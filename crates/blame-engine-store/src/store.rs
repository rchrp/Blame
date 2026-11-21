use crate::blobs;
use crate::config::StoreOptions;
use crate::db::Worker;
use crate::error::sql;
use crate::schema::{self, Role};
use async_trait::async_trait;
use blame_engine_core::ports::{
    BlobSource, Clock, RemoteLog, SessionStore, StoreError, StoredSession,
};
use blame_engine_protocol::{BlobRef, Record, RecordBody, Seq, SessionId, SessionKind};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::sync::Notify;

/// The durable log of every session of one engine, in one SQLite file.
///
/// Cheap to clone; clones share the same threads and connections. Several
/// stores (in one process or several) may be opened on the same file: the
/// `expected_head` check runs inside SQLite's write lock, so it holds across
/// all of them.
#[derive(Clone)]
pub struct SqliteStore {
    pub(crate) inner: Arc<Inner>,
}

pub(crate) struct Inner {
    /// The only connection that appends records and blobs. Its commits follow
    /// the configured durability.
    pub(crate) writer: Worker<Connection>,
    /// Reads and replication marks; its commits never wait for the disk.
    pub(crate) side: Worker<Connection>,
    /// Hashing and blob files: a big write must not queue appends behind it.
    pub(crate) files: Worker<()>,
    pub(crate) blob_dir: PathBuf,
    pub(crate) clock: Arc<dyn Clock>,
    pub(crate) remote: Option<Arc<dyn RemoteLog>>,
    pub(crate) options: StoreOptions,
    /// Rung after each local write so the replicator looks right away.
    pub(crate) wake: Notify,
    /// Rung after each replication pass, for whoever waits for a flush.
    pub(crate) progress: Notify,
    pub(crate) last_error: Mutex<Option<String>>,
}

impl SqliteStore {
    /// Opens (creating it if needed) the database at `path`. Blocking: call it
    /// at startup, not from a hot path. Blobs too large for a row go to a
    /// `<name>-blobs` directory next to the file.
    pub fn open(
        path: impl AsRef<Path>,
        clock: Arc<dyn Clock>,
        options: StoreOptions,
    ) -> Result<Self, StoreError> {
        let path = path.as_ref();
        let mut writer = schema::open(path, Role::Writer(options.durability))?;
        schema::ensure_schema(&mut writer)?;
        let side = schema::open(path, Role::Side)?;
        let blob_dir = blobs::blob_dir(path);
        blobs::prepare_dir(&blob_dir)?;
        let inner = Inner {
            writer: Worker::spawn("store-writer", writer)?,
            side: Worker::spawn("store-reader", side)?,
            files: Worker::spawn("store-files", ())?,
            blob_dir,
            clock,
            remote: options.remote.clone(),
            options,
            wake: Notify::new(),
            progress: Notify::new(),
            last_error: Mutex::new(None),
        };
        Ok(Self {
            inner: Arc::new(inner),
        })
    }

    /// Stores content that is already known to be on the remote (pulled from
    /// it), so the replicator does not send it back.
    pub(crate) async fn store_blob(
        &self,
        media_type: &str,
        bytes: Vec<u8>,
        remote_has_it: bool,
    ) -> Result<BlobRef, StoreError> {
        let inline_max = self.inner.options.inline_blob_max;
        let dir = self.inner.blob_dir.clone();
        // Hashing and the file write run on the files thread: a multi-MiB
        // image must not hold up the writer's next commit.
        let (sha256, len, inline) = self
            .inner
            .files
            .run(move |()| {
                let sha256 = blobs::sha256_hex(&bytes);
                let len = bytes.len() as u64;
                if bytes.len() > inline_max {
                    blobs::write_file(&dir, &sha256, &bytes)?;
                    Ok((sha256, len, None))
                } else {
                    Ok((sha256, len, Some(bytes)))
                }
            })
            .await?;
        let blob = BlobRef {
            sha256,
            media_type: media_type.to_owned(),
            bytes: len,
        };
        let row = blob.clone();
        self.inner
            .writer
            .run(move |conn| {
                // Content is its address: a row that exists already holds the
                // same bytes, so the first writer wins and the rest is a no-op.
                conn.prepare_cached(
                    "INSERT OR IGNORE INTO blobs (sha256, media_type, bytes, data, pushed)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                )
                .and_then(|mut s| {
                    s.execute(params![
                        row.sha256,
                        row.media_type,
                        int(row.bytes),
                        inline,
                        remote_has_it
                    ])
                })
                .map_err(sql)?;
                Ok(())
            })
            .await?;
        if !remote_has_it {
            self.inner.wake.notify_one();
        }
        Ok(blob)
    }

    /// The bytes of a blob this store holds, `None` when it does not.
    pub(crate) async fn local_blob(&self, sha256: &str) -> Result<Option<Vec<u8>>, StoreError> {
        if !blobs::is_sha256_hex(sha256) {
            return Ok(None);
        }
        let address = sha256.to_owned();
        let row = self
            .inner
            .side
            .run(move |conn| {
                conn.prepare_cached("SELECT bytes, data FROM blobs WHERE sha256 = ?1")
                    .and_then(|mut s| {
                        s.query_row([&address], |r| {
                            Ok((r.get::<_, i64>(0)?, r.get::<_, Option<Vec<u8>>>(1)?))
                        })
                        .optional()
                    })
                    .map_err(sql)
                    .map(|row| row.map(|(len, data)| (address, len, data)))
            })
            .await?;
        let Some((sha256, len, data)) = row else {
            return Ok(None);
        };
        let len = uint(len)?;
        let dir = self.inner.blob_dir.clone();
        self.inner
            .files
            .run(move |()| match data {
                Some(bytes) => blobs::verify(&sha256, len, bytes),
                None => blobs::read_file(&dir, &sha256, len),
            })
            .await
            .map(Some)
    }
}

#[async_trait]
impl SessionStore for SqliteStore {
    async fn append(
        &self,
        session: &SessionId,
        expected_head: Seq,
        bodies: Vec<RecordBody>,
    ) -> Result<Vec<Record>, StoreError> {
        if bodies.is_empty() {
            return Ok(Vec::new());
        }
        let now = self.inner.clock.now_ms();
        let session = session.clone();
        let records = self
            .inner
            .writer
            .run(move |conn| append_in_transaction(conn, &session, expected_head, bodies, now))
            .await?;
        self.inner.wake.notify_one();
        Ok(records)
    }

    async fn read(
        &self,
        session: &SessionId,
        after: Seq,
        limit: Option<u32>,
    ) -> Result<Vec<Record>, StoreError> {
        let session = session.clone();
        self.inner
            .side
            .run(move |conn| read_records(conn, &session, after, limit, None))
            .await
    }

    async fn sessions(&self) -> Result<Vec<StoredSession>, StoreError> {
        self.inner
            .side
            .run(|conn| {
                let mut statement = conn
                    .prepare_cached(
                        "SELECT id, head, updated_at_ms FROM sessions ORDER BY updated_at_ms DESC, id",
                    )
                    .map_err(sql)?;
                let rows = statement
                    .query_map([], |r| {
                        Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))
                    })
                    .map_err(sql)?;
                let mut sessions = Vec::new();
                for row in rows {
                    let (id, head, updated_at_ms) = row.map_err(sql)?;
                    sessions.push(StoredSession {
                        session: SessionId(id),
                        head: uint(head)?,
                        updated_at_ms: uint(updated_at_ms)?,
                    });
                }
                Ok(sessions)
            })
            .await
    }

    async fn put_blob(&self, media_type: &str, bytes: Vec<u8>) -> Result<BlobRef, StoreError> {
        self.store_blob(media_type, bytes, false).await
    }
}

#[async_trait]
impl BlobSource for SqliteStore {
    async fn blob(&self, sha256: &str) -> Result<Option<Vec<u8>>, StoreError> {
        if let Some(bytes) = self.local_blob(sha256).await? {
            return Ok(Some(bytes));
        }
        // Not here: a session hydrated from the remote refers to images this
        // engine never saw. Fetch on first use and keep them.
        let Some(remote) = &self.inner.remote else {
            return Ok(None);
        };
        if !blobs::is_sha256_hex(sha256) {
            return Ok(None);
        }
        let Some(bytes) = remote.pull_blob(sha256).await? else {
            return Ok(None);
        };
        let len = bytes.len() as u64;
        let bytes = blobs::verify(sha256, len, bytes)?;
        // The remote hands back bytes only. The media type that matters is
        // the one in the record's own `BlobRef`; this row's is never read
        // (the blob is marked as on the remote, so it is never pushed again).
        self.store_blob("application/octet-stream", bytes.clone(), true)
            .await?;
        Ok(Some(bytes))
    }
}

/// The remote mark of a session kept on this machine only.
pub(crate) const LOCAL_ONLY: i64 = i64::MAX;

fn stays_local(records: &[Record]) -> bool {
    matches!(
        records.first().map(|record| &record.body),
        Some(RecordBody::SessionCreated { config })
            if config.kind == SessionKind::Task { replicate: false }
    )
}

impl SqliteStore {
    /// Deletes a session's records from this machine, with the blobs (its
    /// screenshots, attachments) no other session's records name: a blob is
    /// shared by content, so one another conversation still shows stays.
    /// `false` when there was no such session.
    pub async fn delete(&self, session: &SessionId) -> Result<bool, StoreError> {
        let id = session.clone();
        let dir = self.inner.blob_dir.clone();
        let (removed, files) = self
            .inner
            .writer
            .run(move |conn| {
                let tx = conn
                    .transaction_with_behavior(TransactionBehavior::Immediate)
                    .map_err(sql)?;
                let mut hashes: Vec<String> = Vec::new();
                {
                    let mut statement = tx
                        .prepare_cached("SELECT body FROM records WHERE session = ?1")
                        .map_err(sql)?;
                    let bodies = statement
                        .query_map([id.as_str()], |r| r.get::<_, String>(0))
                        .map_err(sql)?;
                    for body in bodies {
                        for hash in blob_hashes(&body.map_err(sql)?) {
                            if !hashes.contains(&hash) {
                                hashes.push(hash);
                            }
                        }
                    }
                }
                tx.prepare_cached("DELETE FROM records WHERE session = ?1")
                    .and_then(|mut s| s.execute([id.as_str()]))
                    .map_err(sql)?;
                let removed = tx
                    .prepare_cached("DELETE FROM sessions WHERE id = ?1")
                    .and_then(|mut s| s.execute([id.as_str()]))
                    .map_err(sql)?;
                let mut files = Vec::new();
                for hash in hashes {
                    let used = tx
                        .prepare_cached("SELECT 1 FROM records WHERE instr(body, ?1) > 0 LIMIT 1")
                        .and_then(|mut s| s.exists([hash.as_str()]))
                        .map_err(sql)?;
                    if used {
                        continue;
                    }
                    let on_disk: Option<bool> = tx
                        .prepare_cached("SELECT data IS NULL FROM blobs WHERE sha256 = ?1")
                        .and_then(|mut s| s.query_row([hash.as_str()], |r| r.get(0)).optional())
                        .map_err(sql)?;
                    tx.prepare_cached("DELETE FROM blobs WHERE sha256 = ?1")
                        .and_then(|mut s| s.execute([hash.as_str()]))
                        .map_err(sql)?;
                    if on_disk == Some(true) {
                        files.push(hash);
                    }
                }
                tx.commit().map_err(sql)?;
                Ok((removed > 0, files))
            })
            .await?;
        // After the commit: a file outlives its row at worst, never the
        // reverse.
        for hash in files {
            let _ = std::fs::remove_file(dir.join(hash));
        }
        Ok(removed)
    }

    /// Sessions kept on this machine only (tasks that were not replicated)
    /// whose last record is older than `before_ms`.
    pub async fn local_sessions_before(
        &self,
        before_ms: u64,
    ) -> Result<Vec<SessionId>, StoreError> {
        self.inner
            .side
            .run(move |conn| {
                let mut statement = conn
                    .prepare_cached(
                        "SELECT id FROM sessions WHERE remote_head = ?1 AND updated_at_ms < ?2",
                    )
                    .map_err(sql)?;
                let rows = statement
                    .query_map(params![LOCAL_ONLY, int(before_ms)], |r| {
                        r.get::<_, String>(0)
                    })
                    .map_err(sql)?;
                rows.map(|row| row.map(SessionId).map_err(sql)).collect()
            })
            .await
    }
}

pub(crate) fn int(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

pub(crate) fn uint(value: i64) -> Result<u64, StoreError> {
    u64::try_from(value)
        .map_err(|_| StoreError::Corrupt(format!("negative number {value} in the database")))
}

fn append_in_transaction(
    conn: &mut Connection,
    session: &SessionId,
    expected_head: Seq,
    bodies: Vec<RecordBody>,
    now_ms: u64,
) -> Result<Vec<Record>, StoreError> {
    // Encode before taking the write lock: a body that cannot be encoded
    // fails the whole call without having blocked anyone.
    let encoded = bodies
        .iter()
        .map(serde_json::to_string)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| StoreError::Io(format!("a record cannot be encoded: {e}")))?;

    // IMMEDIATE takes the write lock now, so the head read below cannot be
    // changed by another connection (another engine process included) before
    // this transaction commits. That is the whole `expected_head` guarantee.
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sql)?;
    let current = tx
        .prepare_cached("SELECT head, updated_at_ms FROM sessions WHERE id = ?1")
        .and_then(|mut s| {
            s.query_row([session.as_str()], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
            })
            .optional()
        })
        .map_err(sql)?;
    let (head, last_at_ms) = match current {
        Some((head, at)) => (uint(head)?, uint(at)?),
        None => (0, 0),
    };
    if current.is_none() && expected_head != 0 {
        return Err(StoreError::UnknownSession(session.clone()));
    }
    if head != expected_head {
        return Err(if expected_head == 0 {
            StoreError::SessionExists(session.clone())
        } else {
            StoreError::Conflict {
                session: session.clone(),
                expected: expected_head,
                head,
            }
        });
    }

    // One stamp for the batch, never behind the session's last record even if
    // the system clock stepped back or two engines' clocks disagree.
    let at_ms = now_ms.max(last_at_ms);
    let mut records = Vec::with_capacity(bodies.len());
    {
        let mut insert = tx
            .prepare_cached(
                "INSERT INTO records (session, seq, at_ms, body) VALUES (?1, ?2, ?3, ?4)",
            )
            .map_err(sql)?;
        for (offset, (body, json)) in bodies.into_iter().zip(&encoded).enumerate() {
            let seq = head + 1 + offset as u64;
            insert
                .execute(params![session.as_str(), int(seq), int(at_ms), json])
                .map_err(sql)?;
            records.push(Record { seq, at_ms, body });
        }
    }
    let new_head = head + records.len() as u64;
    if current.is_some() {
        tx.prepare_cached("UPDATE sessions SET head = ?2, updated_at_ms = ?3 WHERE id = ?1")
            .and_then(|mut s| s.execute(params![session.as_str(), int(new_head), int(at_ms)]))
            .map_err(sql)?;
    } else {
        // A task that did not ask to be copied stays on this machine: its
        // remote mark is set past any seq, so the replicator never sees it
        // behind (no schema change: the log's first record says it).
        let remote_head = if stays_local(&records) { LOCAL_ONLY } else { 0 };
        tx.prepare_cached(
            "INSERT INTO sessions (id, head, updated_at_ms, remote_head) VALUES (?1, ?2, ?3, ?4)",
        )
        .and_then(|mut s| {
            s.execute(params![
                session.as_str(),
                int(new_head),
                int(at_ms),
                remote_head
            ])
        })
        .map_err(sql)?;
    }
    // The commit is the point of no return, and where the sync happens.
    tx.commit().map_err(sql)?;
    Ok(records)
}

/// Reads records after `after`. Stops at `limit` records or once `max_bytes`
/// of JSON were read (always returning at least one record). A read that is
/// not cut short must reach the head with no gap; anything else is damage.
pub(crate) fn read_records(
    conn: &mut Connection,
    session: &SessionId,
    after: Seq,
    limit: Option<u32>,
    max_bytes: Option<usize>,
) -> Result<Vec<Record>, StoreError> {
    // One read transaction: head and rows come from the same snapshot even
    // while another engine appends.
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Deferred)
        .map_err(sql)?;
    let head = tx
        .prepare_cached("SELECT head FROM sessions WHERE id = ?1")
        .and_then(|mut s| {
            s.query_row([session.as_str()], |r| r.get::<_, i64>(0))
                .optional()
        })
        .map_err(sql)?;
    let Some(head) = head else {
        return Err(StoreError::UnknownSession(session.clone()));
    };
    let head = uint(head)?;
    if after >= head {
        return Ok(Vec::new());
    }

    let mut statement = tx
        .prepare_cached(
            "SELECT seq, at_ms, body FROM records WHERE session = ?1 AND seq > ?2 ORDER BY seq LIMIT ?3",
        )
        .map_err(sql)?;
    let mut rows = statement
        .query(params![
            session.as_str(),
            int(after),
            limit.map_or(-1, i64::from)
        ])
        .map_err(sql)?;
    let mut records = Vec::new();
    let mut next = after + 1;
    let mut bytes = 0usize;
    while let Some(row) = rows.next().map_err(sql)? {
        let seq = uint(row.get(0).map_err(sql)?)?;
        let at_ms = uint(row.get(1).map_err(sql)?)?;
        let json: String = row.get(2).map_err(sql)?;
        if seq != next {
            return Err(StoreError::Corrupt(format!(
                "session {session} jumps from record {} to {seq}",
                next - 1
            )));
        }
        let body: RecordBody = serde_json::from_str(&json).map_err(|e| {
            StoreError::Corrupt(format!(
                "record {seq} of session {session} cannot be decoded: {e}"
            ))
        })?;
        bytes += json.len();
        records.push(Record { seq, at_ms, body });
        next += 1;
        if max_bytes.is_some_and(|max| bytes >= max) {
            break;
        }
    }
    if limit.is_none() && max_bytes.is_none() && next - 1 != head {
        return Err(StoreError::Corrupt(format!(
            "session {session} ends at record {} but its head is {head}",
            next - 1
        )));
    }
    Ok(records)
}

/// The blob hashes a record names (`"sha256":"<64 hex>"` of its blob refs).
fn blob_hashes(body: &str) -> Vec<String> {
    const KEY: &str = "\"sha256\":\"";
    let mut hashes = Vec::new();
    let mut rest = body;
    while let Some(at) = rest.find(KEY) {
        rest = &rest[at + KEY.len()..];
        if let Some(hash) = rest.get(..64)
            && blobs::is_sha256_hex(hash)
            && rest[64..].starts_with('"')
        {
            hashes.push(hash.to_owned());
        }
    }
    hashes
}
