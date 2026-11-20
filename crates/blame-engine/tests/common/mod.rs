//! A test client that drives the real engine binary over stdio, a fake
//! client side for what the engine asks (`host/*`), and Anthropic-shaped
//! replies for the mock model server.
#![allow(dead_code)]

use blame_engine_protocol::rpc::{
    ClientRequest, Credential, EngineNotification, EngineRequest, LogPushed, Message, Outcome,
    Records, RpcError, SessionOpened, ToolResult, Version,
};
use blame_engine_protocol::{
    Delivery, Delta, ModelRef, Record, RecordBody, Seq, SessionConfig, SessionId, ToolEffect,
    ToolOutcome, ToolResultBlock, ToolSpec, UserBlock,
};
use blame_engine_providers::testing::{Mock, Reply, sse};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot};

pub const MODEL: &str = "claude-sonnet-4-6";
pub const WAIT: Duration = Duration::from_secs(20);

/// A fresh directory under the target dir, unique to this test.
pub fn temp_dir(name: &str) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!(
        "{name}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp dir");
    dir
}

/// How the fake client runs one of its tools: name and input in, result out.
pub type ToolFn = dyn Fn(&str, &Value) -> ToolResult + Send + Sync;

/// What the fake client answers to the engine's requests.
pub struct FakeClient {
    pub base_url: Mutex<String>,
    /// Keys handed out, in order; the last one repeats.
    pub keys: Mutex<Vec<String>>,
    pub credential_requests: AtomicU64,
    pub tool: Box<ToolFn>,
    pub tool_calls: Mutex<Vec<(String, Value)>>,
    pub remote: Option<Arc<FakeRemote>>,
    /// Ids of the engine's requests it withdrew with `$/cancel`.
    pub cancelled: Mutex<Vec<u64>>,
    /// Holds `host/tool` answers until notified, when set.
    pub hold_tools: Option<Arc<tokio::sync::Notify>>,
    /// Reported as `tool/progress` while each tool call runs.
    pub progress: Mutex<Vec<String>>,
    /// (provider, session) of each `host/credential`.
    pub credential_asks: Mutex<Vec<(String, SessionId)>>,
    /// (session, method, params) of each `host/harness`.
    pub harness_asks: Mutex<Vec<(SessionId, String, Value)>>,
}

impl FakeClient {
    pub fn new(base_url: &str) -> Self {
        Self {
            base_url: Mutex::new(base_url.to_owned()),
            keys: Mutex::new(vec!["sk-ant-test".into()]),
            credential_requests: AtomicU64::new(0),
            tool: Box::new(|name, input| ToolResult {
                outcome: ToolOutcome::Completed,
                content: vec![ToolResultBlock::Text {
                    text: format!("{name} ran with {input}"),
                }],
            }),
            tool_calls: Mutex::new(Vec::new()),
            remote: None,
            cancelled: Mutex::new(Vec::new()),
            hold_tools: None,
            progress: Mutex::new(Vec::new()),
            credential_asks: Mutex::new(Vec::new()),
            harness_asks: Mutex::new(Vec::new()),
        }
    }

    pub fn with_remote(mut self, remote: Arc<FakeRemote>) -> Self {
        self.remote = Some(remote);
        self
    }

