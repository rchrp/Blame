//! Keeping Blame's database in step with the local log, and the way back.
//!
//! The local store is the source of truth while a session runs, so none of
//! this sits on the `append` path: appends only ring a bell
//! (`Notify::notify_one`, which never blocks) and the replicator, a task the
//! binary spawns, does the network work on its own schedule.
//!
//! What it guarantees, whatever the remote does:
//!
//! - **Order.** Records of a session reach the remote in seq order, in
//!   batches that start right after the last acknowledged seq.
//! - **Blobs first.** A record is read, then every unsent blob is pushed,
//!   then the record is. A blob a record refers to was put before the record
//!   was appended, so the remote never holds a record whose blob it lacks.
//! - **Honest marks.** The mark only moves forward, and only as far as the
//!   remote said *and* as far as we sent. A stale, duplicated or inflated
//!   answer cannot lose records or mark unsent ones.
//! - **Isolation.** One session failing (a record the remote rejects) backs
//!   off on its own and never holds up the others.

use crate::blobs;
use crate::error::sql;
use crate::race::{Either, first};
use crate::store::{SqliteStore, int, read_records, uint};
use blame_engine_core::ports::{RemoteLog, StoreError};
use blame_engine_protocol::{BlobRef, Record, Seq, SessionId};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use std::collections::{HashMap, HashSet};
use std::pin::pin;
use std::sync::Arc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

/// A session whose latest records the remote has not acknowledged yet.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionLag {
    pub session: SessionId,
    pub head: Seq,
    /// Highest seq the remote acknowledged.
    pub remote_head: Seq,
}

/// How far the remote is behind. Empty when there is no remote.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ReplicationLag {
    /// Only the sessions that are behind, oldest activity first.
    pub sessions: Vec<SessionLag>,
    /// Blobs the remote does not have yet.
    pub blobs: u64,
    /// The latest failure, kept until a pass succeeds. Tells "nothing to do"
    /// from "cannot reach the remote".
    pub last_error: Option<String>,
}

impl ReplicationLag {
    pub fn is_caught_up(&self) -> bool {
        self.sessions.is_empty() && self.blobs == 0
    }
}

impl SqliteStore {
    /// The replicator for this store, if it was opened with a remote. Run it
    /// with [`Replicator::run`] on the engine's runtime.
    pub fn replicator(&self) -> Option<Replicator> {
        let remote = self.inner.remote.clone()?;
        Some(Replicator {
            store: self.clone(),
            remote,
            backoff: HashMap::new(),
            unreadable_blobs: HashSet::new(),
        })
    }

    /// How far each session is from being on the remote. The binary calls
    /// this (or [`wait_flushed`](Self::wait_flushed)) before exiting.
    pub async fn replication_lag(&self) -> Result<ReplicationLag, StoreError> {
        if self.inner.remote.is_none() {
            return Ok(ReplicationLag::default());
        }
        let (sessions, blobs) = self
            .inner
            .side
            .run(|conn| {
                let sessions = pending_sessions(conn)?;
                let blobs: i64 = conn
                    .prepare_cached("SELECT count(*) FROM blobs WHERE pushed = 0")
                    .and_then(|mut s| s.query_row([], |r| r.get(0)))
                    .map_err(sql)?;
                Ok((sessions, uint(blobs)?))
            })
            .await?;
        Ok(ReplicationLag {
            sessions,
            blobs,
            last_error: self.inner.last_error.lock().ok().and_then(|e| e.clone()),
        })
    }

    /// Waits until the remote has everything, or `timeout` passes. `true`
    /// means caught up. Needs a running [`Replicator`] to make progress.
    pub async fn wait_flushed(&self, timeout: Duration) -> Result<bool, StoreError> {
        let clock = self.inner.clock.clone();
        let mut deadline = pin!(clock.sleep(timeout));
        loop {
            // Register for the next progress report *before* looking, so a
            // pass finishing in between cannot be missed.
            let mut progress = pin!(self.inner.progress.notified());
            progress.as_mut().enable();
            if self.replication_lag().await?.is_caught_up() {
                return Ok(true);
            }
            if let Either::Left(()) = first(&mut deadline, progress).await {
                return Ok(false);
            }
        }
    }

