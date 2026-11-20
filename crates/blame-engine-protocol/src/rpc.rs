//! The client protocol: JSON-RPC 2.0, one message per line.
//!
//! Requests flow both ways. The client drives sessions ([`ClientRequest`]);
//! the engine asks the client for what only the client has
//! ([`EngineRequest`]: its tools, the user's approval, credentials). Records
//! and deltas reach subscribed clients as notifications
//! ([`EngineNotification`]).
//!
//! Nothing here depends on the transport: stdio for an engine started by the
//! desktop app (directly, or through `limactl shell` / `wsl.exe` when it runs
//! in the runtime VM), a WebSocket for an engine in the cloud.

use crate::content::{BlobRef, ToolResultBlock, UserBlock};
use crate::delta::{Delta, SessionActivity};
use crate::ids::{Seq, SessionId, ToolCallId, TurnId};
use crate::record::{
    ApprovalDecision, Delivery, ErrorKind, Record, SessionConfig, ToolOutcome, ToolSpec,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A JSON-RPC message as it appears on the wire. `M` is the set of methods the
/// sender may call or notify.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Message<M> {
    Request {
        jsonrpc: Version,
        id: u64,
        #[serde(flatten)]
        call: M,
    },
    Response {
        jsonrpc: Version,
        id: u64,
        #[serde(flatten)]
        outcome: Outcome,
    },
    Notification {
        jsonrpc: Version,
        #[serde(flatten)]
        call: M,
    },
}

/// The literal `"2.0"`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum Version {
    #[default]
    #[serde(rename = "2.0")]
    V2,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Result(Value),
    Error(RpcError),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RpcError {
    /// JSON-RPC code: -32600..-32603 for protocol faults, -32000 otherwise.
    pub code: i32,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<RpcErrorData>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RpcErrorData {
    pub kind: ErrorKind,
}

/// Sent by the client. Each variant documents the `result` it is answered
/// with.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "method", content = "params")]
pub enum ClientRequest {
    /// First message on a connection. Result: [`Initialized`].
    #[serde(rename = "initialize")]
    Initialize {
        protocol_version: u32,
        client_name: String,
        client_version: String,
        /// The client answers `host/log/*` and `host/blob/*`: sessions are
        /// then copied to Blame's database and can be reopened from it.
        #[serde(default)]
        remote_log: bool,
    },
    /// Result: [`SessionOpened`]. `session` lets the client choose the id.
    #[serde(rename = "session/create")]
    Create {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session: Option<SessionId>,
        config: SessionConfig,
    },
    /// Loads a stored session and finishes whatever a crash interrupted.
    /// Result: [`SessionOpened`].
    #[serde(rename = "session/open")]
    Open { session: SessionId },
    /// Result: [`SessionList`].
    #[serde(rename = "session/list")]
    List {},
    /// One page of stored records, without subscribing. Result: [`Records`].
    #[serde(rename = "session/read")]
    Read {
        session: SessionId,
        after: Seq,
        limit: u32,
    },
    /// From now on the client receives every record after `after`, then live
    /// deltas. Result: [`Subscribed`].
    #[serde(rename = "session/subscribe")]
    Subscribe { session: SessionId, after: Seq },
    /// Result: `null`.
    #[serde(rename = "session/unsubscribe")]
    Unsubscribe { session: SessionId },
    /// Result: [`MessageAccepted`]. `Delivery::Turn` while a turn runs queues
    /// the message as the next turn.
    #[serde(rename = "session/send")]
    Send {
        session: SessionId,
        input: Vec<UserBlock>,
        delivery: Delivery,
    },
    /// Stops the running turn; tool calls in flight are cancelled.
    /// Result: `null`.
    #[serde(rename = "session/interrupt")]
    Interrupt { session: SessionId },
    /// Makes `to` the last record in effect and, when asked, puts the
    /// workspace back as it was then. Result: [`Rewound`].
    #[serde(rename = "session/rewind")]
    Rewind {
        session: SessionId,
        to: Seq,
        restore_workspace: bool,
    },
    /// Cancels the rewind that is the session's latest record.
    /// Result: `null`.
    #[serde(rename = "session/undo_rewind")]
    UndoRewind { session: SessionId },
    /// A new session that shares this one's records up to `at`.
    /// Result: [`SessionOpened`].
    #[serde(rename = "session/fork")]
    Fork {
        session: SessionId,
        at: Seq,
        workspace_root: String,
    },
    /// Result: `null`.
    #[serde(rename = "session/compact")]
    Compact { session: SessionId },
    /// Result: `null`.
    #[serde(rename = "session/configure")]
    Configure {
        session: SessionId,
        config: SessionConfig,
    },
    /// Stops the session and frees its memory; its records stay stored.
    /// Result: `null`.
    #[serde(rename = "session/close")]
    Close { session: SessionId },
    /// Stops every session and exits. Result: `null`.
    #[serde(rename = "shutdown")]
    Shutdown {},
    /// Withdraws a request of this client that is still running.
    #[serde(rename = "$/cancel")]
    Cancel { id: u64 },
}

/// Sent by the engine to the client that owns the session's client tools.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "method", content = "params")]
pub enum EngineRequest {
    /// Run one of the session's `client_tools`. Result: [`ToolResult`].
    #[serde(rename = "host/tool")]
    Tool {
        session: SessionId,
        turn: TurnId,
        call: ToolCallId,
        name: String,
        input: Value,
    },
    /// Ask the user to allow a tool call. Result: [`Approval`].
    #[serde(rename = "host/approval")]
    Approval {
        session: SessionId,
        turn: TurnId,
        call: ToolCallId,
        tool: ToolSpec,
        input: Value,
    },
    /// Obtain the secret for a provider. The engine keeps it in memory only.
    /// Result: [`Credential`].
    #[serde(rename = "host/credential")]
    Credential { provider: String },
    /// Copy records into Blame's database, which the client can reach and the
    /// engine may not (it can run in a VM with no route to it). Records come
    /// in seq order; ones the database already holds are ignored. Only sent
    /// to a client that announced `remote_log`. Result: [`LogPushed`].
    #[serde(rename = "host/log/push")]
    LogPush {
        session: SessionId,
        records: Vec<Record>,
    },
    /// Records of a session the engine has never seen, or is behind on.
    /// Result: [`Records`].
    #[serde(rename = "host/log/pull")]
    LogPull { session: SessionId, after: Seq },
    /// Result: `null`.
    #[serde(rename = "host/blob/push")]
    BlobPush {
        blob: BlobRef,
        /// The bytes, base64-encoded.
        data: String,
    },
    /// Result: [`BlobPulled`].
    #[serde(rename = "host/blob/pull")]
    BlobPull { sha256: String },
    /// Withdraws a request of the engine that is still running.
    #[serde(rename = "$/cancel")]
    Cancel { id: u64 },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "method", content = "params")]
