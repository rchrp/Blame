//! Blame's workspace harness (`blame-harness`, crates/blame-harness), run as
//! one long-lived child process for every session of the engine.
//!
//! The harness (`blame-harness serve --asks`) speaks JSON lines: it says
//! `{"ready": true}` once, then answers each `{"id", ...}` message by id.
//! The engine uses two of its messages: `describe` gives the model-facing
//! tools, `call` runs one model call and answers with the result as the
//! model reads it. A `{"id", "cancel": true}` aborts a call. What only the
//! client knows the harness asks (`{"ask": ...}`), and the engine relays the
//! question to the client as `host/harness` and writes back its answer.
//!
//! The harness keeps per-workspace state (indexes, managed runs) between
//! calls, which is why it stays alive. If it dies it is started again on the
//! next call; calls it was running end as interrupted.

use crate::log::log;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use blame_engine_core::ports::{InterruptedCall, SessionStore, ToolInvocation, ToolOutput};
use blame_engine_protocol::{
    RecordBody, Refusal, ToolEffect, ToolOutcome, ToolResultBlock, ToolSpec,
};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

/// Node starts, loads the harness and its parsers: seconds on a cold disk.
const READY_TIMEOUT: Duration = Duration::from_secs(60);
/// How long a cancelled call may take to confirm before it is left behind.
const CANCEL_GRACE: Duration = Duration::from_secs(2);
const STOP_GRACE: Duration = Duration::from_secs(3);

/// The program and its arguments, run as given (no shell).
#[derive(Clone, Debug)]
pub struct HarnessCommand {
    pub program: String,
    pub args: Vec<String>,
}

impl HarnessCommand {
    /// `--harness-command` takes a JSON array (`["node", "/path/runner.js",
    /// "--serve"]`) or a single program path, which may contain spaces.
    pub fn parse(value: &str) -> Result<Self, String> {
        if value.trim_start().starts_with('[') {
            let parts: Vec<String> = serde_json::from_str(value).map_err(|error| {
                format!("--harness-command is not a JSON array of strings: {error}")
            })?;
            let (program, args) = parts
                .split_first()
                .ok_or("--harness-command is an empty array")?;
            return Ok(Self {
                program: program.clone(),
                args: args.to_vec(),
            });
        }
        Ok(Self {
            program: value.to_owned(),
            args: Vec::new(),
        })
    }
}

#[derive(Debug, thiserror::Error)]
pub enum HarnessError {
    #[error("the harness could not start: {0}")]
    Start(String),
    #[error("the harness stopped")]
    Stopped,
    #[error("cancelled")]
    Cancelled,
    #[error("{0}")]
    Refused(String),
}

pub struct Harness {
    command: HarnessCommand,
    /// Where the harness's questions go (`host/harness`): the client.
    host: std::sync::OnceLock<Arc<crate::connection::Host>>,
    process: tokio::sync::Mutex<Option<Arc<Process>>>,
    /// Tools per describe request: they depend only on the task contract,
    /// the response style and the tools kept.
    described: Mutex<HashMap<String, Vec<ToolSpec>>>,
    next_id: AtomicU64,
    stopped: AtomicBool,
}

struct Process {
    stdin: Arc<tokio::sync::Mutex<Option<ChildStdin>>>,
    child: tokio::sync::Mutex<Child>,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>,
    dead: CancellationToken,
}

impl Harness {
    pub fn new(command: HarnessCommand) -> Self {
        Self {
            command,
            host: std::sync::OnceLock::new(),
            process: tokio::sync::Mutex::new(None),
            described: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            stopped: AtomicBool::new(false),
        }
    }

    /// The client the harness's questions are relayed to.
    pub fn attach_host(&self, host: Arc<crate::connection::Host>) {
        let _ = self.host.set(host);
    }

