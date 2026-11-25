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

/// How long a question to the client may wait for its answer.
const ASK_WAIT: Duration = Duration::from_secs(10);
const WORKSPACE_LIMIT: usize = 8;
const WORKSPACE_IDLE: Duration = Duration::from_secs(60 * 60);

struct Cached {
    key: String,
    workspace: Arc<Mutex<Workspace>>,
    last_used: Instant,
}

pub struct Harness {
    workspaces: Mutex<Vec<Cached>>,
    /// How many workspaces stay, and how long an idle one does.
    workspace_limit: usize,
    workspace_idle: Duration,
    compiler: Arc<dyn CompilerPort>,
    /// The client's answers to what only it knows (`serve --asks`).
    pub asker: crate::ask::Asker,
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
    /// The model's view of the result, and for a refused finish why, typed:
    /// `refusal: { kind: "failing_checks", tasks }`.
    pub fn to_json(&self) -> Json {
        let failing = self
            .raw
            .as_ref()
            .filter(|_| !self.ok)
            .and_then(|raw| raw.get("failingChecks"))
            .cloned();
        obj! { "ok" => self.ok, "content" => self.content.clone() }.with_opt(
            "refusal",
            failing.map(|tasks| obj! { "kind" => "failing_checks", "tasks" => tasks }),
        )
    }
}

impl Harness {
    pub fn new(compiler: Arc<dyn CompilerPort>) -> Harness {
        Harness {
            workspaces: Mutex::new(Vec::new()),
            workspace_limit: WORKSPACE_LIMIT,
            workspace_idle: WORKSPACE_IDLE,
            compiler,
            asker: crate::ask::Asker::default(),
        }
    }

    /// The same harness keeping at most `limit` workspaces, each for `idle`.
    pub fn with_workspace_cache(mut self, limit: usize, idle: Duration) -> Harness {
        self.workspace_limit = limit;
        self.workspace_idle = idle;
        self
    }

    /// `options`: the workspace's own settings (`initialCommandWaitMs`),
    /// part of its identity like the task contract.
    fn workspace(
        &self,
        root: &str,
        task_contract: Option<&Json>,
        options: Option<&Json>,
    ) -> Arc<Mutex<Workspace>> {
        let key = workspace_key(root, task_contract, options);
        let mut workspaces = self
            .workspaces
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let now = Instant::now();
        // A workspace in use is locked by its request, or runs a command:
        // never dropped then. One idle past the limit is, even the one asked
        // for, which then starts afresh.
        workspaces
            .retain(|entry| busy(&entry.workspace) || now - entry.last_used < self.workspace_idle);
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
        while workspaces.len() > self.workspace_limit {
            match workspaces.iter().position(|entry| !busy(&entry.workspace)) {
                Some(index) => {
                    workspaces.remove(index);
                }
                None => break,
            }
        }
        workspace
    }

    /// A `request`: one workspace operation, answered with its raw result.
    /// The workspace's idle time counts from when the operation ends, so one
    /// that served a long request is not dropped as it finishes.
    pub fn execute(&self, request: &Json, signal: &Signal) -> Outcome<Json> {
        let result = self.execute_request(request, signal);
        let key = workspace_key(
            request
                .get("workspaceRoot")
                .and_then(Json::as_str)
                .unwrap_or(""),
            request
                .get("taskContract")
                .filter(|contract| !matches!(contract, Json::Null)),
            request.get("workspaceOptions"),
        );
        let now = Instant::now();
        for entry in self
            .workspaces
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter_mut()
            .filter(|entry| entry.key == key)
        {
            entry.last_used = now;
        }
        result
    }

