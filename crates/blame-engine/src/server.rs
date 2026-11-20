//! `blame-engine serve`: the client protocol over one connection.
//!
//! Each client request runs in its own task, so a long one (a rewind
//! restoring files, an open pulling a session from the database) never holds
//! up an interrupt sent after it. The client's answers to the engine's own
//! requests are routed back to whoever waits for them.
//!
//! The engine exits when it is told to (`shutdown`), when its input closes
//! (the client died: there is nobody left to work for, since agents stop
//! when the app quits), or on SIGTERM/SIGINT/SIGHUP. In every case running
//! turns are interrupted and end as such in the log.

use crate::connection::{Connection, Host};
use crate::engine::{Engine, OpenError, Settings};
use crate::log::log;
use crate::transport::{Inbound, Outbound};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use blame_engine_core::ports::{SessionStore, StoreError};
use blame_engine_core::projection::task_outcome;
use blame_engine_core::{EngineError, Session, SessionEvent};
use blame_engine_protocol::rpc::{
    ClientRequest, EngineNotification, Initialized, Message, Outcome, Records, RpcError,
    RpcErrorData, SessionList, SessionOpened, SessionSummary, Subscribed,
};
use blame_engine_protocol::{
    Delta, ErrorKind, PROTOCOL_VERSION, Record, Seq, SessionConfig, SessionId, TaskOutcome,
    UserBlock,
};
use serde_json::Value;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::Duration;
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

/// The largest page `session/read` returns.
const MAX_READ: u32 = 1000;

/// The largest blob a client may put: what Blame's database accepts
/// (`packages/api/config/engine_sessions.ts`).
const MAX_BLOB: usize = 25 * 1024 * 1024;

struct Server {
    settings: Mutex<Option<Settings>>,
    engine: OnceLock<Arc<Engine>>,
    /// Serialises `initialize`.
    starting: tokio::sync::Mutex<()>,
    host: Arc<Host>,
    /// Set once `shutdown` has stopped everything and answered.
    exit: CancellationToken,
    /// Client requests still running, waited for before the engine stops.
    requests: TaskTracker,
    /// The task each running `task/run` request drives, by request id: what
    /// a `$/cancel` of that request interrupts.
    tasks: Mutex<HashMap<u64, SessionId>>,
}

/// How long requests received before the end may take to finish.
const FINISH_REQUESTS: Duration = Duration::from_secs(5);

/// Serves one client until it leaves or asks the engine to stop.
pub async fn serve(settings: Settings, mut inbound: Box<dyn Inbound>, outbound: Box<dyn Outbound>) {
    let server = Arc::new(Server {
        settings: Mutex::new(Some(settings)),
        engine: OnceLock::new(),
        starting: tokio::sync::Mutex::new(()),
        host: Arc::new(Host::default()),
        exit: CancellationToken::new(),
        requests: TaskTracker::new(),
        tasks: Mutex::new(HashMap::new()),
    });
    let connection = Connection::start(1, outbound);
    let stop_signal = stop_signal();
    tokio::pin!(stop_signal);
    let reason = loop {
        tokio::select! {
            message = inbound.next() => match message {
                Some(Ok(line)) => {
                    if let Some(initialize) = dispatch(&server, &connection, &line) {
                        // Nothing else is read until the engine is up, so
                        // requests sent right behind `initialize` find it.
                        initialize.await;
                    }
                }
                Some(Err(error)) => break format!("the client's input failed: {error}"),
                None => break "the client's input closed".to_owned(),
            },
            () = server.exit.cancelled() => break "shutdown".to_owned(),
            signal = &mut stop_signal => break format!("{signal} received"),
        }
    };
    log!(Info, "stopping: {reason}");
    if !server.exit.is_cancelled() {
        // Nobody will read what the engine writes from now on, unless a
        // signal stopped it while the client is still there.
        let client_alive = reason.ends_with("received") && !connection.is_closed();
        if !client_alive {
            connection.close();
            server.host.detach(connection.id());
            if let Some(engine) = server.engine.get() {
                engine.drop_connection(connection.id());
            }
        }
        server.finish_requests().await;
        if let Some(engine) = server.engine.get() {
            engine.shutdown(client_alive).await;
        }
    }
    connection.drained().await;
    log!(Info, "stopped");
}