pub enum EngineNotification {
    #[serde(rename = "session/record")]
    Record { session: SessionId, record: Record },
    #[serde(rename = "session/delta")]
    Delta { session: SessionId, delta: Delta },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Initialized {
    pub protocol_version: u32,
    pub engine_version: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionOpened {
    pub session: SessionId,
    /// Seq of the session's latest record.
    pub head: Seq,
    pub activity: SessionActivity,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionSummary {
    pub session: SessionId,
    pub purpose: String,
    pub workspace_root: String,
    pub head: Seq,
    pub updated_at_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionList {
    pub sessions: Vec<SessionSummary>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Records {
    pub records: Vec<Record>,
    pub head: Seq,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogPushed {
    /// Highest seq the database now holds with no gap before it.
    pub acked: Seq,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlobPulled {
    /// The bytes, base64-encoded; absent when the database has no such blob.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Subscribed {
    pub head: Seq,
    pub activity: SessionActivity,
    /// Deltas of the reply being streamed right now, so a client that
    /// attaches mid-reply shows it from its first character.
    pub in_flight: Vec<Delta>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MessageAccepted {
    pub turn: TurnId,
    /// False when the message waits for the running turn to end.
    pub started: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rewound {
    /// Seq of the `RewindFinished` record.
    pub finished: Seq,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolResult {
    pub outcome: ToolOutcome,
    pub content: Vec<ToolResultBlock>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Approval {
    pub decision: ApprovalDecision,
}

/// How to authenticate to a provider.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Credential {
    ApiKey {
        key: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        base_url: Option<String>,
    },
    /// An OAuth access token the client obtained and keeps refreshed.
    Bearer {
        token: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        account: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        base_url: Option<String>,
    },
    /// The client has nothing for this provider.
    Missing,
}

impl std::fmt::Debug for Credential {
    // Secrets must never reach a log through a derived Debug.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::ApiKey { .. } => "Credential::ApiKey(…)",
            Self::Bearer { .. } => "Credential::Bearer(…)",
            Self::Missing => "Credential::Missing",
        })
    }
}
