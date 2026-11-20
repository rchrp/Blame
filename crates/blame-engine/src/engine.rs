//! What the engine holds across connections: the store, the sessions alive
//! in memory, and the ports they share.
//!
//! A session is in memory while it runs a turn, while a client subscribes to
//! it, or for a while after its last use; otherwise it is dropped and opened
//! again from the log on demand, which costs a read of its records.

use crate::connection::{ConnectionId, Host};
use crate::context::HarnessContextPolicy;
use crate::log::log;
use crate::ports::{ClientApprover, ClientRemoteLog, ProviderRouter, RandomIds, RealClock};
use crate::tools::{Harness, SessionTools, ToolShared};
use blame_engine_checkpoint::{BLAME_WORKSPACE_EXCLUDES, GitCheckpointer};
use blame_engine_core::ports::{Clock, IdSource, SessionStore, StoreError};
use blame_engine_core::{EngineError, EngineOptions, Ports, Session};
use blame_engine_protocol::{RecordBody, Seq, SessionConfig, SessionId};
use blame_engine_providers::Options;
use blame_engine_providers::catalog::{LiveCatalog, RefreshOptions};
use blame_engine_store::{Durability, SqliteStore, StoreOptions};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};
use tokio::task::{AbortHandle, JoinHandle};
use tokio_util::sync::CancellationToken;

/// How long `shutdown` lets running turns take to end as interrupted.
const STOP_TURNS: Duration = Duration::from_secs(10);
/// How long `shutdown` waits for the client to take the last records.
const FLUSH: Duration = Duration::from_secs(5);

pub struct Settings {
    pub data_dir: PathBuf,
    pub durability: Durability,
    pub idle_after: Duration,
    pub harness: Option<Arc<Harness>>,
    /// Where the models.dev catalog is refreshed from.
    pub catalog: RefreshOptions,
}

pub struct Engine {
    catalog: Arc<LiveCatalog>,
    store: SqliteStore,
    remote: bool,
    host: Arc<Host>,
    ports: PortsTemplate,
    options: EngineOptions,
    idle_after: Duration,
    harness: Option<Arc<Harness>>,
    sessions: Mutex<HashMap<SessionId, Live>>,
    /// Opening is serialised: two opens of one session must not build two
    /// copies of it on one log.
    opening: tokio::sync::Mutex<()>,
    replication: Mutex<Option<(CancellationToken, JoinHandle<()>)>>,
    stopping: CancellationToken,
}

/// Everything in `Ports` but the per-session tool router.
#[derive(Clone)]
struct PortsTemplate {
    store: Arc<dyn SessionStore>,
    provider: Arc<ProviderRouter>,
    checkpointer: Arc<GitCheckpointer>,
    approver: Arc<ClientApprover>,
    clock: Arc<dyn Clock>,
    ids: Arc<dyn IdSource>,
    tools: ToolShared,
}

struct Live {
    session: Session,
    last_used: Instant,
    /// Forwarders of the connections that subscribe to it.
    subscribers: HashMap<ConnectionId, AbortHandle>,
}

