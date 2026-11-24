//! The core's ports that the binary implements itself: time, ids, and what
//! is asked of the client (approvals, credentials, the copy of the logs in
//! Blame's database).

use crate::connection::{Host, HostError};
use crate::log::log;
use async_trait::async_trait;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use blame_engine_core::ports::{
    ApprovalRequest, Approver, Clock, IdSource, ModelEvent, ModelProvider, ModelRequest,
    ModelStream, ProviderError, RemoteLog, StoreError,
};
use blame_engine_protocol::rpc::{
    Approval, BlobPulled, Credential, EngineRequest, LogPushed, Records,
};
use blame_engine_protocol::{ApprovalDecision, BlobRef, ErrorKind, Record, Seq, SessionId};
use blame_engine_providers::{Options, Provider, connect};
use futures_util::StreamExt;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// The wall clock, and tokio's timer for waiting.
pub struct RealClock;

#[async_trait]
impl Clock for RealClock {
    fn now_ms(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
    }

    async fn sleep(&self, duration: Duration) {
        tokio::time::sleep(duration).await;
    }
}

/// Random ids: 122 random bits never repeat, across restarts or machines
/// (a session reopened elsewhere keeps adding turns and calls to its log).
pub struct RandomIds;

impl IdSource for RandomIds {
    fn next(&self, prefix: &str) -> String {
        format!("{prefix}-{}", uuid::Uuid::new_v4().simple())
    }
}

/// Approvals through `host/approval`. With no client, or one that cannot
/// answer, the call is denied: the loop records that, and the user can ask
/// again.
pub struct ClientApprover {
    pub host: Arc<Host>,
}

#[async_trait]
impl Approver for ClientApprover {
    async fn approve(&self, request: ApprovalRequest) -> ApprovalDecision {
        let call = EngineRequest::Approval {
            session: request.session,
            turn: request.turn,
            call: request.call,
            tool: request.tool,
            input: request.input,
        };
        // Dropping this future (an interrupt) withdraws the question.
        match self.host.request::<Approval>(call).await {
            Ok(approval) => approval.decision,
            Err(error) => {
                log!(Warn, "approval denied: {error}");
                ApprovalDecision::Denied
            }
        }
    }
}

/// Blame's database, reached through the client (`host/log/*`,
/// `host/blob/*`). Used only when the client announced `remote_log`.
pub struct ClientRemoteLog {
    pub host: Arc<Host>,
}

fn remote_error(error: HostError) -> StoreError {
    StoreError::Io(format!("remote log: {error}"))
}

#[async_trait]
impl RemoteLog for ClientRemoteLog {
    async fn push(&self, session: &SessionId, records: &[Record]) -> Result<Seq, StoreError> {
        let pushed: LogPushed = self
            .host
            .request(EngineRequest::LogPush {
                session: session.clone(),
                records: records.to_vec(),
            })
            .await
            .map_err(remote_error)?;
        Ok(pushed.acked)
    }

    async fn pull(&self, session: &SessionId, after: Seq) -> Result<Vec<Record>, StoreError> {
        let records: Records = self
            .host
            .request(EngineRequest::LogPull {
                session: session.clone(),
                after,
            })
            .await
            .map_err(remote_error)?;
        Ok(records.records)
    }

    async fn push_blob(&self, blob: &BlobRef, bytes: &[u8]) -> Result<(), StoreError> {
        self.host
            .request::<serde_json::Value>(EngineRequest::BlobPush {
                blob: blob.clone(),
                data: BASE64.encode(bytes),
            })
            .await
            .map_err(remote_error)?;
        Ok(())
    }

    async fn pull_blob(&self, sha256: &str) -> Result<Option<Vec<u8>>, StoreError> {
        let pulled: BlobPulled = self
            .host
            .request(EngineRequest::BlobPull {
                sha256: sha256.to_owned(),
            })
            .await
            .map_err(remote_error)?;
        pulled
            .data
            .map(|data| {
                BASE64
                    .decode(data)
                    .map_err(|error| StoreError::Corrupt(format!("blob {sha256}: {error}")))
            })
            .transpose()
    }
}