    async fn answer(&self, call: EngineRequest) -> Result<Value, RpcError> {
        match call {
            EngineRequest::Credential { provider, session } => {
                self.credential_asks
                    .lock()
                    .unwrap()
                    .push((provider, session));
                let n = self.credential_requests.fetch_add(1, Ordering::SeqCst) as usize;
                let keys = self.keys.lock().unwrap();
                let key = keys.get(n).or(keys.last()).cloned().unwrap_or_default();
                Ok(serde_json::to_value(Credential::ApiKey {
                    key,
                    base_url: Some(self.base_url.lock().unwrap().clone()),
                })
                .unwrap())
            }
            EngineRequest::Tool { name, input, .. } => {
                self.tool_calls
                    .lock()
                    .unwrap()
                    .push((name.clone(), input.clone()));
                if let Some(hold) = &self.hold_tools {
                    hold.notified().await;
                }
                Ok(serde_json::to_value((self.tool)(&name, &input)).unwrap())
            }
            EngineRequest::Approval { .. } => Ok(json!({ "decision": "approved" })),
            // A command's credentials, as the app grants them.
            EngineRequest::Harness {
                session,
                method,
                params,
            } => {
                let answer = if method == "commandCredentials" {
                    json!({ "githubToken": "granted-by-the-client" })
                } else {
                    Value::Null
                };
                self.harness_asks
                    .lock()
                    .unwrap()
                    .push((session, method, params));
                Ok(answer)
            }
            EngineRequest::LogPush { session, records } => {
                let remote = self.remote.as_ref().ok_or_else(|| rpc("no remote"))?;
                remote
                    .push(&session, records)
                    .map(|acked| json!(LogPushed { acked }))
            }
            EngineRequest::LogPull { session, after } => {
                let remote = self.remote.as_ref().ok_or_else(|| rpc("no remote"))?;
                let records = remote.pull(&session, after);
                let head = records.last().map_or(after, |r| r.seq);
                Ok(serde_json::to_value(Records { records, head }).unwrap())
            }
            EngineRequest::BlobPush { blob, data } => {
                let remote = self.remote.as_ref().ok_or_else(|| rpc("no remote"))?;
                remote.blobs.lock().unwrap().insert(blob.sha256, data);
                Ok(Value::Null)
            }
            EngineRequest::BlobPull { sha256 } => {
                let remote = self.remote.as_ref().ok_or_else(|| rpc("no remote"))?;
                let data = remote.blobs.lock().unwrap().get(&sha256).cloned();
                Ok(json!({ "data": data }))
            }
            EngineRequest::Cancel { id } => {
                self.cancelled.lock().unwrap().push(id);
                Ok(Value::Null)
            }
        }
    }
}

fn rpc(message: &str) -> RpcError {
    RpcError {
        code: -32000,
        message: message.into(),
        data: None,
    }
}

/// Blame's database as the API keeps it: records by (session, seq),
/// idempotent, contiguous.
#[derive(Default)]
pub struct FakeRemote {
    pub logs: Mutex<HashMap<SessionId, Vec<Record>>>,
    pub blobs: Mutex<HashMap<String, String>>,
}

impl FakeRemote {
    fn push(&self, session: &SessionId, records: Vec<Record>) -> Result<Seq, RpcError> {
        let mut logs = self.logs.lock().unwrap();
        let log = logs.entry(session.clone()).or_default();
        for record in records {
            let held = log.len() as u64;
            if record.seq <= held {
                if log[record.seq as usize - 1] != record {
                    return Err(rpc("conflict"));
                }
                continue;
            }
            if record.seq != held + 1 {
                return Err(rpc("gap"));
            }
            log.push(record);
        }
        Ok(log.len() as u64)
    }

    fn pull(&self, session: &SessionId, after: Seq) -> Vec<Record> {
        self.logs
            .lock()
            .unwrap()
            .get(session)
            .map(|log| log.iter().filter(|r| r.seq > after).cloned().collect())
            .unwrap_or_default()
    }

    pub fn head(&self, session: &SessionId) -> Seq {
        self.logs
            .lock()
            .unwrap()
            .get(session)
            .map_or(0, |log| log.len() as u64)
    }
}

/// The engine process, spoken to like the desktop app does.
pub struct Engine {
    child: Child,
    stdin: Arc<tokio::sync::Mutex<Option<ChildStdin>>>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Outcome>>>>,
    notifications: tokio::sync::Mutex<mpsc::UnboundedReceiver<EngineNotification>>,
    next_id: AtomicU64,
    pub data_dir: PathBuf,
    /// What the engine wrote to stderr so far.
    pub logs: Arc<Mutex<Vec<String>>>,
}

pub fn binary() -> &'static str {
    env!("CARGO_BIN_EXE_blame-engine")
}

