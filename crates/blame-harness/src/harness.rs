//! Runs requests and model calls on cached workspaces (`light-executor.ts`,
//! `engine-tools.ts`).
//!
//! One workspace per root and task contract is kept between requests: a
//! long-lived harness keeps a session's aliases, coverage and warm caches.
//! At most eight stay, and one idle for an hour is dropped.

use crate::compiler::{CompilerPort, NoCompiler};
use crate::failure::{Failure, Outcome, Signal};
use crate::journal::SessionJournal;
use crate::json::Json;
use crate::navigation::ReadInput;
use crate::obj;
use crate::present::model_tool_response;
use crate::read_results::context_generation;
use crate::run::runner::RunContext;
use crate::tools::{normalize_search_input, tool_definitions};
use crate::validate::{
    edit_code_schema, finish_task_schema, issues_message, parse_leniently, read_code_schema,
    run_task_schema, search_code_schema,
};
use crate::workspace::Workspace;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const WORKSPACE_LIMIT: usize = 8;
const WORKSPACE_IDLE: Duration = Duration::from_secs(60 * 60);

struct Cached {
    key: String,
    workspace: Arc<Mutex<Workspace>>,
    last_used: Instant,
}

pub struct Harness {
    workspaces: Mutex<Vec<Cached>>,
    compiler: Arc<dyn CompilerPort>,
}

impl Default for Harness {
    fn default() -> Self {
        Harness::new(Arc::new(NoCompiler))
    }
}

/// A presented call: what the model reads, and the workspace's raw result.
pub struct Presented {
    pub ok: bool,
    pub content: Json,
    pub raw: Option<Json>,
}

impl Presented {
    pub fn to_json(&self) -> Json {
        obj! { "ok" => self.ok, "content" => self.content.clone() }
    }
}

impl Harness {
    pub fn new(compiler: Arc<dyn CompilerPort>) -> Harness {
        Harness {
            workspaces: Mutex::new(Vec::new()),
            compiler,
        }
    }

    /// `options`: the workspace's own settings (`initialCommandWaitMs`),
    /// part of its identity like the task contract.
    fn workspace(
        &self,
        root: &str,
        task_contract: Option<&Json>,
        options: Option<&Json>,
    ) -> Arc<Mutex<Workspace>> {
        let mut identity = vec![
            Json::from(root),
            task_contract.cloned().unwrap_or(Json::Null),
        ];
        if let Some(options) = options.filter(|options| options.is_object()) {
            identity.push(options.clone());
        }
        let key = Json::Arr(identity).stringify();
        let mut workspaces = self
            .workspaces
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let now = Instant::now();
        // A workspace in use is locked by its request: never dropped then.
        workspaces.retain(|entry| {
            entry.key == key
                || entry.workspace.try_lock().is_err()
                || now - entry.last_used < WORKSPACE_IDLE
        });
        let entry = match workspaces.iter().position(|entry| entry.key == key) {
            Some(index) => workspaces.remove(index),
            None => {
                let session = task_contract
                    .and_then(|contract| contract.get("session_id"))
                    .and_then(Json::as_str)
                    .unwrap_or("unscoped-session");
                let mut workspace = Workspace::new(
                    root,
                    session,
                    task_contract.cloned().unwrap_or(Json::Null),
                    self.compiler.clone(),
                );
                if let Some(wait) = options
                    .and_then(|options| options.get("initialCommandWaitMs"))
                    .and_then(Json::as_f64)
                {
                    workspace.set_initial_command_wait(std::time::Duration::from_millis(
                        wait.max(0.0) as u64,
                    ));
                }
                Cached {
                    key,
                    workspace: Arc::new(Mutex::new(workspace)),
                    last_used: now,
                }
            }
        };
        let workspace = entry.workspace.clone();
        workspaces.push(Cached {
            last_used: now,
            ..entry
        });
        // Least recently used first.
        while workspaces.len() > WORKSPACE_LIMIT {
            match workspaces
                .iter()
                .position(|entry| entry.workspace.try_lock().is_ok())
            {
                Some(index) => {
                    workspaces.remove(index);
                }
                None => break,
            }
        }
        workspace
    }

