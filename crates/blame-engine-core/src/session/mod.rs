//! One session, alive in memory: its log, the task that runs its turns, and
//! whoever is watching it.
//!
//! The log is the whole state. Everything else here (the driver task, the
//! cached tool specs, the deltas of the reply being streamed) can be lost at
//! any moment: dropping an idle `Session` and opening it again from the store
//! gives the same session.

mod compaction;
mod driver;
mod recovery;
mod rewind;
mod step;
mod stream;
mod tools;

use crate::error::EngineError;
use crate::policy::{ContextPolicy, EngineOptions};
use crate::ports::{
    Approver, Checkpointer, Clock, IdSource, ModelProvider, SessionStore, ToolHost,
};
use crate::projection::View;
use blame_engine_protocol::rpc::{MessageAccepted, Rewound};
use blame_engine_protocol::{
    Delivery, Delta, NoticeLevel, Record, RecordBody, Seq, SessionActivity, SessionConfig,
    SessionId, ToolSpec, TurnId, UserBlock,
};
use std::sync::{Arc, Mutex, PoisonError};
use tokio::sync::{broadcast, watch};
#[cfg(feature = "testing")]
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

/// Everything a session reaches the outside world through.
#[derive(Clone)]
pub struct Ports {
    pub store: Arc<dyn SessionStore>,
    pub provider: Arc<dyn ModelProvider>,
    /// One host for every tool of the session; the binary routes between
    /// the harness, the client's tools and MCP servers behind it.
    pub tools: Arc<dyn ToolHost>,
    pub checkpointer: Arc<dyn Checkpointer>,
    pub approver: Arc<dyn Approver>,
    pub clock: Arc<dyn Clock>,
    pub ids: Arc<dyn IdSource>,
    pub context_policy: Arc<dyn ContextPolicy>,
}

/// What subscribers receive, in the order it happened.
#[derive(Clone, Debug, PartialEq)]
pub enum SessionEvent {
    Record(Record),
    Delta(Delta),
}

/// A subscriber's starting point and its live feed. `records` and
/// `in_flight` are what happened before `events` starts, with nothing
/// missing and nothing repeated in between.
pub struct Subscription {
    pub records: Vec<Record>,
    pub head: Seq,
    pub activity: SessionActivity,
    /// Deltas of the reply being streamed right now.
    pub in_flight: Vec<Delta>,
    /// Lags (and reports `Lagged`) when the subscriber cannot keep up; it
    /// then subscribes again after the last record it has.
    pub events: broadcast::Receiver<SessionEvent>,
}

const EVENT_BUFFER: usize = 1024;
const READ_PAGE: u32 = 1000;

/// Code of the notice stored when a turn's checkpoint could not be taken;
/// the turn then runs without one.
pub const NOTICE_CHECKPOINT_FAILED: &str = "checkpoint_failed";

/// A handle to a live session. Cloning it gives another handle to the same
/// session.
#[derive(Clone)]
pub struct Session {
    inner: Arc<Inner>,
}

pub(crate) struct Inner {
    id: SessionId,
    ports: Ports,
    options: EngineOptions,
    core: tokio::sync::Mutex<Core>,
    live: Mutex<Live>,
    events: broadcast::Sender<SessionEvent>,
    /// Serialises the commands that need the session to themselves (rewind,
    /// undo, compact, configure, close, send), so none of them lands in the
    /// middle of another.
    control: tokio::sync::Mutex<()>,
    busy: watch::Sender<bool>,
}

/// State guarded by one lock, which is also held across each store append
/// so records are written, applied and announced in one order.
struct Core {
    records: Vec<Record>,
    specs: Option<(SessionConfig, Arc<[ToolSpec]>)>,
    driver: Option<Driver>,
    /// Set while a command needs the driver stopped: it ends the turn it is
    /// in and starts no other.
    hold: bool,
    compact_requested: bool,
    /// The turn whose checkpoint could not be taken; it runs without one.
    checkpoint_failed: Option<TurnId>,
    broken: Option<String>,
    closed: bool,
}

struct Driver {
    /// The turn being run and the token that interrupts it.
    current: Option<(TurnId, CancellationToken)>,
    /// Kept only so a test can kill the task like a crash would; otherwise
    /// the task ends on its own and nothing waits on its handle.
    #[cfg(feature = "testing")]
    task: Option<JoinHandle<()>>,
}

#[derive(Default)]
struct Live {
    activity: Activity,
    in_flight: Vec<Delta>,
}

struct Activity(SessionActivity);

impl Default for Activity {
    fn default() -> Self {
        Self(SessionActivity::Idle)
    }
}