impl Engine {
    pub async fn start(data_dir: &Path, extra: &[&str], client: Arc<FakeClient>) -> Self {
        let mut child = Command::new(binary())
            .arg("serve")
            .arg("--data-dir")
            .arg(data_dir)
            // No test reaches models.dev; one that wants a catalog server
            // passes its own `--catalog-url`, which comes later and wins.
            .args(["--catalog-url", "http://127.0.0.1:9/api.json"])
            .args(extra)
            // Fast enough for tests; durability itself is the store's test.
            .args(["--durability", "relaxed"])
            .env("BLAME_ENGINE_LOG", "debug")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .expect("the engine starts");
        let logs: Arc<Mutex<Vec<String>>> = Arc::default();
        {
            // Shown as the test's own output, and kept for assertions.
            let logs = logs.clone();
            let stderr = child.stderr.take().unwrap();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    eprintln!("{line}");
                    logs.lock().unwrap().push(line);
                }
            });
        }
        let stdin = Arc::new(tokio::sync::Mutex::new(child.stdin.take()));
        let stdout = child.stdout.take().unwrap();
        let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Outcome>>>> = Arc::default();
        let (notify, notifications) = mpsc::unbounded_channel();
        {
            let pending = pending.clone();
            let stdin = stdin.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let value: Value = serde_json::from_str(&line).unwrap_or_else(|e| {
                        panic!("the engine wrote a line that is not JSON ({e}): {line}")
                    });
                    if value.get("method").is_some() {
                        if value.get("id").is_some() {
                            let Ok(Message::Request { id, call, .. }) =
                                serde_json::from_value::<Message<EngineRequest>>(value.clone())
                            else {
                                panic!("unreadable engine request: {value}");
                            };
                            let client = client.clone();
                            let stdin = stdin.clone();
                            tokio::spawn(async move {
                                if let EngineRequest::Tool { call: running, .. } = &call {
                                    let progress = client.progress.lock().unwrap().clone();
                                    for text in progress {
                                        let message: Message<ClientRequest> =
                                            Message::Notification {
                                                jsonrpc: Version::V2,
                                                call: ClientRequest::ToolProgress {
                                                    call: running.clone(),
                                                    text,
                                                },
                                            };
                                        write(&stdin, &serde_json::to_string(&message).unwrap())
                                            .await;
                                    }
                                }
                                let outcome = match client.answer(call).await {
                                    Ok(value) => Outcome::Result(value),
                                    Err(error) => Outcome::Error(error),
                                };
                                let message: Message<ClientRequest> = Message::Response {
                                    jsonrpc: Version::V2,
                                    id,
                                    outcome,
                                };
                                write(&stdin, &serde_json::to_string(&message).unwrap()).await;
                            });
                        } else if value["method"] == "$/cancel" {
                            let id = value["params"]["id"].as_u64().unwrap();
                            client.cancelled.lock().unwrap().push(id);
                        } else {
                            let message: Message<EngineNotification> =
                                serde_json::from_value(value.clone()).unwrap_or_else(|e| {
                                    panic!("unreadable notification ({e}): {value}")
                                });
                            if let Message::Notification { call, .. } = message {
                                let _ = notify.send(call);
                            }
                        }
                    } else {
                        let Ok(Message::Response { id, outcome, .. }) =
                            serde_json::from_value::<Message<EngineRequest>>(value.clone())
                        else {
                            panic!("unreadable response: {value}");
                        };
                        if let Some(reply) = pending.lock().unwrap().remove(&id) {
                            let _ = reply.send(outcome);
                        }
                    }
                }
            });
        }
        Self {
            child,
            stdin,
            pending,
            notifications: tokio::sync::Mutex::new(notifications),
            next_id: AtomicU64::new(1),
            data_dir: data_dir.to_owned(),
            logs,
        }
    }

    /// Started and initialized.
    pub async fn ready(data_dir: &Path, extra: &[&str], client: Arc<FakeClient>) -> Self {
        let remote_log = client.remote.is_some();
        let engine = Self::start(data_dir, extra, client).await;
        engine.initialize(remote_log).await;
        engine
    }

    pub async fn initialize(&self, remote_log: bool) {
        let _: Value = self
            .call(ClientRequest::Initialize {
                protocol_version: blame_engine_protocol::PROTOCOL_VERSION,
                client_name: "test".into(),
                client_version: "0".into(),
                remote_log,
            })
            .await;
    }

    pub async fn request<T: DeserializeOwned>(&self, call: ClientRequest) -> Result<T, RpcError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (reply, answer) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, reply);
        let message: Message<ClientRequest> = Message::Request {
            jsonrpc: Version::V2,
            id,
            call,
        };
        write(&self.stdin, &serde_json::to_string(&message).unwrap()).await;
        let outcome = tokio::time::timeout(WAIT, answer)
            .await
            .expect("the engine answers in time")
            .expect("the engine answers");
        match outcome {
            Outcome::Result(value) => Ok(serde_json::from_value(value).expect("a readable result")),
            Outcome::Error(error) => Err(error),
        }
    }

    /// Sends a request and returns its id and the answer to come, without
    /// waiting for it (a `task/run`).
    pub async fn send_request(&self, call: ClientRequest) -> (u64, oneshot::Receiver<Outcome>) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (reply, answer) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, reply);
        let message: Message<ClientRequest> = Message::Request {
            jsonrpc: Version::V2,
            id,
            call,
        };
        write(&self.stdin, &serde_json::to_string(&message).unwrap()).await;
        (id, answer)
    }

    /// The answer of a request sent with [`Self::send_request`].
    pub async fn answer<T: DeserializeOwned>(
        answer: oneshot::Receiver<Outcome>,
    ) -> Result<T, RpcError> {
        let outcome = tokio::time::timeout(WAIT, answer)
            .await
            .expect("the engine answers in time")
            .expect("the engine answers");
        match outcome {
            Outcome::Result(value) => Ok(serde_json::from_value(value).expect("a readable result")),
            Outcome::Error(error) => Err(error),
        }
    }

    /// `$/cancel` of a request of this client.
    pub async fn cancel(&self, id: u64) {
        let message: Message<ClientRequest> = Message::Notification {
            jsonrpc: Version::V2,
            call: ClientRequest::Cancel { id },
        };
        write(&self.stdin, &serde_json::to_string(&message).unwrap()).await;
    }

    pub async fn call<T: DeserializeOwned>(&self, call: ClientRequest) -> T {
        let name = format!("{call:?}");
        self.request(call)
            .await
            .unwrap_or_else(|error| panic!("{name} failed: {error:?}"))
    }

    pub async fn create(&self, config: SessionConfig) -> SessionId {
        let opened: SessionOpened = self
            .call(ClientRequest::Create {
                session: None,
                config,
            })
            .await;
        opened.session
    }

    pub async fn send(&self, session: &SessionId, text: &str) {
        let _: Value = self
            .call(ClientRequest::Send {
                session: session.clone(),
                input: vec![UserBlock::Text { text: text.into() }],
                delivery: Delivery::Turn,
            })
            .await;
    }

    pub async fn subscribe(&self, session: &SessionId, after: Seq) {
        let _: Value = self
            .call(ClientRequest::Subscribe {
                session: session.clone(),
                after,
            })
            .await;
    }

    /// Every stored record, read page by page.
    pub async fn records(&self, session: &SessionId) -> Vec<Record> {
        let mut records = Vec::new();
        loop {
            let page: Records = self
                .call(ClientRequest::Read {
                    session: session.clone(),
                    after: records.last().map_or(0, |r: &Record| r.seq),
                    limit: 1000,
                })
                .await;
            if page.records.is_empty() {
                return records;
            }
            records.extend(page.records);
        }
    }

    pub async fn next_notification(&self) -> EngineNotification {
        tokio::time::timeout(WAIT, self.notifications.lock().await.recv())
            .await
            .expect("a notification in time")
            .expect("the engine is running")
    }

    /// Notifications until a record matches `until`, that record included.
    pub async fn until_record(
        &self,
        mut until: impl FnMut(&Record) -> bool,
    ) -> Vec<EngineNotification> {
        let mut seen = Vec::new();
        loop {
            let notification = self.next_notification().await;
            let done =
                matches!(&notification, EngineNotification::Record { record, .. } if until(record));
            seen.push(notification);
            if done {
                return seen;
            }
        }
    }

    pub async fn until_turn_ended(&self) -> Vec<EngineNotification> {
        self.until_record(|r| matches!(r.body, RecordBody::TurnEnded { .. }))
            .await
    }

    /// `kill -9`.
    pub async fn kill(mut self) {
        self.child.start_kill().expect("kill");
        let _ = self.child.wait().await;
    }

    pub async fn close_stdin(&self) {
        self.stdin.lock().await.take();
    }

    pub async fn wait_exit(mut self) -> ExitStatus {
        tokio::time::timeout(WAIT, self.child.wait())
            .await
            .expect("the engine exits in time")
            .expect("exit status")
    }

    pub async fn shutdown(self) -> ExitStatus {
        let _: Value = self.call(ClientRequest::Shutdown {}).await;
        self.wait_exit().await
    }

    pub fn logged(&self, text: &str) -> bool {
        self.logs
            .lock()
            .unwrap()
            .iter()
            .any(|line| line.contains(text))
    }

    pub fn pid(&self) -> u32 {
        self.child.id().expect("running")
    }
}