/// What the reader finishes before it reads the next message.
type Barrier = Pin<Box<dyn Future<Output = ()> + Send>>;

/// Handles one message. An `initialize` request is returned instead of
/// spawned, for the caller to finish before reading further; so is the
/// creation of a `task/run`'s session, whose run then goes on by itself.
fn dispatch(server: &Arc<Server>, connection: &Arc<Connection>, line: &str) -> Option<Barrier> {
    let value: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(error) => {
            let connection = connection.clone();
            let error = rpc_error(
                -32700,
                format!("not JSON: {error}"),
                ErrorKind::InvalidRequest,
            );
            tokio::spawn(async move { connection.respond_without_id(error).await });
            return None;
        }
    };
    let id = value.get("id").and_then(Value::as_u64);
    let method = value
        .get("method")
        .and_then(Value::as_str)
        .map(str::to_owned);
    match serde_json::from_value::<Message<ClientRequest>>(value) {
        Ok(Message::Request {
            id,
            call:
                ClientRequest::RunTask {
                    session,
                    config,
                    instruction,
                },
            ..
        }) => {
            let (created, ready) = tokio::sync::oneshot::channel();
            let task_server = server.clone();
            let connection = connection.clone();
            server.requests.spawn(async move {
                let outcome =
                    match run_task(&task_server, id, session, config, instruction, created).await {
                        Ok(value) => Outcome::Result(value.unwrap_or(Value::Null)),
                        Err(error) => Outcome::Error(error),
                    };
                connection.respond(id, outcome).await;
            });
            return Some(Box::pin(async move {
                // Dropped without a send when the creation failed.
                let _ = ready.await;
            }));
        }
        Ok(Message::Request { id, call, .. }) => {
            let initialize = matches!(call, ClientRequest::Initialize { .. });
            let shutdown = matches!(call, ClientRequest::Shutdown {});
            let tracker = server.requests.clone();
            let server = server.clone();
            let connection = connection.clone();
            let task = async move {
                let outcome = match handle(&server, &connection, id, call).await {
                    Ok(Some(value)) => Outcome::Result(value),
                    Ok(None) => return,
                    Err(error) => Outcome::Error(error),
                };
                connection.respond(id, outcome).await;
            };
            if initialize {
                return Some(Box::pin(task));
            }
            if shutdown {
                // Not tracked: it waits for the tracked ones.
                tokio::spawn(task);
            } else {
                tracker.spawn(task);
            }
        }
        Ok(Message::Response { id, outcome, .. }) => connection.answer(id, outcome),
        Ok(Message::Notification {
            call: ClientRequest::Cancel { id },
            ..
        }) => {
            // A task stops; every other request changes a session or is
            // quick, and runs to its end, so that what the log says and what
            // the client was told stay the same.
            match server.task_of(id) {
                Some(session) => {
                    let server = server.clone();
                    tokio::spawn(async move { server.interrupt_task(&session).await });
                }
                None => log!(Debug, "$/cancel of request {id}: it runs to completion"),
            }
        }
        Ok(Message::Notification {
            call: ClientRequest::ToolProgress { call, text },
            ..
        }) => server.host.progress(&call, text),
        Ok(Message::Notification { .. }) => {}
        Err(error) => {
            let Some(id) = id else {
                log!(Debug, "ignored an unreadable notification: {error}");
                return None;
            };
            let error = match method {
                Some(method) if KNOWN_METHODS.contains(&method.as_str()) => rpc_error(
                    -32602,
                    format!("invalid params for {method}: {error}"),
                    ErrorKind::InvalidRequest,
                ),
                Some(method) => rpc_error(
                    -32601,
                    format!("unknown method {method}"),
                    ErrorKind::InvalidRequest,
                ),
                None => rpc_error(
                    -32600,
                    format!("not a request: {error}"),
                    ErrorKind::InvalidRequest,
                ),
            };
            let connection = connection.clone();
            tokio::spawn(async move { connection.respond(id, Outcome::Error(error)).await });
        }
    }
    None
}