impl Session {
    /// Starts a new session; fails if the store already has one by that id.
    pub async fn create(
        ports: Ports,
        options: EngineOptions,
        id: SessionId,
        config: SessionConfig,
    ) -> Result<Self, EngineError> {
        let records = ports
            .store
            .append(&id, 0, vec![RecordBody::SessionCreated { config }])
            .await?;
        Ok(Self::from_records(ports, options, id, records))
    }

    /// Loads a stored session and brings it to a consistent state: whatever
    /// a crash or a quit left in flight is settled (see
    /// [`crate::RecoveryPolicy`]).
    pub async fn open(
        ports: Ports,
        options: EngineOptions,
        id: SessionId,
    ) -> Result<Self, EngineError> {
        let mut records = Vec::new();
        loop {
            let after = records.last().map_or(0, |r: &Record| r.seq);
            let page = ports.store.read(&id, after, Some(READ_PAGE)).await?;
            let full = page.len() == READ_PAGE as usize;
            records.extend(page);
            if !full {
                break;
            }
        }
        validate(&records)?;
        let session = Self::from_records(ports, options, id, records);
        recovery::recover(&session.inner).await?;
        Ok(session)
    }

    fn from_records(
        ports: Ports,
        options: EngineOptions,
        id: SessionId,
        records: Vec<Record>,
    ) -> Self {
        let (events, _) = broadcast::channel(EVENT_BUFFER);
        Self {
            inner: Arc::new(Inner {
                id,
                ports,
                options,
                core: tokio::sync::Mutex::new(Core {
                    records,
                    specs: None,
                    driver: None,
                    hold: false,
                    compact_requested: false,
                    checkpoint_failed: None,
                    broken: None,
                    closed: false,
                }),
                live: Mutex::new(Live::default()),
                events,
                control: tokio::sync::Mutex::new(()),
                busy: watch::Sender::new(false),
            }),
        }
    }

    pub fn id(&self) -> &SessionId {
        &self.inner.id
    }

    pub async fn head(&self) -> Seq {
        head(&self.inner.core.lock().await.records)
    }

    /// A copy of the whole log as this engine holds it.
    pub async fn records(&self) -> Vec<Record> {
        self.inner.core.lock().await.records.clone()
    }

    pub fn activity(&self) -> SessionActivity {
        self.inner.live().activity.0.clone()
    }

    /// No turn is running: the session can be dropped from memory and
    /// opened again later with nothing lost.
    pub fn is_idle(&self) -> bool {
        !*self.inner.busy.borrow()
    }

    /// Resolves once no turn is running.
    pub async fn wait_idle(&self) {
        let mut busy = self.inner.busy.subscribe();
        // The sender lives as long as `inner`, which `self` holds.
        let _ = busy.wait_for(|busy| !busy).await;
    }

    pub async fn subscribe(&self, after: Seq) -> Subscription {
        let core = self.inner.core.lock().await;
        let live = self.inner.live();
        Subscription {
            records: core
                .records
                .iter()
                .filter(|r| r.seq > after)
                .cloned()
                .collect(),
            head: head(&core.records),
            activity: live.activity.0.clone(),
            in_flight: live.in_flight.clone(),
            events: self.inner.events.subscribe(),
        }
    }

    /// A user message. `Delivery::Turn` opens a turn, queued behind the
    /// running one if there is one; `Steer` joins the running turn at its
    /// next request, or opens a turn when none runs.
    pub async fn send(
        &self,
        input: Vec<UserBlock>,
        delivery: Delivery,
    ) -> Result<MessageAccepted, EngineError> {
        let _control = self.inner.control.lock().await;
        let mut core = self.inner.core.lock().await;
        core.usable()?;
        let running = View::new(&core.records)
            .open_turns()
            .first()
            .map(|t| (*t).clone());
        let (turn, delivery, started) = match (delivery, running) {
            (Delivery::Steer, Some(turn)) => (turn, Delivery::Steer, true),
            (_, None) => (self.new_turn(), Delivery::Turn, true),
            (Delivery::Turn, Some(_)) => (self.new_turn(), Delivery::Turn, false),
        };
        self.inner
            .append_locked(
                &mut core,
                vec![RecordBody::UserMessage {
                    turn: turn.clone(),
                    input,
                    delivery,
                }],
            )
            .await?;
        self.inner.ensure_driver(&mut core);
        Ok(MessageAccepted { turn, started })
    }

    fn new_turn(&self) -> TurnId {
        TurnId(self.inner.ports.ids.next("turn"))
    }

