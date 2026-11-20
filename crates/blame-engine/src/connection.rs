//! One client connection: the ordered queue of what the engine writes to it,
//! and the requests the engine itself sends it (`host/*`), each waiting for
//! its answer.

use crate::log::log;
use crate::transport::Outbound;
use blame_engine_protocol::rpc::{
    EngineNotification, EngineRequest, Message, Outcome, RpcError, Version,
};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

/// Messages queued for the writer before senders wait. Deltas of three
/// streaming sessions fit comfortably; a client that stops reading makes
/// the senders wait, and a subscriber that waits too long lags and catches
/// up from the log.
const QUEUE: usize = 512;

/// Why a request to the client got no usable answer.
#[derive(Debug, thiserror::Error)]
pub enum HostError {
    #[error("no client is attached")]
    NoClient,
    #[error("the client disconnected")]
    Disconnected,
    #[error("the client answered with an error: {0}")]
    Rpc(String),
    #[error("the client's answer cannot be read: {0}")]
    Decode(String),
}

pub type ConnectionId = u64;

/// What the writer task is given.
enum Out {
    Line(String),
    /// Answered once everything queued before it is written and flushed.
    Drained(oneshot::Sender<()>),
}

pub struct Connection {
    id: ConnectionId,
    out: mpsc::Sender<Out>,
    next_request: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<Outcome>>>,
    closed: CancellationToken,
}

impl Connection {
    /// A connection writing through `outbound`; the writer task ends once
    /// every handle to the connection is gone and the queue is drained.
    pub fn start(id: ConnectionId, mut outbound: Box<dyn Outbound>) -> Arc<Self> {
        let (out, mut queue) = mpsc::channel::<Out>(QUEUE);
        let closed = CancellationToken::new();
        let connection = Arc::new(Self {
            id,
            out,
            next_request: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            closed: closed.clone(),
        });
        tokio::spawn(async move {
            while let Some(message) = queue.recv().await {
                let message = match message {
                    Out::Line(message) => message,
                    Out::Drained(done) => {
                        let _ = outbound.flush().await;
                        let _ = done.send(());
                        continue;
                    }
                };
                // Flush only when nothing else is waiting: one syscall for a
                // burst of deltas.
                let flush = queue.is_empty();
                if let Err(error) = outbound.send(&message, flush).await {
                    log!(Warn, "the client's output is closed: {error}");
                    closed.cancel();
                    break;
                }
            }
        });
        connection
    }

    pub fn id(&self) -> ConnectionId {
        self.id
    }

    pub fn is_closed(&self) -> bool {
        self.closed.is_cancelled()
    }

    async fn send<T: Serialize>(&self, message: &T) -> bool {
        let Ok(line) = serde_json::to_string(message) else {
            return false;
        };
        self.out.send(Out::Line(line)).await.is_ok()
    }

    /// Resolves once everything queued so far is written out.
    pub async fn drained(&self) {
        let (done, wait) = oneshot::channel();
        if self.out.send(Out::Drained(done)).await.is_ok() {
            let _ = wait.await;
        }
    }

    pub async fn respond(&self, id: u64, outcome: Outcome) {
        let message: Message<EngineRequest> = Message::Response {
            jsonrpc: Version::V2,
            id,
            outcome,
        };
        self.send(&message).await;
    }

    /// An error answer to a message whose id could not be read.
    pub async fn respond_without_id(&self, error: RpcError) {
        let message = serde_json::json!({ "jsonrpc": "2.0", "id": null, "error": error });
        self.send(&message).await;
    }

    pub async fn notify(&self, notification: EngineNotification) -> bool {
        let message: Message<EngineNotification> = Message::Notification {
            jsonrpc: Version::V2,
            call: notification,
        };
        self.send(&message).await
    }

    /// Sends `call` and waits for the client's answer. Dropping the future
    /// before the answer withdraws the request with `$/cancel`.
    pub async fn request(&self, call: EngineRequest) -> Result<Value, HostError> {
        if self.is_closed() {
            return Err(HostError::Disconnected);
        }
        let id = self.next_request.fetch_add(1, Ordering::Relaxed);
        let (reply, answer) = oneshot::channel();
        self.pending_map().insert(id, reply);
        let mut guard = Withdraw {
            connection: self,
            id,
            answered: false,
        };
        let message: Message<EngineRequest> = Message::Request {
            jsonrpc: Version::V2,
            id,
            call,
        };
        if !self.send(&message).await {
            guard.answered = true;
            self.pending_map().remove(&id);
            return Err(HostError::Disconnected);
        }
        let outcome = answer.await;
        guard.answered = true;
        match outcome {
            Ok(Outcome::Result(value)) => Ok(value),
            Ok(Outcome::Error(error)) => Err(HostError::Rpc(error.message)),
            Err(_) => Err(HostError::Disconnected),
        }
    }

    /// The client's answer to one of our requests.
    pub fn answer(&self, id: u64, outcome: Outcome) {
        match self.pending_map().remove(&id) {
            Some(reply) => {
                let _ = reply.send(outcome);
            }
            None => log!(Debug, "an answer to request {id}, which nobody waits for"),
        }
    }

    /// The client is gone: every request waiting for it fails now, and so
    /// does every later one.
    pub fn close(&self) {
        self.closed.cancel();
        self.pending_map().clear();
    }

    fn pending_map(&self) -> std::sync::MutexGuard<'_, HashMap<u64, oneshot::Sender<Outcome>>> {
        self.pending.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Sends `$/cancel` for a request whose waiter went away before its answer.
struct Withdraw<'a> {
    connection: &'a Connection,
    id: u64,
    answered: bool,
}

impl Drop for Withdraw<'_> {
    fn drop(&mut self) {
        if self.answered {
            return;
        }
        self.connection.pending_map().remove(&self.id);
        if self.connection.is_closed() {
            return;
        }
        let message: Message<EngineRequest> = Message::Notification {
            jsonrpc: Version::V2,
            call: EngineRequest::Cancel { id: self.id },
        };
        let Ok(line) = serde_json::to_string(&message) else {
            return;
        };
        // Dropping cannot wait: queue it now, or from a task when the queue
        // is full.
        if let Err(mpsc::error::TrySendError::Full(line)) =
            self.connection.out.try_send(Out::Line(line))
        {
            let out = self.connection.out.clone();
            tokio::spawn(async move {
                let _ = out.send(line).await;
            });
        }
    }
}

/// The client the engine asks for what only a client has. Requests made
/// while none is attached fail at once with [`HostError::NoClient`].
#[derive(Default)]
pub struct Host {
    current: Mutex<Option<Arc<Connection>>>,
}

impl Host {
    pub fn attach(&self, connection: Arc<Connection>) {
        *self.slot() = Some(connection);
    }

    /// Forgets `connection` if it is the attached one.
    pub fn detach(&self, connection: ConnectionId) {
        let mut slot = self.slot();
        if slot.as_ref().is_some_and(|c| c.id() == connection) {
            *slot = None;
        }
    }

    pub fn connection(&self) -> Option<Arc<Connection>> {
        self.slot().clone()
    }

    pub async fn request<T: serde::de::DeserializeOwned>(
        &self,
        call: EngineRequest,
    ) -> Result<T, HostError> {
        let connection = self.connection().ok_or(HostError::NoClient)?;
        let value = connection.request(call).await?;
        serde_json::from_value(value).map_err(|error| HostError::Decode(error.to_string()))
    }

    fn slot(&self) -> std::sync::MutexGuard<'_, Option<Arc<Connection>>> {
        self.current.lock().unwrap_or_else(PoisonError::into_inner)
    }
}