const KNOWN_METHODS: &[&str] = &[
    "initialize",
    "session/create",
    "session/open",
    "session/list",
    "session/read",
    "session/subscribe",
    "session/unsubscribe",
    "session/send",
    "session/interrupt",
    "session/rewind",
    "session/undo_rewind",
    "session/fork",
    "session/compact",
    "session/configure",
    "session/close",
    "session/delete",
    "task/run",
    "blob/put",
    "tool/progress",
    "shutdown",
    "$/cancel",
];

type Handled = Result<Option<Value>, RpcError>;

fn reply<T: serde::Serialize>(value: T) -> Handled {
    serde_json::to_value(value)
        .map(Some)
        .map_err(|error| rpc_error(-32603, error.to_string(), ErrorKind::Internal))
}

async fn handle(
    server: &Arc<Server>,
    connection: &Arc<Connection>,
    request_id: u64,
    call: ClientRequest,
) -> Handled {
    match call {
        ClientRequest::Initialize {
            protocol_version,
            client_name,
            client_version,
            remote_log,
        } => {
            initialize(server, connection, protocol_version, remote_log).await?;
            log!(
                Info,
                "client {client_name} {client_version} attached (remote log: {remote_log})"
            );
            reply(Initialized {
                protocol_version: PROTOCOL_VERSION,
                engine_version: env!("CARGO_PKG_VERSION").to_owned(),
            })
        }
        ClientRequest::Shutdown {} => {
            server.finish_requests().await;
            if let Some(engine) = server.engine.get() {
                engine.shutdown(true).await;
            }
            connection
                .respond(request_id, Outcome::Result(Value::Null))
                .await;
            server.exit.cancel();
            Ok(None)
        }
        ClientRequest::Cancel { .. } | ClientRequest::ToolProgress { .. } => Ok(Some(Value::Null)),
        call => {
            let engine = server.engine.get().cloned().ok_or_else(|| {
                rpc_error(-32002, "initialize first".into(), ErrorKind::InvalidRequest)
            })?;
            if engine.is_stopping() {
                return Err(rpc_error(
                    -32000,
                    "the engine is stopping".into(),
                    ErrorKind::Cancelled,
                ));
            }
            session_call(&engine, connection, request_id, call).await
        }
    }
}

impl Server {
    fn tasks_slot(&self) -> std::sync::MutexGuard<'_, HashMap<u64, SessionId>> {
        self.tasks.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn task_of(&self, request: u64) -> Option<SessionId> {
        self.tasks_slot().get(&request).cloned()
    }

    async fn interrupt_task(&self, session: &SessionId) {
        let Some(engine) = self.engine.get() else {
            return;
        };
        match engine.session(session).await {
            Ok(live) => {
                if let Err(error) = live.interrupt().await {
                    log!(Warn, "task {session} could not be interrupted: {error}");
                }
            }
            Err(error) => log!(Warn, "task {session} could not be interrupted: {error}"),
        }
    }

    /// Lets the requests already received finish, for a bounded time: a
    /// message the client sent right before `shutdown` is still stored.
    /// Running tasks are interrupted first: they would not end by
    /// themselves in time.
    async fn finish_requests(&self) {
        self.requests.close();
        let running: Vec<SessionId> = self.tasks_slot().values().cloned().collect();
        for session in running {
            self.interrupt_task(&session).await;
        }
        if tokio::time::timeout(FINISH_REQUESTS, self.requests.wait())
            .await
            .is_err()
        {
            log!(Warn, "some requests were still running at exit");
        }
    }
}