    /// The tools the harness offers under `options` (`tool_options.harness`).
    /// `tools`, when given, keeps only those: an orchestrator only reads, so
    /// it must never be offered (or able to call) edit_code or run_task.
    pub async fn describe(&self, options: &Value) -> Result<Vec<ToolSpec>, HarnessError> {
        let describe = json!({
            "taskContract": options.get("taskContract"),
            "responseStyle": options.get("responseStyle"),
            "tools": options.get("tools"),
        });
        let key = describe.to_string();
        if let Some(specs) = self.cache().get(&key) {
            return Ok(specs.clone());
        }
        let reply = self
            .request(json!({ "describe": describe }), &CancellationToken::new())
            .await?;
        let tools = reply
            .get("tools")
            .and_then(Value::as_array)
            .ok_or_else(|| HarnessError::Refused(error_text(&reply)))?;
        let specs = tools
            .iter()
            .map(spec)
            .collect::<Result<Vec<_>, _>>()
            .map_err(HarnessError::Refused)?;
        self.cache().insert(key, specs.clone());
        Ok(specs)
    }

    /// Whether the harness needs the person's approval before this call
    /// runs: a command it would refuse only because it changes git.
    pub async fn needs_approval(&self, name: &str, input: &Value, options: &Value) -> bool {
        let request = json!({
            "approval": {
                "tool": name,
                "input": input,
                "taskContract": options.get("taskContract"),
            }
        });
        match self.request(request, &CancellationToken::new()).await {
            Ok(reply) => reply.get("needed").and_then(Value::as_bool) == Some(true),
            Err(error) => {
                log!(
                    Warn,
                    "the harness could not say whether a call needs approval: {error}"
                );
                false
            }
        }
    }

    pub async fn call(
        &self,
        invocation: &ToolInvocation,
        options: &Value,
        store: &dyn SessionStore,
        cancel: CancellationToken,
    ) -> ToolOutput {
        let mut call = json!({
            "tool": invocation.name,
            "input": invocation.input,
            "workspaceRoot": invocation.workspace_root,
            "taskContract": options.get("taskContract"),
            "toolContext": {
                "sessionId": invocation.session,
                "conversationId": invocation.session,
                "toolCallId": invocation.call,
                "metadata": { "contextGeneration": context_generation(invocation) },
                // The person approved this very call (a chat's git command).
                "approved": invocation.approved,
            },
        });
        // finish_task shows only screenshots this conversation took: the ones
        // its tool results named (`screenshot:<id>`).
        if invocation.name == "finish_task" {
            call["knownScreenshots"] = json!(known_screenshots(invocation, store).await);
        }
        let reply = match self.request(json!({ "call": call }), &cancel).await {
            Ok(reply) => reply,
            Err(HarnessError::Cancelled) => {
                return ToolOutput::text(
                    ToolOutcome::Cancelled,
                    "Cancelled: the user interrupted the turn.",
                );
            }
            Err(HarnessError::Stopped) => {
                return ToolOutput::text(
                    ToolOutcome::Interrupted,
                    "The workspace harness stopped while this tool was running, so whether it \
took effect is unknown. Check before relying on it or running it again.",
                );
            }
            Err(error) => return ToolOutput::text(ToolOutcome::Failed, error.to_string()),
        };
        let Some(presented) = reply.get("presented") else {
            return ToolOutput::text(ToolOutcome::Failed, error_text(&reply));
        };
        let outcome = if presented.get("ok").and_then(Value::as_bool) == Some(true) {
            ToolOutcome::Completed
        } else {
            ToolOutcome::Failed
        };
        ToolOutput {
            outcome,
            content: blocks(presented.get("content"), store).await,
            refusal: refusal(presented.get("refusal")),
        }
    }

    /// Stops the runner: its input closes (it stops what it runs and exits),
    /// and it is killed if it is still there after a grace period.
    pub async fn stop(&self) {
        self.stopped.store(true, Ordering::Relaxed);
        let Some(process) = self.process.lock().await.take() else {
            return;
        };
        process.stdin.lock().await.take();
        let mut child = process.child.lock().await;
        if tokio::time::timeout(STOP_GRACE, child.wait())
            .await
            .is_err()
        {
            log!(Warn, "the harness did not exit; killing it");
            let _ = child.kill().await;
        }
    }