    /// Brings `session` up to what the remote holds, for a session this
    /// engine never ran or ran earlier and has since been continued
    /// elsewhere. Returns the local head afterwards.
    ///
    /// Fails with `UnknownSession` when neither side has it. It cannot tell a
    /// local copy that *diverged* from the remote's (the same seq holding
    /// different records) from one that is merely behind: the remote refuses
    /// pushes that contradict what it holds, which is where that is caught.
    pub async fn hydrate(&self, session: &SessionId) -> Result<Seq, StoreError> {
        let Some(remote) = self.inner.remote.clone() else {
            return Err(StoreError::Io("no remote log is configured".into()));
        };
        // A local append can slip in between our look at the head and the
        // import; that shows as a conflict and we simply look again.
        for _ in 0..8 {
            let local = self.local_head(session).await?;
            let after = local.unwrap_or(0);
            let records = contiguous_after(remote.pull(session, after).await?, after)?;
            if records.is_empty() {
                return local.ok_or_else(|| StoreError::UnknownSession(session.clone()));
            }
            let id = session.clone();
            match self
                .inner
                .writer
                .run(move |conn| import_records(conn, &id, after, &records))
                .await
            {
                Ok(()) => continue,
                Err(StoreError::Conflict { .. }) => continue,
                Err(other) => return Err(other),
            }
        }
        Err(StoreError::Io(format!(
            "session {session} kept changing while it was being hydrated"
        )))
    }

    async fn local_head(&self, session: &SessionId) -> Result<Option<Seq>, StoreError> {
        let id = session.clone();
        let head = self
            .inner
            .side
            .run(move |conn| {
                conn.prepare_cached("SELECT head FROM sessions WHERE id = ?1")
                    .and_then(|mut s| {
                        s.query_row([id.as_str()], |r| r.get::<_, i64>(0))
                            .optional()
                    })
                    .map_err(sql)
            })
            .await?;
        head.map(uint).transpose()
    }
}

/// What a remote's `pull` answer is worth: duplicates and records we already
/// have are dropped, reordered ones sorted, and what remains must start right
/// after `after` with no hole (a hole means the answer cannot be trusted, and
/// storing it would break the log's contiguity).
fn contiguous_after(mut records: Vec<Record>, after: Seq) -> Result<Vec<Record>, StoreError> {
    records.retain(|r| r.seq > after);
    records.sort_by_key(|r| r.seq);
    records.dedup_by_key(|r| r.seq);
    for (offset, record) in records.iter().enumerate() {
        let expected = after + 1 + offset as u64;
        if record.seq != expected {
            return Err(StoreError::Io(format!(
                "the remote answered with record {} where record {expected} was due",
                record.seq
            )));
        }
    }
    Ok(records)
}

/// Stores records that already have their seq and time (they come from the
/// remote), in one transaction. `expected_head` is the head the caller based
/// them on.
fn import_records(
    conn: &mut Connection,
    session: &SessionId,
    expected_head: Seq,
    records: &[Record],
) -> Result<(), StoreError> {
    let (Some(first), Some(last)) = (records.first(), records.last()) else {
        return Ok(());
    };
    let encoded = records
        .iter()
        .map(|r| serde_json::to_string(&r.body))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| StoreError::Io(format!("a record cannot be encoded: {e}")))?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sql)?;
    let head = tx
        .prepare_cached("SELECT head FROM sessions WHERE id = ?1")
        .and_then(|mut s| {
            s.query_row([session.as_str()], |r| r.get::<_, i64>(0))
                .optional()
        })
        .map_err(sql)?
        .map(uint)
        .transpose()?
        .unwrap_or(0);
    if head != expected_head || first.seq != head + 1 {
        return Err(StoreError::Conflict {
            session: session.clone(),
            expected: expected_head,
            head,
        });
    }
    {
        let mut insert = tx
            .prepare_cached(
                "INSERT INTO records (session, seq, at_ms, body) VALUES (?1, ?2, ?3, ?4)",
            )
            .map_err(sql)?;
        for (record, json) in records.iter().zip(&encoded) {
            insert
                .execute(params![
                    session.as_str(),
                    int(record.seq),
                    int(record.at_ms),
                    json
                ])
                .map_err(sql)?;
        }
    }
    // They came from the remote, so the remote has them: mark them acked, or
    // the replicator would push the whole session back.
    tx.prepare_cached(
        "INSERT INTO sessions (id, head, updated_at_ms, remote_head) VALUES (?1, ?2, ?3, ?2)
         ON CONFLICT (id) DO UPDATE SET
             head = excluded.head,
             updated_at_ms = max(updated_at_ms, excluded.updated_at_ms),
             remote_head = max(remote_head, excluded.remote_head)",
    )
    .and_then(|mut s| s.execute(params![session.as_str(), int(last.seq), int(last.at_ms)]))
    .map_err(sql)?;
    tx.commit().map_err(sql)
}

fn pending_sessions(conn: &mut Connection) -> Result<Vec<SessionLag>, StoreError> {
    let mut statement = conn
        .prepare_cached(
            "SELECT id, head, remote_head FROM sessions WHERE head > remote_head ORDER BY updated_at_ms",
        )
        .map_err(sql)?;
    let rows = statement
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })
        .map_err(sql)?;
    let mut sessions = Vec::new();
    for row in rows {
        let (id, head, remote_head) = row.map_err(sql)?;
        sessions.push(SessionLag {
            session: SessionId(id),
            head: uint(head)?,
            remote_head: uint(remote_head)?,
        });
    }
    Ok(sessions)
}