async fn initialize(
    server: &Server,
    connection: &Arc<Connection>,
    protocol_version: u32,
    remote_log: bool,
) -> Result<(), RpcError> {
    if protocol_version != PROTOCOL_VERSION {
        return Err(rpc_error(
            -32000,
            format!("this engine speaks protocol {PROTOCOL_VERSION}, not {protocol_version}"),
            ErrorKind::InvalidRequest,
        ));
    }
    let _starting = server.starting.lock().await;
    if server.engine.get().is_some() {
        return Err(rpc_error(
            -32000,
            "already initialized".into(),
            ErrorKind::InvalidRequest,
        ));
    }
    let settings = server
        .settings
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .take()
        .ok_or_else(|| {
            rpc_error(
                -32000,
                "already initialized".into(),
                ErrorKind::InvalidRequest,
            )
        })?;
    server.host.attach(connection.clone());
    let engine = Engine::start(settings, server.host.clone(), remote_log)
        .await
        .map_err(|message| rpc_error(-32000, message, ErrorKind::Internal))?;
    let _ = server.engine.set(engine);
    Ok(())
}

async fn session_call(
    engine: &Arc<Engine>,
    connection: &Arc<Connection>,
    request_id: u64,
    call: ClientRequest,
) -> Handled {
    // Runs `$op` on the session; a storage failure makes the engine forget
    // its copy so the next request opens it again from the log.
    macro_rules! on_session {
        ($id:expr, |$session:ident| $op:expr) => {{
            let id: &SessionId = $id;
            let $session = engine.session(id).await.map_err(open_error)?;
            match $op.await {
                Ok(value) => value,
                Err(error) => {
                    if matches!(error, EngineError::Broken(_) | EngineError::Store(_)) {
                        engine.forget(id);
                    }
                    return Err(engine_error(error));
                }
            }
        }};
    }
    match call {
        ClientRequest::Create { session, config } => {
            let session = engine.create(session, config).await.map_err(open_error)?;
            reply(opened(&session).await)
        }
        ClientRequest::Open { session } => {
            let session = engine.session(&session).await.map_err(open_error)?;
            reply(opened(&session).await)
        }
        ClientRequest::List {} => {
            let stored = engine.store().sessions().await.map_err(store_error)?;
            let mut sessions = Vec::with_capacity(stored.len());
            for stored in stored {
                let config = engine.first_config(&stored.session).await;
                sessions.push(SessionSummary {
                    purpose: config
                        .as_ref()
                        .map(|c| c.purpose.clone())
                        .unwrap_or_default(),
                    workspace_root: config.map(|c| c.workspace_root).unwrap_or_default(),
                    session: stored.session,
                    head: stored.head,
                    updated_at_ms: stored.updated_at_ms,
                });
            }
            reply(SessionList { sessions })
        }
        ClientRequest::Read {
            session,
            after,
            limit,
        } => {
            let live = engine.session(&session).await.map_err(open_error)?;
            let records = engine
                .store()
                .read(&session, after, Some(limit.clamp(1, MAX_READ)))
                .await
                .map_err(store_error)?;
            reply(Records {
                records,
                head: live.head().await,
            })
        }
        ClientRequest::Subscribe { session: id, after } => {
            let session = engine.session(&id).await.map_err(open_error)?;
            let subscription = session.subscribe(after).await;
            // The answer goes out before the backlog, on the same ordered
            // queue, so the client knows the starting point first.
            let answer = reply(Subscribed {
                head: subscription.head,
                activity: subscription.activity,
                in_flight: subscription.in_flight,
            })?
            .unwrap_or(Value::Null);
            connection
                .respond(request_id, Outcome::Result(answer))
                .await;
            let forwarder = tokio::spawn(forward(
                connection.clone(),
                session,
                after,
                subscription.records,
                subscription.events,
            ));
            engine.add_subscriber(&id, connection.id(), forwarder.abort_handle());
            Ok(None)
        }
        ClientRequest::Unsubscribe { session } => {
            engine.remove_subscriber(&session, connection.id());
            Ok(Some(Value::Null))
        }
        ClientRequest::Send {
            session,
            input,
            delivery,
        } => reply(on_session!(&session, |s| s.send(input, delivery))),
        ClientRequest::Interrupt { session } => {
            on_session!(&session, |s| s.interrupt());
            Ok(Some(Value::Null))
        }
        ClientRequest::Rewind {
            session,
            to,
            restore_workspace,
        } => reply(on_session!(&session, |s| s.rewind(to, restore_workspace))),
        ClientRequest::UndoRewind { session } => {
            on_session!(&session, |s| s.undo_rewind());
            Ok(Some(Value::Null))
        }
        ClientRequest::Fork {
            session,
            at,
            workspace_root,
        } => {
            let parent = engine.session(&session).await.map_err(open_error)?;
            let fork = engine
                .fork(&parent, at, workspace_root)
                .await
                .map_err(open_error)?;
            reply(opened(&fork).await)
        }
        ClientRequest::Compact { session } => {
            on_session!(&session, |s| s.compact());
            Ok(Some(Value::Null))
        }
        ClientRequest::Configure { session, config } => {
            on_session!(&session, |s| s.configure(config));
            Ok(Some(Value::Null))
        }
        ClientRequest::Close { session } => {
            engine.close(&session).await.map_err(open_error)?;
            Ok(Some(Value::Null))
        }
        ClientRequest::Delete { session } => {
            engine.delete(&session).await.map_err(open_error)?;
            Ok(Some(Value::Null))
        }
        ClientRequest::CatalogList { refresh } => {
            let catalog = engine.catalog();
            if refresh {
                // A failure is in the listing's `refresh_error`.
                let _ = catalog.refresh(false).await;
            } else {
                catalog.refresh_if_stale();
            }
            reply(catalog.listing())
        }
        ClientRequest::PutBlob { media_type, data } => {
            let bytes = decode_blob(&media_type, &data)?;
            let blob = engine
                .store()
                .put_blob(&media_type, bytes)
                .await
                .map_err(store_error)?;
            reply(blob)
        }
        ClientRequest::Initialize { .. }
        | ClientRequest::Shutdown {}
        | ClientRequest::Cancel { .. }
        | ClientRequest::RunTask { .. }
        | ClientRequest::ToolProgress { .. } => {
            unreachable!("handled before")
        }
    }
}