    fn cache(&self) -> std::sync::MutexGuard<'_, HashMap<String, Vec<ToolSpec>>> {
        self.described
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    async fn request(
        &self,
        mut message: Value,
        cancel: &CancellationToken,
    ) -> Result<Value, HarnessError> {
        let process = self.running().await?;
        let id = format!("e{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        message["id"] = Value::String(id.clone());
        let (reply, answer) = oneshot::channel();
        lock(&process.pending).insert(id.clone(), reply);
        if process.write(&message).await.is_err() {
            lock(&process.pending).remove(&id);
            return Err(HarnessError::Stopped);
        }
        let mut answer = std::pin::pin!(answer);
        tokio::select! {
            reply = &mut answer => reply.map_err(|_| HarnessError::Stopped),
            () = cancel.cancelled() => {
                let _ = process.write(&json!({ "id": id, "cancel": true })).await;
                // Let the runner confirm, so a run it aborts is not still
                // writing when the next call starts; do not wait for ever.
                let _ = tokio::time::timeout(CANCEL_GRACE, answer).await;
                lock(&process.pending).remove(&id);
                Err(HarnessError::Cancelled)
            }
        }
    }

    /// The runner, started if it is not running.
    async fn running(&self) -> Result<Arc<Process>, HarnessError> {
        let mut slot = self.process.lock().await;
        if let Some(process) = slot.as_ref() {
            if !process.dead.is_cancelled() {
                return Ok(process.clone());
            }
            log!(Warn, "the harness had stopped; starting it again");
        }
        if self.stopped.load(Ordering::Relaxed) {
            return Err(HarnessError::Stopped);
        }
        let process = Arc::new(self.start().await?);
        *slot = Some(process.clone());
        Ok(process)
    }

    async fn start(&self) -> Result<Process, HarnessError> {
        log!(Info, "starting the harness: {:?}", self.command);
        let mut child = Command::new(&self.command.program)
            .args(&self.command.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Its logs join the engine's, on stderr.
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| HarnessError::Start(format!("{:?}: {error}", self.command.program)))?;
        let stdin = Arc::new(tokio::sync::Mutex::new(Some(
            child.stdin.take().expect("piped"),
        )));
        let stdout = child.stdout.take().expect("piped");
        let pending: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>> = Arc::default();
        let dead = CancellationToken::new();
        let (ready, is_ready) = oneshot::channel::<()>();
        {
            let pending = pending.clone();
            let dead = dead.clone();
            let host = self.host.get().cloned();
            let answers = stdin.clone();
            tokio::spawn(async move {
                let mut ready = Some(ready);
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let Ok(message) = serde_json::from_str::<Value>(&line) else {
                        log!(Warn, "the harness wrote a line that is not JSON");
                        continue;
                    };
                    if let Some(ask) = message.get("ask") {
                        tokio::spawn(answer(host.clone(), answers.clone(), ask.clone()));
                        continue;
                    }
                    if message.get("ready").is_some() {
                        if let Some(ready) = ready.take() {
                            let _ = ready.send(());
                        }
                        continue;
                    }
                    let id = message.get("id").and_then(Value::as_str).map(str::to_owned);
                    if let Some(reply) = id.and_then(|id| lock(&pending).remove(&id)) {
                        let _ = reply.send(message);
                    }
                }
                log!(Debug, "the harness's output closed");
                dead.cancel();
                // Every waiting call learns that its answer will not come.
                lock(&pending).clear();
            });
        }
        match tokio::time::timeout(READY_TIMEOUT, is_ready).await {
            Ok(Ok(())) => {}
            Ok(Err(_)) => return Err(HarnessError::Start("it exited before it was ready".into())),
            Err(_) => {
                let _ = child.kill().await;
                return Err(HarnessError::Start("it did not get ready in time".into()));
            }
        }
        Ok(Process {
            stdin,
            child: tokio::sync::Mutex::new(child),
            pending,
            dead,
        })
    }
}