async fn write(stdin: &tokio::sync::Mutex<Option<ChildStdin>>, line: &str) {
    let mut stdin = stdin.lock().await;
    if let Some(stdin) = stdin.as_mut() {
        let _ = stdin.write_all(format!("{line}\n").as_bytes()).await;
        let _ = stdin.flush().await;
    }
}

pub fn records_of(notifications: &[EngineNotification]) -> Vec<Record> {
    notifications
        .iter()
        .filter_map(|n| match n {
            EngineNotification::Record { record, .. } => Some(record.clone()),
            _ => None,
        })
        .collect()
}

pub fn deltas_of(notifications: &[EngineNotification]) -> Vec<Delta> {
    notifications
        .iter()
        .filter_map(|n| match n {
            EngineNotification::Delta { delta, .. } => Some(delta.clone()),
            _ => None,
        })
        .collect()
}

pub fn kind(body: &RecordBody) -> &'static str {
    match body {
        RecordBody::SessionCreated { .. } => "created",
        RecordBody::ConfigChanged { .. } => "config",
        RecordBody::UserMessage {
            delivery: Delivery::Turn,
            ..
        } => "user",
        RecordBody::UserMessage { .. } => "steer",
        RecordBody::CheckpointCreated { .. } => "checkpoint",
        RecordBody::TurnEnded { .. } => "ended",
        RecordBody::RequestStarted { .. } => "request",
        RecordBody::AssistantMessage { .. } => "reply",
        RecordBody::RequestFailed { .. } => "failed",
        RecordBody::ApprovalRequested { .. } => "approval?",
        RecordBody::ApprovalResolved { .. } => "approval",
        RecordBody::ToolCallStarted { .. } => "tool",
        RecordBody::ToolCallFinished { .. } => "result",
        RecordBody::ContextCompacted { .. } => "compacted",
        RecordBody::ContextEdited { .. } => "edited",
        RecordBody::RewindStarted { .. } => "rewind",
        RecordBody::RewindFinished { .. } => "rewound",
        RecordBody::RewindUndone { .. } => "undone",
        RecordBody::Notice { .. } => "notice",
        RecordBody::ResultAccepted { .. } => "accepted",
        RecordBody::ResultRejected { .. } => "rejected",
        RecordBody::ContractCorrection { .. } => "correction",
        RecordBody::TurnContinued { .. } => "continued",
    }
}