/// Starts a task, tells the reader once its session exists, and answers
/// with its outcome when it ends.
async fn run_task(
    server: &Arc<Server>,
    request: u64,
    session: Option<SessionId>,
    config: SessionConfig,
    instruction: Vec<UserBlock>,
    created: tokio::sync::oneshot::Sender<()>,
) -> Handled {
    let engine =
        server.engine.get().cloned().ok_or_else(|| {
            rpc_error(-32002, "initialize first".into(), ErrorKind::InvalidRequest)
        })?;
    if engine.is_stopping() {
        return Err(rpc_error(
            -32000,
            "the engine is stopping".into(),
            ErrorKind::Cancelled,
        ));
    }
    let session = engine
        .create_task(session, config, instruction)
        .await
        .map_err(open_error)?;
    server.tasks_slot().insert(request, session.id().clone());
    let _ = created.send(());
    session.wait_idle().await;
    server.tasks_slot().remove(&request);
    let records = session.records().await;
    // A task whose turn did not end (its log broke on a storage failure)
    // stopped all the same.
    reply(task_outcome(&records).unwrap_or(TaskOutcome::Interrupted))
}

async fn opened(session: &Session) -> SessionOpened {
    SessionOpened {
        session: session.id().clone(),
        head: session.head().await,
        activity: session.activity(),
    }
}

