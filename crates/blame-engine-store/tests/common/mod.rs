#![allow(dead_code)]

use async_trait::async_trait;
use blame_engine_core::ports::{Clock, RemoteLog, StoreError};
use blame_engine_protocol::{BlobRef, NoticeLevel, Record, RecordBody, Seq, SessionId};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub struct TempDir(pub PathBuf);

impl TempDir {
    pub fn new(name: &str) -> Self {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "blame-store-{name}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    pub fn db(&self) -> PathBuf {
        self.0.join("engine.db")
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A clock the test sets by hand; sleeping is a short real pause.
pub struct ManualClock(pub AtomicU64);

impl ManualClock {
    pub fn at(ms: u64) -> std::sync::Arc<Self> {
        std::sync::Arc::new(Self(AtomicU64::new(ms)))
    }

    pub fn set(&self, ms: u64) {
        self.0.store(ms, Ordering::SeqCst);
    }
}

#[async_trait]
impl Clock for ManualClock {
    fn now_ms(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }

    async fn sleep(&self, _: Duration) {
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
}

pub struct RealClock;

#[async_trait]
impl Clock for RealClock {
    fn now_ms(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
    }

    async fn sleep(&self, duration: Duration) {
        tokio::time::sleep(duration).await;
    }
}

pub fn notice(text: &str) -> RecordBody {
    RecordBody::Notice {
        level: NoticeLevel::Info,
        code: "test".into(),
        text: text.into(),
    }
}

pub fn text_of(record: &Record) -> &str {
    match &record.body {
        RecordBody::Notice { text, .. } => text,
        other => panic!("not a notice: {other:?}"),
    }
}

pub fn session(name: &str) -> SessionId {
    SessionId::from(name)
}

pub fn path_str(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Quirk {
    Normal,
    /// Keeps the records but answers with a seq lower than before.
    StaleAck,
    /// Keeps only the first `n` records of the batch.
    Partial(usize),
    /// Answers with a seq the remote cannot hold.
    Inflated,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    Blob(String),
    Record(SessionId, Seq),
}

#[derive(Default)]
pub struct State {
    pub logs: HashMap<SessionId, Vec<Record>>,
    pub blobs: HashMap<String, Vec<u8>>,
    pub events: Vec<Event>,
    pub attempts: Vec<Instant>,
    pub push_batches: Vec<(SessionId, Seq, Seq)>,
    pub violations: Vec<String>,
    pub down: bool,
    pub fail_next: usize,
    pub poisoned: HashSet<SessionId>,
    pub quirks: VecDeque<Quirk>,
    /// Answers `pull` in reverse order, with duplicates and records the
    /// caller already has.
    pub messy_pull: bool,
    pub pull_limit: Option<usize>,
    /// `push` never answers.
    pub hang: bool,
}

#[derive(Default)]
pub struct FakeRemote {
    pub state: Mutex<State>,
}

impl FakeRemote {
    pub fn new() -> std::sync::Arc<Self> {
        std::sync::Arc::new(Self::default())
    }

    pub fn with<T>(&self, f: impl FnOnce(&mut State) -> T) -> T {
        f(&mut self.state.lock().unwrap())
    }

    pub fn log(&self, session: &SessionId) -> Vec<Record> {
        self.with(|s| s.logs.get(session).cloned().unwrap_or_default())
    }

    fn gate(state: &mut State) -> Result<(), StoreError> {
        state.attempts.push(Instant::now());
        if state.down {
            return Err(StoreError::Io("remote unreachable".into()));
        }
        if state.fail_next > 0 {
            state.fail_next -= 1;
            return Err(StoreError::Io("remote failed".into()));
        }
        Ok(())
    }
}

#[async_trait]
impl RemoteLog for FakeRemote {
    async fn push(&self, session: &SessionId, records: &[Record]) -> Result<Seq, StoreError> {
        let hang = self.with(|s| s.hang);
        if hang {
            std::future::pending::<()>().await;
        }
        let mut guard = self.state.lock().unwrap();
        let state = &mut *guard;
        Self::gate(state)?;
        if state.poisoned.contains(session) {
            return Err(StoreError::Io("remote rejects this session".into()));
        }
        if let (Some(first), Some(last)) = (records.first(), records.last()) {
            state
                .push_batches
                .push((session.clone(), first.seq, last.seq));
        }
        if records.windows(2).any(|w| w[0].seq + 1 != w[1].seq) {
            state
                .violations
                .push(format!("batch of {session} is not contiguous"));
        }
        let quirk = state.quirks.pop_front().unwrap_or(Quirk::Normal);
        let log = state.logs.entry(session.clone()).or_default();
        let limit = match quirk {
            Quirk::Partial(n) => n,
            _ => usize::MAX,
        };
        let mut taken = 0;
        for record in records {
            if record.seq <= log.len() as u64 {
                continue; // pushing a record twice is harmless
            }
            if record.seq != log.len() as u64 + 1 {
                let message = format!("{session}: record {} after {}", record.seq, log.len());
                state.violations.push(message.clone());
                return Err(StoreError::Io(message));
            }
            if taken >= limit {
                break;
            }
            log.push(record.clone());
            state
                .events
                .push(Event::Record(session.clone(), record.seq));
            taken += 1;
        }
        let held = log.len() as u64;
        Ok(match quirk {
            Quirk::StaleAck => 0,
            Quirk::Inflated => held + 100,
            _ => held,
        })
    }

    async fn pull(&self, session: &SessionId, after: Seq) -> Result<Vec<Record>, StoreError> {
        let mut state = self.state.lock().unwrap();
        Self::gate(&mut state)?;
        let mut records: Vec<Record> = state
            .logs
            .get(session)
            .map(|log| log.iter().filter(|r| r.seq > after).cloned().collect())
            .unwrap_or_default();
        if let Some(limit) = state.pull_limit {
            records.truncate(limit);
        }
        if state.messy_pull {
            if let Some(held) = state.logs.get(session)
                && after > 0
            {
                records.push(held[after as usize - 1].clone());
            }
            let copy = records.clone();
            records.extend(copy);
            records.reverse();
        }
        Ok(records)
    }

    async fn push_blob(&self, blob: &BlobRef, bytes: &[u8]) -> Result<(), StoreError> {
        let mut state = self.state.lock().unwrap();
        Self::gate(&mut state)?;
        state.blobs.insert(blob.sha256.clone(), bytes.to_vec());
        state.events.push(Event::Blob(blob.sha256.clone()));
        Ok(())
    }

    async fn pull_blob(&self, sha256: &str) -> Result<Option<Vec<u8>>, StoreError> {
        let mut state = self.state.lock().unwrap();
        Self::gate(&mut state)?;
        Ok(state.blobs.get(sha256).cloned())
    }
}