pub fn kinds(records: &[Record]) -> Vec<&'static str> {
    records.iter().map(|r| kind(&r.body)).collect()
}

pub fn config(workspace: &Path) -> SessionConfig {
    SessionConfig {
        purpose: "development".into(),
        workspace_root: workspace.display().to_string(),
        model: ModelRef {
            provider: "anthropic".into(),
            model: MODEL.into(),
        },
        reasoning: None,
        system_prompt: "You are a test agent.".into(),
        max_output_tokens: Some(1000),
        engine_tools: Vec::new(),
        client_tools: vec![ToolSpec {
            name: "preview".into(),
            description: "Shows the app.".into(),
            input_schema: json!({"type": "object", "properties": {"path": {"type": "string"}}}),
            effect: ToolEffect::ReadOnly,
            ends_turn: false,
            needs_approval: false,
        }],
        tool_options: Default::default(),
        limits: Default::default(),
        checkpoints: false,
        kind: Default::default(),
        contract: None,
    }
}

fn start(id: &str) -> (&'static str, Value) {
    (
        "message_start",
        json!({"type": "message_start", "message": {
            "id": id, "type": "message", "role": "assistant", "model": MODEL,
            "content": [], "stop_reason": null, "stop_sequence": null,
            "usage": {"input_tokens": 10, "output_tokens": 1}}}),
    )
}