/// Sends a subscriber the records after `after`, then what happens live.
/// A subscriber that falls behind the live feed catches up from the log:
/// records are never skipped, deltas it missed are restated by the records
/// that follow them.
async fn forward(
    connection: Arc<Connection>,
    session: Session,
    after: Seq,
    backlog: Vec<Record>,
    mut events: broadcast::Receiver<SessionEvent>,
) {
    let id = session.id().clone();
    let mut last = after;
    let send_record = |record: Record, last: &mut Seq| {
        (record.seq > *last).then(|| {
            *last = record.seq;
            EngineNotification::Record {
                session: id.clone(),
                record,
            }
        })
    };
    for record in backlog {
        if let Some(notification) = send_record(record, &mut last)
            && !connection.notify(notification).await
        {
            return;
        }
    }
    loop {
        let notification = match events.recv().await {
            Ok(SessionEvent::Record(record)) => match send_record(record, &mut last) {
                Some(notification) => notification,
                None => continue,
            },
            Ok(SessionEvent::Delta(delta)) => EngineNotification::Delta {
                session: id.clone(),
                delta,
            },
            Err(broadcast::error::RecvError::Lagged(missed)) => {
                log!(
                    Debug,
                    "subscriber of {id} missed {missed} events; catching up from {last}"
                );
                let subscription = session.subscribe(last).await;
                events = subscription.events;
                for record in subscription.records {
                    if let Some(notification) = send_record(record, &mut last)
                        && !connection.notify(notification).await
                    {
                        return;
                    }
                }
                EngineNotification::Delta {
                    session: id.clone(),
                    delta: Delta::Activity {
                        activity: subscription.activity,
                    },
                }
            }
            Err(broadcast::error::RecvError::Closed) => return,
        };
        if !connection.notify(notification).await {
            return;
        }
    }
}

/// The bytes of a `blob/put`, refused when Blame's database would refuse to
/// keep them: a blob that cannot be copied there would make its session
/// impossible to reopen on another machine.
fn decode_blob(media_type: &str, data: &str) -> Result<Vec<u8>, RpcError> {
    let invalid = |message: String| rpc_error(-32602, message, ErrorKind::InvalidRequest);
    if media_type.is_empty() || !media_type.contains('/') {
        return Err(invalid(format!("`{media_type}` is not a media type")));
    }
    let bytes = BASE64
        .decode(data)
        .map_err(|error| invalid(format!("the blob is not base64: {error}")))?;
    if bytes.len() > MAX_BLOB {
        return Err(invalid(format!(
            "the blob has {} bytes, more than the {MAX_BLOB} a blob may have",
            bytes.len()
        )));
    }
    Ok(bytes)
}

fn rpc_error(code: i32, message: String, kind: ErrorKind) -> RpcError {
    RpcError {
        code,
        message,
        data: Some(RpcErrorData { kind }),
    }
}

fn store_error(error: StoreError) -> RpcError {
    let kind = match error {
        StoreError::UnknownSession(_) | StoreError::SessionExists(_) => ErrorKind::InvalidRequest,
        _ => ErrorKind::Internal,
    };
    rpc_error(-32000, error.to_string(), kind)
}

fn engine_error(error: EngineError) -> RpcError {
    let kind = match &error {
        EngineError::Store(StoreError::UnknownSession(_) | StoreError::SessionExists(_))
        | EngineError::Closed
        | EngineError::InvalidRewind { .. }
        | EngineError::NothingToUndo
        | EngineError::InvalidFork { .. }
        | EngineError::Task(_)
        | EngineError::InvalidContract(_) => ErrorKind::InvalidRequest,
        _ => ErrorKind::Internal,
    };
    rpc_error(-32000, error.to_string(), kind)
}

fn open_error(error: OpenError) -> RpcError {
    match error {
        OpenError::Engine(error) => engine_error(error),
        OpenError::Store(error) => store_error(error),
    }
}

/// Resolves with the signal's name when the process is asked to stop.
async fn stop_signal() -> &'static str {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let (Ok(mut term), Ok(mut int), Ok(mut hup)) = (
            signal(SignalKind::terminate()),
            signal(SignalKind::interrupt()),
            signal(SignalKind::hangup()),
        ) else {
            return std::future::pending().await;
        };
        tokio::select! {
            _ = term.recv() => "SIGTERM",
            _ = int.recv() => "SIGINT",
            _ = hup.recv() => "SIGHUP",
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
        "Ctrl-C"
    }
}
