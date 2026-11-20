//! The compiler tier's port.
//!
//! JavaScript and TypeScript references and renames, dependency
//! declarations, the import index behind `links` and TypeScript content
//! validation come from the TypeScript compiler, which cannot be ported.
//! [`NodeCompiler`] asks a Node side process for them
//! (`packages/agent-runtime/src/harness/rust-harness-compiler.ts`), started
//! on first use and gone when idle. Without Node, [`NoCompiler`] answers what
//! the TypeScript harness answers when its compiler worker cannot start.

use crate::failure::{Failure, Outcome, Signal};
use crate::files::WorkspaceSnapshot;
use crate::json::Json;
use crate::obj;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{RecvTimeoutError, Sender, channel};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

/// A reference query on one declaration (`SemanticReferenceRequest`).
pub struct ReferenceTarget<'a> {
    pub root: &'a str,
    pub path: &'a str,
    pub name: &'a str,
    pub start: usize,
    pub end: usize,
    pub hash: &'a str,
    /// A rename asks for the edits of every reference.
    pub rename_to: Option<&'a str>,
}

/// A dependency declaration query (`DependencyDeclarationRequest`).
pub struct DeclarationTarget<'a> {
    pub root: &'a str,
    pub path: &'a str,
    pub name: &'a str,
    pub hash: &'a str,
    pub offset: Option<u64>,
}

/// What a read asks the import index for its `links`.
pub struct LinksRequest<'a> {
    /// One import index per harness workspace, as in-process.
    pub workspace: &'a str,
    pub root: &'a str,
    pub path: &'a str,
    pub content: &'a [u8],
    pub focus: &'a [String],
    pub snapshot: &'a WorkspaceSnapshot,
}

/// A compiler reply: `{status: "ok", ...}` as the worker sends it, or the
/// reason it is unavailable.
pub enum CompilerReply {
    Ok(Json),
    Unavailable(String),
}