    /// A `request`: one workspace operation, answered with its raw result.
    pub fn execute(&self, request: &Json, signal: &Signal) -> Outcome<Json> {
        let tool = request.get("tool").and_then(Json::as_str).unwrap_or("");
        let root = request
            .get("workspaceRoot")
            .and_then(Json::as_str)
            .unwrap_or("");
        let input = request.get("input").cloned().unwrap_or(Json::Null);
        let context = request.get("toolContext").cloned().unwrap_or(Json::obj());
        let contract = request
            .get("taskContract")
            .filter(|contract| !matches!(contract, Json::Null));
        let options = request.get("workspaceOptions");
        match tool {
            "search_code" => {
                let workspace = self.workspace(root, contract, options);
                let mut workspace = workspace
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                workspace.search_code(&input, signal)
            }
            "read_code" => {
                let workspace = self.workspace(root, contract, options);
                let mut workspace = workspace
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                workspace.read_code(&read_input(&input), &context, signal)
            }
            "edit_code" => {
                let workspace = self.workspace(root, contract, options);
                let mut workspace = workspace
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                workspace.edit_code(&input, signal)
            }
            "run_task" => self.run_task(
                root,
                contract,
                options,
                &input,
                &context,
                request.get("commandCredentials"),
                signal,
            ),
            // The conformance adapter's view of the workspace's internals,
            // which the TypeScript tests call directly: the runner alone
            // (`tasks.run`), the edit service alone (`edits.edit`) and a
            // formatter commit (`edits.replaceFiles`).
            "task_runner" => {
                let workspace = self.workspace(root, contract, options);
                let runner = {
                    let mut workspace = workspace
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    workspace.prepare()?;
                    workspace.tasks()
                };
                let replace = |replacements: &crate::run::formatter::Replacements,
                               signal: &Signal| {
                    workspace
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .replace_files(replacements, signal)
                };
                let context = RunContext {
                    credentials: request
                        .get("commandCredentials")
                        .filter(|value| value.is_object())
                        .cloned(),
                    signal: signal.clone(),
                };
                Ok(runner.run(&input, &context, Some(&replace)))
            }
            "edit_service" => {
                let workspace = self.workspace(root, contract, options);
                let mut workspace = workspace
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                workspace.edit_service(&input, signal)
            }
            "replace_files" => {
                let replacements: crate::run::formatter::Replacements = input
                    .get("replacements")
                    .and_then(Json::as_array)
                    .into_iter()
                    .flatten()
                    .map(|item| {
                        let bytes = |key: &str| {
                            crate::base64::decode(
                                item.get(key).and_then(Json::as_str).unwrap_or(""),
                            )
                        };
                        (
                            item.get("path")
                                .and_then(Json::as_str)
                                .unwrap_or("")
                                .to_string(),
                            bytes("before"),
                            bytes("content"),
                        )
                    })
                    .collect();
                let workspace = self.workspace(root, contract, options);
                let mut workspace = workspace
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                workspace.replace_files(&replacements, signal)
            }
            "finish_task" => Ok(crate::finish::execute_finish(
                root, contract, &input, &context, signal,
            )),
            "session_journal" => session_journal(root, &context, &input),
            other => Err(Failure::new(format!(
                "{other} is not available in the Rust harness yet."
            ))),
        }
    }

    /// run_task: a routed shell inspection, or the runner without the
    /// workspace lock (reads go on while a command runs), then what the
    /// workspace adds to its result.
    #[allow(clippy::too_many_arguments)]
    fn run_task(
        &self,
        root: &str,
        contract: Option<&Json>,
        options: Option<&Json>,
        input: &Json,
        context: &Json,
        credentials: Option<&Json>,
        signal: &Signal,
    ) -> Outcome<Json> {
        let workspace = self.workspace(root, contract, options);
        let (runner, files_root) = {
            let mut workspace = workspace
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            workspace.prepare()?;
            (workspace.tasks(), workspace.root().to_string())
        };
        if input.get("kind").and_then(Json::as_str) == Some("command")
            && std::env::var("BLAME_AGENT_SHELL_INSPECTION_ROUTING").as_deref() != Ok("false")
        {
            let command = input.get("command").and_then(Json::as_str).unwrap_or("");
            let cwd = input.get("cwd").and_then(Json::as_str);
            if let Some(routes) =
                crate::run::inspection::shell_inspection_routes(command, cwd, &files_root)
            {
                let files = crate::files::WorkspaceFiles::new(&files_root);
                let answered = crate::run::inspection::answer(
                    command,
                    &routes,
                    |request| {
                        workspace
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .search_code(request, signal)
                    },
                    |read| {
                        workspace
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .read_code(&read_input(read), context, signal)
                    },
                    |path| {
                        let text = String::from_utf8_lossy(&files.read(path)?.content).into_owned();
                        Ok(if text.is_empty() {
                            1
                        } else {
                            text.matches('\n').count() + usize::from(!text.ends_with('\n'))
                        })
                    },
                )?;
                if let Some(answer) = answered {
                    return Ok(answer);
                }
            }
        }
        if input.get("kind").and_then(Json::as_str) == Some("analyze") {
            let mut workspace = workspace
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let result = workspace.analyze(input, signal)?;
            return workspace.after_run_task(input, result, context, signal);
        }
        let replace = |replacements: &crate::run::formatter::Replacements, signal: &Signal| {
            workspace
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .replace_files(replacements, signal)
        };
        let run_context = RunContext {
            credentials: credentials.filter(|value| value.is_object()).cloned(),
            signal: signal.clone(),
        };
        let result = runner.run(input, &run_context, Some(&replace));
        let mut workspace = workspace
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        workspace.after_run_task(input, result, context, signal)
    }