    /// Stops the running turn. Tools in flight are cancelled; turns queued
    /// behind it still run.
    pub async fn interrupt(&self) -> Result<(), EngineError> {
        let core = self.inner.core.lock().await;
        if let Some(Driver {
            current: Some((_, cancel)),
            ..
        }) = &core.driver
        {
            cancel.cancel();
        }
        Ok(())
    }

    /// Makes `to` the last record in effect and, when asked, puts the
    /// workspace back as it was then. A running turn is interrupted first.
    pub async fn rewind(&self, to: Seq, restore_workspace: bool) -> Result<Rewound, EngineError> {
        let _control = self.inner.control.lock().await;
        self.inner.stop_driver().await?;
        let result = rewind::rewind(&self.inner, to, restore_workspace).await;
        self.inner.release_driver().await;
        result
    }

    /// Cancels the rewind that is the latest record, files included.
    pub async fn undo_rewind(&self) -> Result<(), EngineError> {
        let _control = self.inner.control.lock().await;
        rewind::undo(&self.inner).await?;
        self.inner.release_driver().await;
        Ok(())
    }

    /// Summarises the history now, or before the running turn's next
    /// request.
    pub async fn compact(&self) -> Result<(), EngineError> {
        let _control = self.inner.control.lock().await;
        {
            let mut core = self.inner.core.lock().await;
            core.usable()?;
            if core.driver.is_some() {
                core.compact_requested = true;
                return Ok(());
            }
        }
        compaction::compact(
            &self.inner,
            compaction::Reason::Manual,
            &CancellationToken::new(),
        )
        .await?;
        self.inner.set_activity(SessionActivity::Idle);
        Ok(())
    }

    /// Replaces the configuration from the next request on.
    pub async fn configure(&self, config: SessionConfig) -> Result<(), EngineError> {
        let _control = self.inner.control.lock().await;
        let mut core = self.inner.core.lock().await;
        core.usable()?;
        self.inner
            .append_locked(&mut core, vec![RecordBody::ConfigChanged { config }])
            .await?;
        Ok(())
    }

    /// A new session holding this one's records up to `at`, working in
    /// `workspace_root`. Whatever was in flight at `at` is ended in the fork.
    pub async fn fork(
        &self,
        at: Seq,
        workspace_root: String,
        id: SessionId,
    ) -> Result<Session, EngineError> {
        let records = {
            let core = self.inner.core.lock().await;
            if at == 0 || at > head(&core.records) {
                return Err(EngineError::InvalidFork {
                    at,
                    reason: "no such record".into(),
                });
            }
            core.records[..at as usize].to_vec()
        };
        let bodies = rewind::fork_bodies(&self.inner.id, records, at, &workspace_root)?;
        self.inner.ports.store.append(&id, 0, bodies).await?;
        Session::open(self.inner.ports.clone(), self.inner.options.clone(), id).await
    }

    /// Stops the running turn and refuses further commands. The records stay
    /// stored; open the session again to continue it.
    pub async fn close(&self) -> Result<(), EngineError> {
        let _control = self.inner.control.lock().await;
        let stopped = self.inner.stop_driver().await;
        self.inner.core.lock().await.closed = true;
        stopped
    }

    /// Kills the session the way a crash would: its task stops wherever it
    /// is and nothing more is written.
    #[cfg(feature = "testing")]
    pub async fn crash(&self) {
        let mut core = self.inner.core.lock().await;
        core.broken = Some("crashed".into());
        if let Some(driver) = core.driver.take()
            && let Some(task) = driver.task
        {
            task.abort();
        }
        self.inner.busy.send_replace(false);
    }
}

impl Core {
    fn usable(&self) -> Result<(), EngineError> {
        if self.closed {
            return Err(EngineError::Closed);
        }
        match &self.broken {
            Some(reason) => Err(EngineError::Broken(reason.clone())),
            None => Ok(()),
        }
    }
}

impl Inner {
    fn live(&self) -> std::sync::MutexGuard<'_, Live> {
        self.live.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Stores `bodies`, then applies and announces them. A failed append
    /// breaks the session: the store may hold more or less than this engine
    /// believes, and only reopening tells which.
    async fn append_locked(
        &self,
        core: &mut Core,
        bodies: Vec<RecordBody>,
    ) -> Result<Vec<Record>, EngineError> {
        if let Some(reason) = &core.broken {
            return Err(EngineError::Broken(reason.clone()));
        }
        let expected = head(&core.records);
        let records = match self.ports.store.append(&self.id, expected, bodies).await {
            Ok(records) => records,
            Err(error) => {
                core.broken = Some(error.to_string());
                return Err(error.into());
            }
        };
        let mut live = self.live();
        for record in &records {
            if matches!(
                record.body,
                RecordBody::AssistantMessage { .. } | RecordBody::RequestFailed { .. }
            ) {
                live.in_flight.clear();
            }
            let _ = self.events.send(SessionEvent::Record(record.clone()));
        }
        drop(live);
        core.records.extend(records.iter().cloned());
        Ok(records)
    }