pub trait CompilerPort: Send + Sync {
    /// `querySemanticReferences`: locations, footprint and project.
    fn references(&self, target: &ReferenceTarget<'_>, signal: &Signal) -> Outcome<CompilerReply>;

    /// `queryDependencyDeclaration`: a bounded read-only declaration.
    fn declaration(
        &self,
        target: &DeclarationTarget<'_>,
        signal: &Signal,
    ) -> Outcome<CompilerReply>;

    /// `ImportIndex.briefLinks`: one line naming who uses a file's exports and
    /// which tests import it, on its first whole or folded read.
    fn brief_links(&self, request: &LinksRequest<'_>, signal: &Signal) -> Outcome<Option<String>>;

    /// `validateContent` for the validators that need the TypeScript side
    /// (TypeScript, JSONC, Prisma); `None` when it is unavailable.
    fn validate(
        &self,
        root: &str,
        path: &str,
        content: Option<&[u8]>,
        external: Option<&str>,
        signal: &Signal,
    ) -> Outcome<Option<Json>>;
}

/// The reason a TypeScript harness gives when its compiler worker fails.
const WORKER_FAILED: &str = "worker_failed";

/// No compiler side process: every query is unavailable, reads carry no links.
pub struct NoCompiler;

impl CompilerPort for NoCompiler {
    fn references(
        &self,
        _target: &ReferenceTarget<'_>,
        _signal: &Signal,
    ) -> Outcome<CompilerReply> {
        Ok(CompilerReply::Unavailable(WORKER_FAILED.into()))
    }

    fn declaration(
        &self,
        _target: &DeclarationTarget<'_>,
        _signal: &Signal,
    ) -> Outcome<CompilerReply> {
        Ok(CompilerReply::Unavailable(WORKER_FAILED.into()))
    }

    fn brief_links(
        &self,
        _request: &LinksRequest<'_>,
        _signal: &Signal,
    ) -> Outcome<Option<String>> {
        Ok(None)
    }

    fn validate(
        &self,
        _root: &str,
        _path: &str,
        _content: Option<&[u8]>,
        _external: Option<&str>,
        _signal: &Signal,
    ) -> Outcome<Option<Json>> {
        Ok(None)
    }
}

type Pending = Arc<Mutex<HashMap<String, Sender<Result<Json, String>>>>>;

struct Running {
    child: Child,
    stdin: ChildStdin,
    pending: Pending,
    alive: Arc<AtomicBool>,
}

/// The Node side process, started on the first query and again after it
/// exits (it stops itself once idle).
pub struct NodeCompiler {
    command: Vec<String>,
    running: Mutex<Option<Running>>,
    sequence: AtomicU64,
}

enum Sent {
    Reply(Json),
    Error(String),
    /// The process could not start or ended before answering.
    Gone,
}

impl NodeCompiler {
    /// `command` is the argv of the side process, `["node", ".../rust-harness-compiler.js"]`.
    pub fn new(command: Vec<String>) -> NodeCompiler {
        NodeCompiler {
            command,
            running: Mutex::new(None),
            sequence: AtomicU64::new(0),
        }
    }

    fn start(&self) -> Option<Running> {
        let (program, arguments) = self.command.split_first()?;
        let mut child = Command::new(program)
            .args(arguments)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .ok()?;
        let stdin = child.stdin.take()?;
        let stdout = child.stdout.take()?;
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let alive = Arc::new(AtomicBool::new(true));
        let (reader_pending, reader_alive) = (pending.clone(), alive.clone());
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let Ok(message) = Json::parse(&line) else {
                    continue;
                };
                let Some(id) = message.get("id").and_then(Json::as_str) else {
                    continue;
                };
                let waiting = reader_pending
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .remove(id);
                if let Some(waiting) = waiting {
                    let answer = match message.get("error").and_then(Json::as_str) {
                        Some(error) => Err(error.to_string()),
                        None => Ok(message.get("reply").cloned().unwrap_or(Json::Null)),
                    };
                    let _ = waiting.send(answer);
                }
            }
            reader_alive.store(false, Ordering::SeqCst);
            // Dropping the senders tells every waiting query the process is gone.
            reader_pending
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clear();
        });
        Some(Running {
            child,
            stdin,
            pending,
            alive,
        })
    }

    fn send_once(&self, kind: &str, body: Json, signal: &Signal) -> Outcome<Sent> {
        let id = format!("q{}", self.sequence.fetch_add(1, Ordering::SeqCst) + 1);
        let (sender, receiver) = channel();
        {
            let mut running = self
                .running
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if running
                .as_ref()
                .is_none_or(|process| !process.alive.load(Ordering::SeqCst))
            {
                if let Some(mut stale) = running.take() {
                    let _ = stale.child.wait();
                }
                *running = self.start();
            }
            let Some(process) = running.as_mut() else {
                return Ok(Sent::Gone);
            };
            process
                .pending
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .insert(id.clone(), sender);
            let line = format!(
                "{}\n",
                obj! { "id" => id.as_str() }.with(kind, body).stringify()
            );
            if process
                .stdin
                .write_all(line.as_bytes())
                .and_then(|()| process.stdin.flush())
                .is_err()
            {
                process.alive.store(false, Ordering::SeqCst);
                return Ok(Sent::Gone);
            }
        }
        loop {
            match receiver.recv_timeout(Duration::from_millis(25)) {
                Ok(Ok(reply)) => return Ok(Sent::Reply(reply)),
                Ok(Err(error)) => return Ok(Sent::Error(error)),
                Err(RecvTimeoutError::Disconnected) => return Ok(Sent::Gone),
                Err(RecvTimeoutError::Timeout) if signal.aborted() => {
                    let mut running = self
                        .running
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    if let Some(process) = running.as_mut() {
                        let line = format!(
                            "{}\n",
                            obj! { "id" => id.as_str(), "cancel" => true }.stringify()
                        );
                        let _ = process
                            .stdin
                            .write_all(line.as_bytes())
                            .and_then(|()| process.stdin.flush());
                        process
                            .pending
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .remove(&id);
                    }
                    return Err(Failure::cancelled());
                }
                Err(RecvTimeoutError::Timeout) => {}
            }
        }
    }

    /// Sends one query. A process that stopped itself while idle just as the
    /// query left is started again once.
    fn send(&self, kind: &str, body: Json, signal: &Signal) -> Outcome<Sent> {
        match self.send_once(kind, body.clone(), signal)? {
            Sent::Gone => self.send_once(kind, body, signal),
            other => Ok(other),
        }
    }

    fn compiler_reply(&self, kind: &str, body: Json, signal: &Signal) -> Outcome<CompilerReply> {
        match self.send(kind, body, signal)? {
            Sent::Reply(reply) if reply.get("status").and_then(Json::as_str) == Some("ok") => {
                Ok(CompilerReply::Ok(reply))
            }
            Sent::Reply(reply) => Ok(CompilerReply::Unavailable(
                reply
                    .get("reason")
                    .and_then(Json::as_str)
                    .unwrap_or(WORKER_FAILED)
                    .to_string(),
            )),
            Sent::Error(error) => Err(Failure::new(error)),
            Sent::Gone => Ok(CompilerReply::Unavailable(WORKER_FAILED.into())),
        }
    }
}

impl Drop for NodeCompiler {
    fn drop(&mut self) {
        // Closing its stdin stops the side process and its workers.
        if let Some(mut process) = self
            .running
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
        {
            drop(process.stdin);
            let _ = process.child.wait();
        }
    }
}

impl CompilerPort for NodeCompiler {
    fn references(&self, target: &ReferenceTarget<'_>, signal: &Signal) -> Outcome<CompilerReply> {
        let request = obj! { "root" => target.root }
            .with_opt("renameTo", target.rename_to)
            .with(
                "target",
                obj! { "path" => target.path, "name" => target.name, "start" => target.start, "end" => target.end, "hash" => target.hash },
            );
        self.compiler_reply("references", request, signal)
    }