impl Process {
    async fn write(&self, message: &Value) -> std::io::Result<()> {
        let mut stdin = self.stdin.lock().await;
        let stdin = stdin
            .as_mut()
            .ok_or_else(|| std::io::Error::other("the harness is stopping"))?;
        let mut line = message.to_string();
        line.push('\n');
        stdin.write_all(line.as_bytes()).await?;
        stdin.flush().await
    }
}

/// Relays one question of the harness to the client (`host/harness`) and
/// writes its answer back; with no client, or on an error, the answer is an
/// error, which the harness takes as no answer.
async fn answer(
    host: Option<Arc<crate::connection::Host>>,
    stdin: Arc<tokio::sync::Mutex<Option<ChildStdin>>>,
    ask: Value,
) {
    let id = ask.get("id").cloned().unwrap_or(Value::Null);
    let params = ask.get("params").cloned().unwrap_or(Value::Null);
    let session = params
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let method = ask
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let reply = match host {
        Some(host) => host
            .request::<Value>(blame_engine_protocol::rpc::EngineRequest::Harness {
                session: blame_engine_protocol::SessionId(session),
                method,
                params,
            })
            .await
            .map_err(|error| error.to_string()),
        None => Err("no client".to_owned()),
    };
    let answer = match reply {
        Ok(result) => json!({ "answer": { "id": id, "result": result } }),
        Err(error) => json!({ "answer": { "id": id, "error": error } }),
    };
    let mut line = answer.to_string();
    line.push('\n');
    if let Some(stdin) = stdin.lock().await.as_mut() {
        let _ = stdin.write_all(line.as_bytes()).await;
        let _ = stdin.flush().await;
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn error_text(reply: &Value) -> String {
    reply.get("error").and_then(Value::as_str).map_or_else(
        || format!("unexpected harness reply: {reply}"),
        str::to_owned,
    )
}

/// A described tool as the engine offers it.
fn spec(tool: &Value) -> Result<ToolSpec, String> {
    let text = |name: &str| {
        tool.get(name)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| format!("a described tool has no {name}: {tool}"))
    };
    let effect = match tool.get("effect").and_then(Value::as_str) {
        Some("read_only") => ToolEffect::ReadOnly,
        Some("workspace_write") => ToolEffect::WorkspaceWrite,
        Some("external") => ToolEffect::External,
        _ => ToolEffect::Command,
    };
    Ok(ToolSpec {
        name: text("name")?,
        description: text("description")?,
        input_schema: tool.get("inputSchema").cloned().unwrap_or(Value::Null),
        effect,
        ends_turn: tool.get("endsTurn").and_then(Value::as_bool) == Some(true),
        needs_approval: false,
    })
}

/// The harness keys what it knows the model has read (and so answers
/// "already in context") on `toolContext.metadata.contextGeneration`
/// (`contextGeneration` in `light-read-results.ts`). A compaction replaces
/// those reads by a summary, so each compaction starts a new generation.
fn context_generation(invocation: &ToolInvocation) -> String {
    match invocation.compacted_through {
        Some(through) => format!("compaction:{through}"),
        None => "initial".into(),
    }
}

/// What a call of the harness tool `name` that a crash cut short did.
pub fn interrupted(name: &str) -> InterruptedCall {
    match name {
        // Reads change nothing: running them again is safe.
        "search_code" | "read_code" => InterruptedCall::NotApplied,
        _ => InterruptedCall::Unknown,
    }
}

/// A refused finish's reason, as the harness types it.
fn refusal(value: Option<&Value>) -> Option<Refusal> {
    let value = value?;
    match value.get("kind").and_then(Value::as_str) {
        Some("failing_checks") => Some(Refusal::FailingChecks {
            tasks: value
                .get("tasks")?
                .as_array()?
                .iter()
                .filter_map(|task| task.as_str().map(str::to_owned))
                .collect(),
        }),
        _ => None,
    }
}

/// The screenshot ids the session's tool results named, as
/// `screenshot:<64 hex>`, oldest first.
async fn known_screenshots(invocation: &ToolInvocation, store: &dyn SessionStore) -> Vec<String> {
    let records = store
        .read(&invocation.session, 0, None)
        .await
        .unwrap_or_default();
    let mut ids: Vec<String> = Vec::new();
    for record in records {
        let RecordBody::ToolCallFinished { content, .. } = record.body else {
            continue;
        };
        for block in content {
            if let ToolResultBlock::Text { text } = block {
                for id in screenshot_references(&text) {
                    if !ids.contains(&id) {
                        ids.push(id);
                    }
                }
            }
        }
    }
    ids
}

/// The ids of every `screenshot:<64 lowercase hex>` in a text.
fn screenshot_references(text: &str) -> Vec<String> {
    let mut ids = Vec::new();
    let mut rest = text;
    while let Some(at) = rest.find("screenshot:") {
        let candidate = &rest[at + "screenshot:".len()..];
        let id: String = candidate.chars().take(64).collect();
        let next = candidate.chars().nth(64);
        if id.len() == 64
            && id
                .chars()
                .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
            && !next.is_some_and(|c| c.is_ascii_hexdigit())
        {
            ids.push(id);
        }
        rest = candidate;
    }
    ids
}

/// The model-facing content: a string, or text and image parts in order.
/// Images go to the store, so the log holds their address, not their bytes.
async fn blocks(content: Option<&Value>, store: &dyn SessionStore) -> Vec<ToolResultBlock> {
    let parts = match content {
        Some(Value::String(text)) => {
            return vec![ToolResultBlock::Text { text: text.clone() }];
        }
        Some(Value::Array(parts)) => parts,
        Some(other) => {
            return vec![ToolResultBlock::Text {
                text: other.to_string(),
            }];
        }
        None => return Vec::new(),
    };
    let mut blocks = Vec::with_capacity(parts.len());
    for part in parts {
        match part.get("type").and_then(Value::as_str) {
            Some("text") => blocks.push(ToolResultBlock::Text {
                text: part
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
            }),
            Some("image") => {
                let media_type = part
                    .get("mediaType")
                    .or_else(|| part.get("mimeType"))
                    .and_then(Value::as_str)
                    .unwrap_or("image/png");
                let stored = match part
                    .get("data")
                    .and_then(Value::as_str)
                    .map(|d| BASE64.decode(d))
                {
                    Some(Ok(bytes)) => store
                        .put_blob(media_type, bytes)
                        .await
                        .map_err(|error| error.to_string()),
                    Some(Err(error)) => Err(error.to_string()),
                    None => Err("no data".into()),
                };
                match stored {
                    Ok(blob) => blocks.push(ToolResultBlock::Image { blob }),
                    Err(error) => blocks.push(ToolResultBlock::Text {
                        text: format!("[an image could not be kept: {error}]"),
                    }),
                }
            }
            _ => blocks.push(ToolResultBlock::Text {
                text: part.to_string(),
            }),
        }
    }
    blocks
}

#[cfg(test)]
mod screenshot_tests {
    use super::screenshot_references;

    #[test]
    fn finds_each_screenshot_reference_of_a_text() {
        let a = "a".repeat(64);
        let b = "0123456789abcdef".repeat(4);
        let text = format!(
            "Screenshot saved as screenshot:{a}. Render 2: screenshot:{b}\nnot screenshot:{short} nor screenshot:{long}",
            short = "c".repeat(10),
            long = "d".repeat(65),
        );
        assert_eq!(screenshot_references(&text), vec![a, b]);
        assert!(screenshot_references("no references").is_empty());
    }
}