    /// A `call`: a model's tool call, validated and presented as the
    /// in-process tools present it.
    pub fn call(&self, request: &Json, signal: &Signal) -> Outcome<Presented> {
        let name = request.get("tool").and_then(Json::as_str).unwrap_or("");
        let contract = request
            .get("taskContract")
            .filter(|contract| !matches!(contract, Json::Null));
        let Some(tool) = tool_definitions(contract)
            .into_iter()
            .find(|tool| tool.name == name)
        else {
            return Ok(text_result(
                false,
                format!("There is no harness tool named {name}."),
            ));
        };
        if !tool.available {
            return Ok(text_result(
                false,
                format!("{name} is not available in the Rust harness yet."),
            ));
        }
        let input = request.get("input").cloned().unwrap_or(Json::Null);
        let (schema, value) = match name {
            "search_code" => (search_code_schema(), normalize_search_input(&input)),
            "edit_code" => (edit_code_schema(), input),
            "run_task" => (run_task_schema(), input),
            "finish_task" => (finish_task_schema(), input),
            _ => (read_code_schema(), input),
        };
        let parsed = match parse_leniently(&schema, &value) {
            Ok(parsed) => parsed,
            Err(issues) => {
                let blocked = obj! { "status" => "blocked", "category" => "input", "message" => issues_message(&issues) };
                return Ok(Presented {
                    ok: false,
                    content: model_tool_response(&blocked),
                    raw: None,
                });
            }
        };
        let context = request.get("toolContext").cloned().unwrap_or(Json::obj());
        let tool_context = if name == "search_code" {
            Json::obj()
        } else {
            light_tool_context(&context)
        };
        let inner = obj! { "input" => parsed, "tool" => name, "toolContext" => tool_context }
            .with(
                "workspaceRoot",
                request.get("workspaceRoot").cloned().unwrap_or(Json::Null),
            )
            .with_opt("taskContract", contract.cloned());
        match self.execute(&inner, signal) {
            Ok(raw) => {
                signal.check()?;
                let ok = raw.get("status").and_then(Json::as_str) == Some("ok");
                Ok(Presented {
                    ok,
                    content: model_tool_response(&raw),
                    raw: Some(raw),
                })
            }
            Err(failure) if failure.cancelled => Err(failure),
            Err(failure) => Ok(text_result(false, failure.message)),
        }
    }
}

fn text_result(ok: bool, message: String) -> Presented {
    Presented {
        ok,
        content: Json::Str(message),
        raw: None,
    }
}

/// `lightToolContext`: the identities and metadata a workspace call keeps.
fn light_tool_context(context: &Json) -> Json {
    let present = |key: &str| {
        context
            .get(key)
            .filter(|value| value.as_str().is_some_and(|text| !text.is_empty()))
            .cloned()
    };
    let mut metadata = context
        .get("metadata")
        .filter(|metadata| metadata.is_object())
        .cloned()
        .unwrap_or(Json::obj());
    metadata.set("contextGeneration", context_generation(context));
    Json::obj()
        .with_opt("agentId", present("agentId"))
        .with_opt("conversationId", present("conversationId"))
        .with("metadata", metadata)
        .with_opt("sessionId", present("sessionId"))
        .with_opt("toolCallId", present("toolCallId"))
}

/// A raw read_code input, unvalidated as the TypeScript workspace takes it.
pub fn read_input(input: &Json) -> ReadInput {
    let range = |value: &Json| {
        let line = |key: &str| {
            value
                .get(key)
                .and_then(Json::as_f64)
                .unwrap_or(0.0)
                .max(0.0) as usize
        };
        (line("startLine"), line("endLine"))
    };
    ReadInput {
        target: input
            .get("target")
            .and_then(Json::as_str)
            .unwrap_or("")
            .to_string(),
        view: input.get("view").and_then(Json::as_str).map(str::to_string),
        offset: input
            .get("offset")
            .and_then(Json::as_f64)
            .map(|value| value as u64),
        ranges: match input.get("range") {
            Some(Json::Arr(values)) => values.iter().map(range).collect(),
            Some(value @ Json::Obj(_)) => vec![range(value)],
            _ => Vec::new(),
        },
    }
}

fn session_journal(root: &str, context: &Json, input: &Json) -> Outcome<Json> {
    let Some(session) = context
        .get("sessionId")
        .and_then(Json::as_str)
        .filter(|session| !session.is_empty())
    else {
        return Err(Failure::new("Session journal requires a session ID"));
    };
    let root = crate::files::WorkspaceFiles::new(root).root;
    let mut journal = SessionJournal::new(&root, session);
    journal.hydrate();
    match input.get("kind").and_then(Json::as_str) {
        Some("request") => journal.ingest_user_request(
            input.get("id").and_then(Json::as_str).unwrap_or(""),
            input.get("text").and_then(Json::as_str).unwrap_or(""),
        )?,
        Some("terminal") => {
            journal.record_terminal(input.get("state").and_then(Json::as_str).unwrap_or(""))?
        }
        _ => return Err(Failure::new("Unsupported session journal operation")),
    }
    Ok(obj! { "status" => "ok", "data" => Json::obj() })
}