#[derive(Debug, thiserror::Error)]
pub enum OpenError {
    #[error(transparent)]
    Engine(#[from] EngineError),
    #[error(transparent)]
    Store(#[from] StoreError),
}

impl Engine {
    /// Opens the store under the data directory. `remote_log`: the client
    /// copies the logs to Blame's database.
    pub async fn start(
        settings: Settings,
        host: Arc<Host>,
        remote_log: bool,
    ) -> Result<Arc<Self>, String> {
        let data_dir = settings.data_dir.clone();
        std::fs::create_dir_all(&data_dir)
            .map_err(|error| format!("cannot create {}: {error}", data_dir.display()))?;
        let clock: Arc<dyn Clock> = Arc::new(RealClock);
        let remote = remote_log.then(|| {
            Arc::new(ClientRemoteLog { host: host.clone() })
                as Arc<dyn blame_engine_core::ports::RemoteLog>
        });
        let options = StoreOptions {
            durability: settings.durability,
            remote,
            ..StoreOptions::default()
        };
        let path = data_dir.join("sessions.db");
        let store_clock = clock.clone();
        let store =
            tokio::task::spawn_blocking(move || SqliteStore::open(path, store_clock, options))
                .await
                .map_err(|error| format!("opening the store failed: {error}"))?
                .map_err(|error| format!("opening the store failed: {error}"))?;
        let catalog = Arc::new(LiveCatalog::open(
            Some(data_dir.join("catalog")),
            settings.catalog.clone(),
        ));
        let provider_options = Options {
            catalog: catalog.clone(),
            ..Options::default()
        };
        let checkpointer = GitCheckpointer::new(data_dir.join("checkpoints"))
            .with_excludes(BLAME_WORKSPACE_EXCLUDES.iter().copied());
        let store_port: Arc<dyn SessionStore> = Arc::new(store.clone());
        // Never waited for: a turn uses whatever copy is in place.
        catalog.refresh_if_stale();
        let engine = Arc::new(Self {
            catalog,
            remote: remote_log,
            ports: PortsTemplate {
                store: store_port.clone(),
                provider: Arc::new(ProviderRouter::new(host.clone(), provider_options)),
                checkpointer: Arc::new(checkpointer),
                approver: Arc::new(ClientApprover { host: host.clone() }),
                clock,
                ids: Arc::new(RandomIds),
                tools: ToolShared {
                    host: host.clone(),
                    harness: settings.harness.clone(),
                    store: store_port,
                },
            },
            store,
            host,
            options: EngineOptions::default(),
            idle_after: settings.idle_after,
            harness: settings.harness,
            sessions: Mutex::new(HashMap::new()),
            opening: tokio::sync::Mutex::new(()),
            replication: Mutex::new(None),
            stopping: CancellationToken::new(),
        });
        if let Some(replicator) = engine.store.replicator() {
            let token = CancellationToken::new();
            let task = tokio::spawn(replicator.run(token.clone()));
            *engine.replication_slot() = Some((token, task));
        }
        tokio::spawn(evict_idle(Arc::downgrade(&engine)));
        Ok(engine)
    }

    pub fn catalog(&self) -> &Arc<LiveCatalog> {
        &self.catalog
    }

    pub fn store(&self) -> &SqliteStore {
        &self.store
    }

    fn live(&self) -> std::sync::MutexGuard<'_, HashMap<SessionId, Live>> {
        self.sessions.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn replication_slot(
        &self,
    ) -> std::sync::MutexGuard<'_, Option<(CancellationToken, JoinHandle<()>)>> {
        self.replication
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    fn ports(&self, session: &SessionId) -> Ports {
        let template = self.ports.clone();
        Ports {
            store: template.store,
            provider: template.provider,
            tools: Arc::new(SessionTools::new(session.clone(), template.tools)),
            checkpointer: template.checkpointer,
            approver: template.approver,
            clock: template.clock,
            ids: template.ids,
            // Reads only harness results, so a session without the harness
            // gets no edits but its image budget.
            context_policy: Arc::new(HarnessContextPolicy),
        }
    }

    pub fn new_session_id(&self) -> SessionId {
        SessionId(self.ports.ids.next("ses"))
    }

    pub async fn create(
        &self,
        id: Option<SessionId>,
        config: SessionConfig,
    ) -> Result<Session, OpenError> {
        let _opening = self.opening.lock().await;
        let id = id.unwrap_or_else(|| self.new_session_id());
        let session =
            Session::create(self.ports(&id), self.options.clone(), id.clone(), config).await?;
        self.keep(session.clone());
        Ok(session)
    }

    /// The session, from memory or opened from the log; pulled from Blame's
    /// database first when the client copies logs there (it may have been
    /// continued on another machine, or never run on this one).
    pub async fn session(&self, id: &SessionId) -> Result<Session, OpenError> {
        if let Some(session) = self.touch(id) {
            return Ok(session);
        }
        let _opening = self.opening.lock().await;
        if let Some(session) = self.touch(id) {
            return Ok(session);
        }
        if self.remote {
            match self.store.hydrate(id).await {
                Ok(head) => log!(Debug, "session {id} hydrated up to {head}"),
                Err(StoreError::UnknownSession(_)) => {
                    return Err(StoreError::UnknownSession(id.clone()).into());
                }
                // The database is out of reach: what this machine has is
                // still the session, possibly behind.
                Err(error) => log!(Warn, "session {id} could not be pulled: {error}"),
            }
        }
        let session = Session::open(self.ports(id), self.options.clone(), id.clone()).await?;
        self.keep(session.clone());
        Ok(session)
    }

    fn touch(&self, id: &SessionId) -> Option<Session> {
        let mut live = self.live();
        let entry = live.get_mut(id)?;
        entry.last_used = Instant::now();
        Some(entry.session.clone())
    }

    fn keep(&self, session: Session) {
        self.live().insert(
            session.id().clone(),
            Live {
                session,
                last_used: Instant::now(),
                subscribers: HashMap::new(),
            },
        );
    }

    /// Forgets the in-memory copy, after a storage failure broke it: the
    /// next use opens it again from the log.
    pub fn forget(&self, id: &SessionId) {
        if let Some(live) = self.live().remove(id) {
            for forwarder in live.subscribers.values() {
                forwarder.abort();
            }
        }
    }

    /// A fork, opened with its own tool router (the core opens it with its
    /// parent's ports).
    pub async fn fork(
        &self,
        parent: &Session,
        at: Seq,
        workspace_root: String,
    ) -> Result<Session, OpenError> {
        let id = self.new_session_id();
        let fork = parent.fork(at, workspace_root, id.clone()).await?;
        fork.close().await?;
        drop(fork);
        self.session(&id).await
    }

    pub async fn close(&self, id: &SessionId) -> Result<(), OpenError> {
        let live = self.live().remove(id);
        if let Some(live) = live {
            for forwarder in live.subscribers.values() {
                forwarder.abort();
            }
            live.session.close().await?;
        }
        Ok(())
    }

    pub fn add_subscriber(&self, id: &SessionId, connection: ConnectionId, forwarder: AbortHandle) {
        let mut live = self.live();
        match live.get_mut(id) {
            Some(entry) => {
                if let Some(previous) = entry.subscribers.insert(connection, forwarder) {
                    previous.abort();
                }
            }
            None => forwarder.abort(),
        }
    }

    pub fn remove_subscriber(&self, id: &SessionId, connection: ConnectionId) {
        if let Some(entry) = self.live().get_mut(id)
            && let Some(forwarder) = entry.subscribers.remove(&connection)
        {
            forwarder.abort();
        }
    }

    /// A connection went away: its subscriptions end.
    pub fn drop_connection(&self, connection: ConnectionId) {
        for entry in self.live().values_mut() {
            if let Some(forwarder) = entry.subscribers.remove(&connection) {
                forwarder.abort();
            }
        }
        self.host.detach(connection);
    }

    /// The first configuration of a stored session, for `session/list`: one
    /// row read, where the current one would take the whole log.
    pub async fn first_config(&self, id: &SessionId) -> Option<SessionConfig> {
        let first = self.store.read(id, 0, Some(1)).await.ok()?;
        match first.into_iter().next()?.body {
            RecordBody::SessionCreated { config } => Some(config),
            _ => None,
        }
    }

    pub fn is_stopping(&self) -> bool {
        self.stopping.is_cancelled()
    }

    /// Stops every session (running turns end as interrupted, queued
    /// messages are dropped), lets the client take the last records when it
    /// is still there, and stops the harness. Bounded in time: what does not
    /// finish is finished by recovery when the session is next opened.
    pub async fn shutdown(&self, client_alive: bool) {
        if self.stopping.is_cancelled() {
            return;
        }
        self.stopping.cancel();
        let sessions: Vec<Live> = self.live().drain().map(|(_, live)| live).collect();
        let stops = sessions.into_iter().map(|live| async move {
            for forwarder in live.subscribers.values() {
                forwarder.abort();
            }
            let session = live.session;
            let _ = session.interrupt().await;
            if let Err(error) = session.close().await {
                log!(Warn, "session {}: {error}", session.id());
            }
        });
        if tokio::time::timeout(STOP_TURNS, futures_util::future::join_all(stops))
            .await
            .is_err()
        {
            log!(
                Warn,
                "some turns did not stop in time; they are ended when reopened"
            );
        }
        if client_alive && self.remote {
            match self.store.wait_flushed(FLUSH).await {
                Ok(true) => {}
                Ok(false) => log!(Warn, "not every record reached the client before exit"),
                Err(error) => log!(Warn, "replication: {error}"),
            }
        }
        let replication = self.replication_slot().take();
        if let Some((token, task)) = replication {
            token.cancel();
            let _ = tokio::time::timeout(Duration::from_secs(2), task).await;
        }
        if let Some(harness) = &self.harness {
            harness.stop().await;
        }
    }
}

/// Drops sessions that no turn, no subscriber and no command used for a
/// while. Their log holds everything: opening them again rebuilds them.
async fn evict_idle(engine: std::sync::Weak<Engine>) {
    let every = {
        let Some(engine) = engine.upgrade() else {
            return;
        };
        (engine.idle_after / 4).clamp(Duration::from_secs(1), Duration::from_secs(30))
    };
    loop {
        tokio::time::sleep(every).await;
        let Some(engine) = engine.upgrade() else {
            return;
        };
        if engine.is_stopping() {
            return;
        }
        let now = Instant::now();
        let idle_after = engine.idle_after;
        let dropped: Vec<SessionId> = {
            let mut live = engine.live();
            let idle: Vec<SessionId> = live
                .iter()
                .filter(|(_, entry)| {
                    entry.subscribers.is_empty()
                        && entry.session.is_idle()
                        && now.duration_since(entry.last_used) >= idle_after
                })
                .map(|(id, _)| id.clone())
                .collect();
            for id in &idle {
                live.remove(id);
            }
            idle
        };
        for id in dropped {
            log!(Debug, "session {id} dropped from memory after being idle");
        }
    }
}