    fn declaration(
        &self,
        target: &DeclarationTarget<'_>,
        signal: &Signal,
    ) -> Outcome<CompilerReply> {
        let request = obj! {
            "root" => target.root,
            "declaration" => true,
            "target" => obj! { "path" => target.path, "name" => target.name, "hash" => target.hash },
        }
        .with_opt("offset", target.offset);
        self.compiler_reply("declaration", request, signal)
    }

    fn brief_links(&self, request: &LinksRequest<'_>, signal: &Signal) -> Outcome<Option<String>> {
        let body = obj! {
            "key" => request.workspace,
            "root" => request.root,
            "path" => request.path,
            "content" => crate::workspace::base64(request.content),
            "focus" => Json::Arr(request.focus.iter().map(Json::from).collect()),
            "snapshot" => snapshot_json(request.snapshot),
        };
        // Links are an extra on a read: an unavailable index adds none.
        Ok(match self.send("links", body, signal)? {
            Sent::Reply(Json::Str(links)) => Some(links),
            _ => None,
        })
    }

    fn validate(
        &self,
        root: &str,
        path: &str,
        content: Option<&[u8]>,
        external: Option<&str>,
        signal: &Signal,
    ) -> Outcome<Option<Json>> {
        let body = obj! {
            "path" => path,
            "content" => content.map_or(Json::Null, |content| Json::from(crate::workspace::base64(content))),
            "workspaceRoot" => root,
        }
        .with_opt("externalValidation", external);
        Ok(match self.send("validate", body, signal)? {
            Sent::Reply(reply @ Json::Obj(_)) => Some(reply),
            Sent::Error(error) => return Err(Failure::new(error)),
            _ => None,
        })
    }
}

/// A snapshot as the TypeScript `WorkspaceSnapshot`.
pub fn snapshot_json(snapshot: &WorkspaceSnapshot) -> Json {
    let revision = obj! { "source_revision_id" => snapshot.revision.source_revision_id.as_str() }
        .with_opt("base_commit", snapshot.revision.base_commit.as_deref())
        .with(
            "overlay_merkle_root",
            snapshot.revision.overlay_merkle_root.as_str(),
        );
    Json::obj()
        .with_opt("branch", snapshot.branch.as_deref())
        .with(
            "changes",
            Json::Arr(snapshot.changes.iter().map(|change| obj! { "path" => change.path.as_str(), "status" => change.status.as_str() }).collect()),
        )
        .with("files", Json::Arr(snapshot.files.iter().map(Json::from).collect()))
        .with(
            "fileStates",
            Json::Arr(snapshot.file_states.iter().map(|(path, hash)| obj! { "path" => path.as_str(), "hash" => hash.as_str() }).collect()),
        )
        .with("git", snapshot.git)
        .with("revision", revision)
}

/// `referenceFootprintIsCurrent`: every real path, read hash and existence
/// the compiler relied on still holds.
pub fn footprint_is_current(footprint: &Json, signal: &Signal) -> Outcome<bool> {
    let list = |key: &str| {
        footprint
            .get(key)
            .and_then(Json::as_array)
            .cloned()
            .unwrap_or_default()
    };
    let text = |value: &Json, key: &str| {
        value
            .get(key)
            .and_then(Json::as_str)
            .unwrap_or("")
            .to_string()
    };
    for (index, entry) in list("realpaths").iter().enumerate() {
        if index % 32 == 0 {
            signal.check()?;
        }
        let current = std::fs::canonicalize(text(entry, "path"))
            .map(|path| path.to_string_lossy().into_owned());
        if current.ok().as_deref() != Some(text(entry, "resolved").as_str()) {
            return Ok(false);
        }
    }
    for (index, entry) in list("reads").iter().enumerate() {
        if index % 32 == 0 {
            signal.check()?;
        }
        let current =
            std::fs::read(text(entry, "path")).map(|content| crate::identity::sha256_hex(&content));
        if current.ok().as_deref() != Some(text(entry, "hash").as_str()) {
            return Ok(false);
        }
    }
    for (index, entry) in list("existence").iter().enumerate() {
        if index % 32 == 0 {
            signal.check()?;
        }
        let exists = entry.get("exists").and_then(Json::as_bool).unwrap_or(false);
        let current = match std::fs::metadata(text(entry, "path")) {
            Ok(metadata) => metadata.is_file() == exists,
            Err(_) => !exists,
        };
        if !current {
            return Ok(false);
        }
    }
    Ok(true)
}

/// The compiler port a harness uses: the side process when configured
/// (`BLAME_HARNESS_COMPILER`, a JSON array of argv), none otherwise.
pub fn configured(command: Option<&str>) -> Arc<dyn CompilerPort> {
    let parsed = command
        .and_then(|text| Json::parse(text).ok())
        .and_then(|value| {
            let items = value
                .as_array()?
                .iter()
                .map(|item| item.as_str().map(str::to_string))
                .collect::<Option<Vec<String>>>()?;
            (!items.is_empty()).then_some(items)
        });
    match parsed {
        Some(command) => Arc::new(NodeCompiler::new(command)),
        None => Arc::new(NoCompiler),
    }
}