    fn execute_request(&self, request: &Json, signal: &Signal) -> Outcome<Json> {
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
                    refresh_preview: None,
                    approved: false,
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
            // The suite's tests that call one of the harness's functions.
            "unit" => crate::units::call(
                input.get("function").and_then(Json::as_str).unwrap_or(""),
                input
                    .get("args")
                    .and_then(Json::as_array)
                    .map(Vec::as_slice)
                    .unwrap_or(&[]),
            ),
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
        // cmd.exe reads command lines differently: no routing on Windows.
        if !cfg!(windows)
            && input.get("kind").and_then(Json::as_str) == Some("command")
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
        let session = context
            .get("sessionId")
            .and_then(Json::as_str)
            .or_else(|| {
                contract
                    .and_then(|contract| contract.get("session_id"))
                    .and_then(Json::as_str)
            })
            .unwrap_or("")
            .to_string();
        let asked = |method: &str| {
            self.asker.ask(
                method,
                obj! { "sessionId" => session.as_str(), "workspaceRoot" => root },
                ASK_WAIT,
            )
        };
        // Credentials as the app grants them, asked before each command.
        let kind = input
            .get("kind")
            .and_then(Json::as_str)
            .unwrap_or("command");
        let asked_credentials = if credentials.is_none() && matches!(kind, "command" | "project") {
            asked("commandCredentials")
        } else {
            None
        };
        let credentials = credentials.cloned().or(asked_credentials);
        let refresh = || asked("refreshPreviewDependencies");
        let run_context = RunContext {
            refresh_preview: Some(&refresh),
            // Set by the engine once the person approved this very call.
            approved: context.get("approved").and_then(Json::as_bool) == Some(true),
            credentials: credentials.filter(|value| value.is_object()),
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
        if name == "finish_task" {
            return self.call_finish(request, &input, signal);
        }
        let (schema, value) = match name {
            "search_code" => (search_code_schema(), normalize_search_input(&input)),
            "edit_code" => (edit_code_schema(), input),
            "run_task" => (run_task_schema(), normalize_run_task_input(&input)),
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
            .with_opt("taskContract", contract.cloned())
            .with_opt(
                "commandCredentials",
                request
                    .get("commandCredentials")
                    .filter(|value| value.is_object())
                    .cloned(),
            );
        match self.execute(&inner, signal) {
            Ok(result) => {
                signal.check()?;
                let ok = result.get("status").and_then(Json::as_str) == Some("ok");
                let content = if name == "run_task" {
                    model_tool_response(&crate::run::check::presented_run_result(&result))
                } else {
                    model_tool_response(&result)
                };
                Ok(Presented {
                    ok,
                    content,
                    raw: Some(result),
                })
            }
            Err(failure) if failure.cancelled => Err(failure),
            Err(failure) => Ok(text_result(false, failure.message)),
        }
    }
}

impl Harness {
    /// finish_task as the engine's tool (`createFinishTaskTool` with the
    /// runner as executor): the input checked as zod checks it, with no
    /// repair; screenshots accepted only when the session took them (the
    /// engine names them in `knownScreenshots`); the accepted summary as the
    /// answer, a refusal as the failure's text.
    fn call_finish(&self, request: &Json, input: &Json, signal: &Signal) -> Outcome<Presented> {
        let (parsed, issues) = finish_task_schema().run(Some(input));
        if !issues.is_empty() {
            return Ok(text_result(false, finish_input_error(input, &issues)));
        }
        let parsed = parsed.unwrap_or(Json::Null);
        let images =
            crate::finish::finish_images(parsed.get("images").unwrap_or(&Json::Arr(Vec::new())));
        let known: Vec<&str> = request
            .get("knownScreenshots")
            .and_then(Json::as_array)
            .into_iter()
            .flatten()
            .filter_map(Json::as_str)
            .collect();
        let unknown: Vec<String> = images
            .iter()
            .filter_map(|image| image.get("id").and_then(Json::as_str))
            .filter(|id| !known.contains(id))
            .map(|id| format!("screenshot:{id}"))
            .collect();
        if !unknown.is_empty() {
            return Ok(text_result(
                false,
                format!(
                    "finish_task images must be screenshots taken in this conversation. Unknown: {}. Use the exact reference from a preview_devtools__take_screenshot result, take the screenshot again, or remove the image.",
                    unknown.join(", ")
                ),
            ));
        }
        let summary = parsed.get("summary").cloned().unwrap_or(Json::Null);
        let context = request.get("toolContext").cloned().unwrap_or(Json::obj());
        let inner = obj! { "input" => obj! { "summary" => summary.clone(), "finishImages" => Json::Arr(images) }, "taskContract" => request.get("taskContract").cloned().unwrap_or(Json::Null), "tool" => "finish_task", "toolContext" => light_tool_context(&context) }
            .with("workspaceRoot", request.get("workspaceRoot").cloned().unwrap_or(Json::Null));
        match self.execute(&inner, signal) {
            Ok(raw) => {
                signal.check()?;
                if raw.get("status").and_then(Json::as_str) != Some("ok") {
                    let message = raw
                        .get("message")
                        .and_then(Json::as_str)
                        .unwrap_or("")
                        .to_string();
                    return Ok(Presented {
                        ok: false,
                        content: Json::Str(message),
                        raw: Some(raw),
                    });
                }
                let answer = raw
                    .get("data")
                    .and_then(|data| data.get("summary"))
                    .cloned()
                    .filter(|summary| summary.as_str().is_some())
                    .unwrap_or(summary);
                Ok(Presented {
                    ok: true,
                    content: answer,
                    raw: Some(raw),
                })
            }
            Err(failure) if failure.cancelled => Err(failure),
            Err(failure) => Ok(text_result(false, failure.message)),
        }
    }
}

/// `finishInputError`: what to fix, with the summary's length when it is too long.
fn finish_input_error(input: &Json, issues: &[crate::validate::Issue]) -> String {
    let problems: Vec<String> = issues
        .iter()
        .take(5)
        .map(|issue| {
            let field = issue
                .path
                .iter()
                .map(|part| match part {
                    Json::Str(text) => text.clone(),
                    other => other.stringify(),
                })
                .collect::<Vec<_>>()
                .join(".");
            let field = if field.is_empty() {
                "input".to_string()
            } else {
                field
            };
            if field == "summary"
                && issue.message.starts_with("Too big:")
                && let Some(summary) = input.get("summary").and_then(Json::as_str)
            {
                return format!(
                    "summary is {} characters, the limit is 100000; shorten it",
                    crate::text::utf16_len(crate::text::js_trim(summary))
                );
            }
            format!("{field}: {}", issue.message)
        })
        .collect();
    format!(
        "finish_task was not accepted: {}. Fix this and call finish_task again.",
        problems.join("; ")
    )
}

/// The engine's `approval` question: a run_task command refused only because
/// it changes git, in a workspace that is not isolated, needs the person's
/// approval instead.
pub fn needs_approval(request: &Json) -> bool {
    if request.get("tool").and_then(Json::as_str) != Some("run_task") {
        return false;
    }
    let input = normalize_run_task_input(&request.get("input").cloned().unwrap_or(Json::Null));
    if !matches!(
        input.get("kind").and_then(Json::as_str),
        None | Some("command")
    ) {
        return false;
    }
    let Some(command) = input.get("command").and_then(Json::as_str) else {
        return false;
    };
    let contract = request.get("taskContract").cloned().unwrap_or(Json::Null);
    crate::run::policy::needs_git_approval(
        command,
        crate::run::policy::CommandEnvironment::from_contract(&contract),
    )
}

/// `runTaskInput`: known model misreadings repaired before validation (a
/// task sent as `kind: "task"` or without a kind, a bare run number, a
/// command sent as an inspect).
fn normalize_run_task_input(value: &Json) -> Json {
    let Json::Obj(_) = value else {
        return value.clone();
    };
    let mut input = value.clone();
    let kind = input.get("kind").and_then(Json::as_str).map(str::to_string);
    if input.get("task").and_then(Json::as_str).is_some()
        && (kind.as_deref() == Some("task")
            || (input.get("kind").is_none() && input.get("command").is_none()))
    {
        input.set("kind", "project");
        return input;
    }
    if kind.as_deref() != Some("inspect") {
        return value.clone();
    }
    let run = input
        .get("run")
        .and_then(Json::as_str)
        .map(|run| crate::text::js_trim(run).to_string());
    static RUN: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"^[rR]?[1-9]\d*$").expect("pattern"));
    if let Some(run) = run.as_deref().filter(|run| RUN.is_match(run)) {
        input.set("run", format!("r{}", run.trim_start_matches(['r', 'R'])));
        return input;
    }
    let command = input
        .get("command")
        .and_then(Json::as_str)
        .map(str::to_string)
        .or_else(|| {
            run.clone()
                .filter(|run| run.chars().any(crate::text::is_js_space))
        });
    let Some(command) = command else {
        return value.clone();
    };
    if input.get("run").is_some() && Some(command.as_str()) != run.as_deref() {
        return value.clone();
    }
    input.remove("cursor");
    input.remove("run");
    input.set("kind", "command");
    input.set("command", command);
    input
}

/// A workspace in use by a request, or running a command it started, is
/// never dropped: its managed runs live in it.
/// A workspace's identity: its folder, task contract and own settings.
fn workspace_key(root: &str, task_contract: Option<&Json>, options: Option<&Json>) -> String {
    let mut identity = vec![
        Json::from(root),
        task_contract.cloned().unwrap_or(Json::Null),
    ];
    if let Some(options) = options.filter(|options| options.is_object()) {
        identity.push(options.clone());
    }
    Json::Arr(identity).stringify()
}

fn busy(workspace: &Mutex<Workspace>) -> bool {
    match workspace.try_lock() {
        Ok(workspace) => workspace.tasks().running(),
        Err(_) => true,
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
pub fn light_tool_context(context: &Json) -> Json {
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
        // The person approved this very call (the engine says so).
        .with_opt(
            "approved",
            context
                .get("approved")
                .filter(|value| value.as_bool() == Some(true))
                .cloned(),
        )
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