#[derive(Clone, Copy)]
struct Backoff {
    failures: u32,
    retry_at_ms: u64,
}

/// Pushes the local log to the remote until told to stop. Obtain it with
/// [`SqliteStore::replicator`].
pub struct Replicator {
    store: SqliteStore,
    remote: Arc<dyn RemoteLog>,
    /// `None` is the blob stage; a session id is that session's records.
    backoff: HashMap<Option<SessionId>, Backoff>,
    /// Blobs whose local copy is damaged: they can never be sent, so they
    /// must not hold the rest back.
    unreadable_blobs: HashSet<String>,
}

#[derive(Default)]
struct Pass {
    progressed: bool,
    /// Earliest time something backed off becomes due again.
    next_retry_ms: Option<u64>,
    failed: bool,
}

impl Replicator {
    /// Runs until `shutdown` is cancelled. Spawn it once per store; a second
    /// replicator on the same file (another engine) only wastes bandwidth,
    /// the remote ignores what it already has.
    pub async fn run(mut self, shutdown: CancellationToken) {
        let inner = self.store.inner.clone();
        while !shutdown.is_cancelled() {
            let pass = self.pass().await;
            if pass.progressed {
                continue;
            }
            let now = inner.clock.now_ms();
            let idle = inner.options.replication.idle_poll;
            let wait = match pass.next_retry_ms {
                Some(at) => Duration::from_millis(at.saturating_sub(now)).min(idle),
                None => idle,
            };
            // A new local write wakes us unless a failure is being waited out:
            // a retry storm is worse than a late retry.
            let sleep = pin!(inner.clock.sleep(wait));
            if pass.failed && pass.next_retry_ms.is_some() {
                let _ = first(shutdown.cancelled(), sleep).await;
            } else {
                let _ = first(shutdown.cancelled(), first(inner.wake.notified(), sleep)).await;
            }
        }
    }

    async fn pass(&mut self) -> Pass {
        let mut pass = Pass::default();
        let sessions = match self.store.inner.side.run(pending_sessions).await {
            Ok(sessions) => sessions,
            Err(error) => {
                self.note_failure(None, &error, &mut pass);
                return pass;
            }
        };
        for lag in sessions {
            let key = Some(lag.session.clone());
            if self.backed_off(&key, &mut pass) {
                continue;
            }
            match self.push_session(&lag).await {
                Ok(()) => {
                    self.backoff.remove(&key);
                    pass.progressed = true;
                }
                Err(error) => self.note_failure(key, &error, &mut pass),
            }
        }
        // Blobs nobody has put a record behind yet (or that arrived after the
        // records above were read) still go out.
        if !self.backed_off(&None, &mut pass) {
            match self.push_blobs().await {
                Ok(0) => {}
                Ok(_) => {
                    self.backoff.remove(&None);
                    pass.progressed = true;
                }
                Err(error) => self.note_failure(None, &error, &mut pass),
            }
        }
        if !pass.failed
            && let Ok(mut last) = self.store.inner.last_error.lock()
        {
            *last = None;
        }
        self.store.inner.progress.notify_waiters();
        pass
    }

    fn backed_off(&self, key: &Option<SessionId>, pass: &mut Pass) -> bool {
        let Some(state) = self.backoff.get(key) else {
            return false;
        };
        if state.retry_at_ms <= self.store.inner.clock.now_ms() {
            return false;
        }
        pass.failed = true;
        pass.next_retry_ms = Some(
            pass.next_retry_ms
                .map_or(state.retry_at_ms, |t| t.min(state.retry_at_ms)),
        );
        true
    }

    fn note_failure(&mut self, key: Option<SessionId>, error: &StoreError, pass: &mut Pass) {
        let config = &self.store.inner.options.replication;
        let now = self.store.inner.clock.now_ms();
        let failures = self.backoff.get(&key).map_or(1, |b| b.failures + 1);
        let exponent = (failures - 1).min(16);
        let delay = config
            .backoff_base
            .saturating_mul(1 << exponent)
            .min(config.backoff_max);
        // ±25% so engines that lost the network together do not all come back
        // in the same millisecond. The clock's own milliseconds are random
        // enough for that and keep tests deterministic.
        let spread = 75 + now % 51;
        let delay_ms = u64::try_from(delay.as_millis()).unwrap_or(u64::MAX) / 100 * spread;
        let retry_at_ms = now.saturating_add(delay_ms);
        self.backoff.insert(
            key,
            Backoff {
                failures,
                retry_at_ms,
            },
        );
        pass.failed = true;
        pass.next_retry_ms = Some(
            pass.next_retry_ms
                .map_or(retry_at_ms, |t| t.min(retry_at_ms)),
        );
        if let Ok(mut last) = self.store.inner.last_error.lock() {
            *last = Some(error.to_string());
        }
    }