/// Providers whose credential belongs to one conversation: the client hands
/// out a key per session (the Claude Code bridge keeps one Claude Code
/// process per key), so they are connected once per session.
const SESSION_SCOPED: &[&str] = &["claude-code"];

/// Every provider, connected on first use with the credential the client
/// gives through `host/credential`. Credentials stay in memory only; one that
/// the provider refuses is asked for again, once per request. A broken
/// Claude Code socket can also be replaced before any events are delivered.
pub struct ProviderRouter {
    host: Arc<Host>,
    options: Options,
    connected: Mutex<HashMap<String, Slot>>,
}

/// A provider once connected; locked while its credential is asked for.
type Slot = Arc<tokio::sync::Mutex<Option<Arc<Provider>>>>;

impl ProviderRouter {
    pub fn new(host: Arc<Host>, options: Options) -> Self {
        Self {
            host,
            options,
            connected: Mutex::new(HashMap::new()),
        }
    }

    /// The connected provider `id`, asking the client for a credential when
    /// there is none yet or when `fresh` (the last one was refused).
    async fn provider(
        &self,
        id: &str,
        session: &SessionId,
        fresh: bool,
    ) -> Result<Arc<Provider>, ProviderError> {
        let key = if SESSION_SCOPED.contains(&id) {
            format!("{id}\u{0}{session}")
        } else {
            id.to_owned()
        };
        let slot = self
            .connected
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .entry(key)
            .or_default()
            .clone();
        // One question per provider at a time: three sessions starting
        // together ask once.
        let mut slot = slot.lock().await;
        if !fresh && let Some(provider) = slot.as_ref() {
            return Ok(provider.clone());
        }
        *slot = None;
        let credential = match self
            .host
            .request::<Credential>(EngineRequest::Credential {
                provider: id.to_owned(),
                session: session.clone(),
            })
            .await
        {
            Ok(credential) => credential,
            Err(HostError::Rpc(message)) if id == "claude-code" => {
                return Err(ProviderError::new(ErrorKind::Transport, message));
            }
            Err(error) => {
                log!(Warn, "no credential for `{id}`: {error}");
                Credential::Missing
            }
        };
        let provider = Arc::new(connect(id, &credential, &self.options)?);
        *slot = Some(provider.clone());
        Ok(provider)
    }

    /// Starts the request. An outer `Err` means the credential can be
    /// requested again before any model events are delivered.
    async fn attempt(
        provider: &Provider,
        request: ModelRequest,
    ) -> Result<Result<ModelStream, ProviderError>, ProviderError> {
        let refresh_credential = |error: &ProviderError| {
            error.kind == ErrorKind::Authentication
                || (provider.uses_claude_code_socket() && error.kind == ErrorKind::Transport)
        };
        let mut stream = match provider.stream(request).await {
            Ok(stream) => stream,
            Err(error) if refresh_credential(&error) => return Err(error),
            Err(error) => return Ok(Err(error)),
        };
        // HTTP errors arrive as the stream's first and only item: look at it
        // before handing the stream over, and put it back in front.
        let first = stream.next().await;
        if let Some(Err(error)) = &first
            && refresh_credential(error)
        {
            return Err(error.clone());
        }
        let first: Option<Result<ModelEvent, ProviderError>> = first;
        let replay = futures_util::stream::iter(first);
        Ok(Ok(Box::pin(replay.chain(stream))))
    }
}

#[async_trait]
impl ModelProvider for ProviderRouter {
    fn forces_tool(&self, model: &blame_engine_protocol::ModelRef) -> bool {
        blame_engine_providers::forces_tool(model)
    }

    async fn stream(&self, request: ModelRequest) -> Result<ModelStream, ProviderError> {
        let id = request.model.provider.clone();
        // The loop keys the prompt cache by session.
        let session = SessionId::from(request.cache.key.clone());
        let provider = self.provider(&id, &session, false).await?;
        match Self::attempt(&provider, request.clone()).await {
            Ok(result) => result,
            Err(error) => {
                log!(
                    Info,
                    "`{id}` could not use its credential ({}); asking the client again",
                    error.message
                );
                let provider = self.provider(&id, &session, true).await?;
                match Self::attempt(&provider, request).await {
                    Ok(result) => result,
                    Err(error) => Err(error),
                }
            }
        }
    }
}