    async fn append(&self, bodies: Vec<RecordBody>) -> Result<Vec<Record>, EngineError> {
        let mut core = self.core.lock().await;
        self.append_locked(&mut core, bodies).await
    }

    async fn notice(
        &self,
        level: NoticeLevel,
        code: &str,
        text: String,
    ) -> Result<(), EngineError> {
        self.append(vec![RecordBody::Notice {
            level,
            code: code.into(),
            text,
        }])
        .await
        .map(drop)
    }

    fn delta(&self, delta: Delta) {
        let mut live = self.live();
        match &delta {
            Delta::Activity { activity } => {
                if live.activity.0 == *activity {
                    return;
                }
                live.activity.0 = activity.clone();
            }
            Delta::ToolProgress { .. } => {}
            _ => merge_in_flight(&mut live.in_flight, &delta),
        }
        let _ = self.events.send(SessionEvent::Delta(delta));
    }

    fn set_activity(&self, activity: SessionActivity) {
        self.delta(Delta::Activity { activity });
    }

    /// The tools offered under `config`, asked once per configuration and
    /// sorted by name: they are part of the cached prefix.
    async fn specs_locked(&self, core: &mut Core, config: &SessionConfig) -> Arc<[ToolSpec]> {
        if let Some((cached, specs)) = &core.specs
            && cached == config
        {
            return specs.clone();
        }
        let mut specs = self.ports.tools.specs(config).await;
        specs.sort_by(|a, b| a.name.cmp(&b.name));
        let specs: Arc<[ToolSpec]> = specs.into();
        core.specs = Some((config.clone(), specs.clone()));
        specs
    }

    /// Starts the driver if a turn is open and nothing holds it back.
    fn ensure_driver(self: &Arc<Self>, core: &mut Core) {
        if core.driver.is_some() || core.hold || core.usable().is_err() {
            return;
        }
        if View::new(&core.records).open_turns().is_empty() {
            return;
        }
        self.busy.send_replace(true);
        let _task = tokio::spawn(driver::drive(self.clone()));
        core.driver = Some(Driver {
            current: None,
            #[cfg(feature = "testing")]
            task: Some(_task),
        });
    }

    /// Interrupts the running turn and waits for the driver to stop. It
    /// stays stopped until [`Self::release_driver`].
    async fn stop_driver(&self) -> Result<(), EngineError> {
        {
            let mut core = self.core.lock().await;
            core.hold = true;
            if let Some(Driver {
                current: Some((_, cancel)),
                ..
            }) = &core.driver
            {
                cancel.cancel();
            }
        }
        let mut busy = self.busy.subscribe();
        let _ = busy.wait_for(|busy| !busy).await;
        self.core.lock().await.usable()
    }

    async fn release_driver(self: &Arc<Self>) {
        let mut core = self.core.lock().await;
        core.hold = false;
        self.ensure_driver(&mut core);
    }
}

/// Keeps one delta per streamed block: a late subscriber needs the text so
/// far, not every fragment it arrived in.
fn merge_in_flight(in_flight: &mut Vec<Delta>, delta: &Delta) {
    match (in_flight.last_mut(), delta) {
        (
            Some(Delta::Text {
                request: r1,
                index: i1,
                text: existing,
            }),
            Delta::Text {
                request,
                index,
                text,
            },
        )
        | (
            Some(Delta::Reasoning {
                request: r1,
                index: i1,
                text: existing,
            }),
            Delta::Reasoning {
                request,
                index,
                text,
            },
        )
        | (
            Some(Delta::ToolInput {
                request: r1,
                index: i1,
                json: existing,
            }),
            Delta::ToolInput {
                request,
                index,
                json: text,
            },
        ) if r1 == request && i1 == index => existing.push_str(text),
        _ => in_flight.push(delta.clone()),
    }
}

fn head(records: &[Record]) -> Seq {
    records.last().map_or(0, |r| r.seq)
}

fn validate(records: &[Record]) -> Result<(), EngineError> {
    for (index, record) in records.iter().enumerate() {
        if record.seq != index as u64 + 1 {
            return Err(EngineError::InvalidLog(format!(
                "record {} found at position {}",
                record.seq,
                index + 1
            )));
        }
    }
    match records.first().map(|r| &r.body) {
        Some(RecordBody::SessionCreated { .. }) => Ok(()),
        _ => Err(EngineError::InvalidLog(
            "the first record is not SessionCreated".into(),
        )),
    }
}
