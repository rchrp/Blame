use crate::digest::Sha256;
use crate::ports::{BlobSource, Clock, SessionStore, StoreError, StoredSession};
use async_trait::async_trait;
use blame_engine_protocol::{BlobRef, Record, RecordBody, Seq, SessionId};
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, PoisonError};

/// A store in memory. Clones share the same data, so a test can "restart"
/// the engine by opening the session again on a clone.
#[derive(Clone, Default)]
pub struct MemoryStore {
    inner: Arc<Mutex<Data>>,
    clock: Option<Arc<dyn Clock>>,
}

#[derive(Default)]
struct Data {
    sessions: BTreeMap<SessionId, Vec<Record>>,
    blobs: HashMap<String, Vec<u8>>,
    appends: u64,
    /// Appends still allowed before the power goes.
    power_left: Option<u64>,
    power_lost: bool,
    fail_next: u32,
}

impl MemoryStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Stamps records with `clock` instead of 0.
    pub fn with_clock(clock: Arc<dyn Clock>) -> Self {
        Self {
            inner: Arc::default(),
            clock: Some(clock),
        }
    }

    fn data(&self) -> std::sync::MutexGuard<'_, Data> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// After `appends` more successful appends, every write and read fails
    /// and stores nothing, as if the machine lost power.
    pub fn lose_power_after(&self, appends: u64) {
        let mut data = self.data();
        data.power_left = Some(appends);
        data.power_lost = false;
    }

    /// Back on: what was stored before the cut is all there is.
    pub fn restore_power(&self) {
        let mut data = self.data();
        data.power_left = None;
        data.power_lost = false;
    }

    pub fn power_lost(&self) -> bool {
        self.data().power_lost
    }

    /// The next `count` appends fail with an I/O error.
    pub fn fail_next_appends(&self, count: u32) {
        self.data().fail_next = count;
    }

    /// Successful appends so far, all sessions together.
    pub fn appends(&self) -> u64 {
        self.data().appends
    }

    pub fn records(&self, session: &SessionId) -> Vec<Record> {
        self.data()
            .sessions
            .get(session)
            .cloned()
            .unwrap_or_default()
    }

    fn check_power(data: &Data) -> Result<(), StoreError> {
        if data.power_lost {
            Err(StoreError::Io("power lost".into()))
        } else {
            Ok(())
        }
    }
}

#[async_trait]
impl BlobSource for MemoryStore {
    async fn blob(&self, sha256: &str) -> Result<Option<Vec<u8>>, StoreError> {
        let data = self.data();
        Self::check_power(&data)?;
        Ok(data.blobs.get(sha256).cloned())
    }
}

#[async_trait]
impl SessionStore for MemoryStore {
    async fn append(
        &self,
        session: &SessionId,
        expected_head: Seq,
        bodies: Vec<RecordBody>,
    ) -> Result<Vec<Record>, StoreError> {
        let at_ms = self.clock.as_ref().map_or(0, |clock| clock.now_ms());
        let mut data = self.data();
        Self::check_power(&data)?;
        if data.power_left == Some(0) {
            data.power_lost = true;
            return Err(StoreError::Io("power lost".into()));
        }
        if data.fail_next > 0 {
            data.fail_next -= 1;
            return Err(StoreError::Io("disk full".into()));
        }
        let exists = data.sessions.contains_key(session);
        if expected_head == 0 && exists {
            return Err(StoreError::SessionExists(session.clone()));
        }
        if expected_head > 0 && !exists {
            return Err(StoreError::UnknownSession(session.clone()));
        }
        let log = data.sessions.entry(session.clone()).or_default();
        let head = log.last().map_or(0, |r| r.seq);
        if head != expected_head {
            return Err(StoreError::Conflict {
                session: session.clone(),
                expected: expected_head,
                head,
            });
        }
        let records: Vec<Record> = bodies
            .into_iter()
            .zip(head + 1..)
            .map(|(body, seq)| Record { seq, at_ms, body })
            .collect();
        log.extend(records.iter().cloned());
        data.appends += 1;
        if let Some(left) = &mut data.power_left {
            *left -= 1;
        }
        Ok(records)
    }

    async fn read(
        &self,
        session: &SessionId,
        after: Seq,
        limit: Option<u32>,
    ) -> Result<Vec<Record>, StoreError> {
        let data = self.data();
        Self::check_power(&data)?;
        let log = data
            .sessions
            .get(session)
            .ok_or_else(|| StoreError::UnknownSession(session.clone()))?;
        Ok(log
            .iter()
            .filter(|r| r.seq > after)
            .take(limit.map_or(usize::MAX, |l| l as usize))
            .cloned()
            .collect())
    }

    async fn sessions(&self) -> Result<Vec<StoredSession>, StoreError> {
        let data = self.data();
        Self::check_power(&data)?;
        Ok(data
            .sessions
            .iter()
            .map(|(session, log)| StoredSession {
                session: session.clone(),
                head: log.last().map_or(0, |r| r.seq),
                updated_at_ms: log.last().map_or(0, |r| r.at_ms),
            })
            .collect())
    }

    async fn put_blob(&self, media_type: &str, bytes: Vec<u8>) -> Result<BlobRef, StoreError> {
        let mut data = self.data();
        Self::check_power(&data)?;
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        let sha256 = hasher.finish_hex();
        let blob = BlobRef {
            sha256: sha256.clone(),
            media_type: media_type.into(),
            bytes: bytes.len() as u64,
        };
        data.blobs.entry(sha256).or_insert(bytes);
        Ok(blob)
    }
}