    async fn push_session(&mut self, lag: &SessionLag) -> Result<(), StoreError> {
        let config = &self.store.inner.options.replication;
        let (limit, max_bytes) = (config.batch_records, config.batch_bytes);
        let session = lag.session.clone();
        let after = lag.remote_head;
        let records = self
            .store
            .inner
            .side
            .run(move |conn| read_records(conn, &session, after, Some(limit), Some(max_bytes)))
            .await?;
        let Some(last) = records.last().map(|r| r.seq) else {
            return Ok(());
        };
        // After reading the records, so every blob they can refer to is
        // already in the catalog.
        self.push_blobs().await?;
        let acknowledged = self.remote.push(&lag.session, &records).await?;
        // The remote cannot hold more of *our* batch than we sent, and a late
        // or repeated answer may be below what we already know. Trust neither.
        let acknowledged = acknowledged.min(last);
        if acknowledged <= after {
            return Err(StoreError::Io(format!(
                "the remote acknowledged record {acknowledged} of session {} but nothing after {after}",
                lag.session
            )));
        }
        let session = lag.session.clone();
        self.store
            .inner
            .side
            .run(move |conn| {
                conn.prepare_cached(
                    "UPDATE sessions SET remote_head = max(remote_head, ?2) WHERE id = ?1",
                )
                .and_then(|mut s| s.execute(params![session.as_str(), int(acknowledged)]))
                .map(|_| ())
                .map_err(sql)
            })
            .await?;
        self.store.inner.progress.notify_waiters();
        Ok(())
    }

    /// Pushes every blob the remote lacks. Returns how many went out.
    async fn push_blobs(&mut self) -> Result<usize, StoreError> {
        const BATCH: usize = 16;
        let mut sent = 0;
        loop {
            let skip = self.unreadable_blobs.len();
            let batch = self
                .store
                .inner
                .side
                .run(move |conn| unpushed_blobs(conn, BATCH + skip))
                .await?;
            let batch: Vec<_> = batch
                .into_iter()
                .filter(|(blob, _)| !self.unreadable_blobs.contains(&blob.sha256))
                .take(BATCH)
                .collect();
            if batch.is_empty() {
                return Ok(sent);
            }
            for (blob, inline) in batch {
                let bytes = match inline {
                    Some(bytes) => Ok(bytes),
                    None => self.read_blob_file(&blob).await,
                };
                let bytes = match bytes {
                    Ok(bytes) => bytes,
                    Err(StoreError::Corrupt(message)) => {
                        // Nothing a retry can fix; report it and move on.
                        if let Ok(mut last) = self.store.inner.last_error.lock() {
                            *last = Some(message);
                        }
                        self.unreadable_blobs.insert(blob.sha256);
                        continue;
                    }
                    Err(other) => return Err(other),
                };
                self.remote.push_blob(&blob, &bytes).await?;
                let sha256 = blob.sha256;
                self.store
                    .inner
                    .side
                    .run(move |conn| {
                        conn.prepare_cached("UPDATE blobs SET pushed = 1 WHERE sha256 = ?1")
                            .and_then(|mut s| s.execute([&sha256]))
                            .map(|_| ())
                            .map_err(sql)
                    })
                    .await?;
                sent += 1;
            }
            self.store.inner.progress.notify_waiters();
        }
    }

    async fn read_blob_file(&self, blob: &BlobRef) -> Result<Vec<u8>, StoreError> {
        let dir = self.store.inner.blob_dir.clone();
        let (sha256, len) = (blob.sha256.clone(), blob.bytes);
        self.store
            .inner
            .files
            .run(move |()| blobs::read_file(&dir, &sha256, len))
            .await
    }
}

/// A blob and, when it lives in the database, its bytes.
type BlobRow = (BlobRef, Option<Vec<u8>>);

fn unpushed_blobs(conn: &mut Connection, limit: usize) -> Result<Vec<BlobRow>, StoreError> {
    let mut statement = conn
        .prepare_cached(
            "SELECT sha256, media_type, bytes, data FROM blobs WHERE pushed = 0 LIMIT ?1",
        )
        .map_err(sql)?;
    let rows = statement
        .query_map([i64::try_from(limit).unwrap_or(i64::MAX)], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, Option<Vec<u8>>>(3)?,
            ))
        })
        .map_err(sql)?;
    let mut blobs = Vec::new();
    for row in rows {
        let (sha256, media_type, bytes, data) = row.map_err(sql)?;
        blobs.push((
            BlobRef {
                sha256,
                media_type,
                bytes: uint(bytes)?,
            },
            data,
        ));
    }
    Ok(blobs)
}