fn end(stop: &str) -> Vec<(&'static str, Value)> {
    vec![
        (
            "message_delta",
            json!({"type": "message_delta", "delta": {"stop_reason": stop, "stop_sequence": null},
                   "usage": {"output_tokens": 5}}),
        ),
        ("message_stop", json!({"type": "message_stop"})),
    ]
}

/// A streamed text reply, in pieces.
pub fn text_reply(pieces: &[&str]) -> Reply {
    Reply::sse(&text_sse(pieces))
}

pub fn text_sse(pieces: &[&str]) -> String {
    let mut events = vec![
        start("msg_text"),
        (
            "content_block_start",
            json!({"type": "content_block_start", "index": 0,
                   "content_block": {"type": "text", "text": ""}}),
        ),
    ];
    for piece in pieces {
        events.push((
            "content_block_delta",
            json!({"type": "content_block_delta", "index": 0,
                   "delta": {"type": "text_delta", "text": piece}}),
        ));
    }
    events.push((
        "content_block_stop",
        json!({"type": "content_block_stop", "index": 0}),
    ));
    events.extend(end("end_turn"));
    sse(&events)
}

/// A reply calling `calls` (name, input), each in its own block.
pub fn tool_reply(calls: &[(&str, Value)]) -> Reply {
    let mut events = vec![start("msg_tool")];
    for (index, (name, input)) in calls.iter().enumerate() {
        events.push((
            "content_block_start",
            json!({"type": "content_block_start", "index": index,
                   "content_block": {"type": "tool_use", "id": format!("toolu_{index}"), "name": name, "input": {}}}),
        ));
        events.push((
            "content_block_delta",
            json!({"type": "content_block_delta", "index": index,
                   "delta": {"type": "input_json_delta", "partial_json": input.to_string()}}),
        ));
        events.push((
            "content_block_stop",
            json!({"type": "content_block_stop", "index": index}),
        ));
    }
    events.extend(end("tool_use"));
    Reply::sse(&sse(&events))
}

/// The beginning of a reply, then silence with the connection open: a turn
/// that stays in flight for as long as the test needs.
pub fn stalled_reply() -> Reply {
    let full = text_sse(&["Working on it"]);
    let cut = full.find("event: content_block_stop").unwrap_or(full.len());
    Reply {
        status: 200,
        headers: vec![("content-type".into(), "text/event-stream".into())],
        body: blame_engine_providers::testing::Body::Stall(full[..cut].to_owned()),
    }
}

pub async fn mock(replies: Vec<Reply>) -> Mock {
    Mock::start(replies).await
}

/// The `messages` array of each request the model server received.
pub fn sent_messages(mock: &Mock) -> Vec<Value> {
    mock.requests()
        .into_iter()
        .map(|r| r.body["messages"].clone())
        .collect()
}
