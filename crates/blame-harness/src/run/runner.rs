//! `run_task`'s runner (`light-task-runner.ts`): project tasks, literal
//! commands, the dependency operation, deterministic formatting and
//! managed runs.
//!
//! A command holds its session's turn while it runs and the workspace lock
//! only to look at the files before and after it. One still running after
//! the initial wait (15 s) becomes a managed run `rN`: the call returns its
//! first output page, `inspect` pages the rest and waits for its end, and
//! the session's edits are refused until it ends. Commands sent while one
//! runs start when it ends.

use super::catalog::{
    self, Task, invocation_display, is_validation_kind, plain_compiler_check, read_task_catalog,
    task_invocation,
};
use super::changes::command_changes;
use super::check::{
    CommandResult, TypecheckSelection, check_reporting, is_test_invocation, observe_check,
    project_test_command, runtime_test_scope, typecheck_selections,
};
use super::dependency::{DependencyInput, DependencyResult, mutate};
use super::environment::{command_cwd, command_environment, shell_command, target};
use super::failure::{
    Assessment, command_failure, command_failure_assessment, declared_dependencies,
    exit_from_other_stage, failed_command_result,
};
use super::formatter::{self, Replacements};
use super::inspection::read_only_inspection;
use super::managed::{
    InvocationReport, ManagedReport, ReportSources, environment_manifest_evidence,
    invocation_test_report, managed_test_report,
};
use super::output::{
    COMMAND_OUTPUT_OMITTED, bounded_diagnostic, command_output, validation_output,
    validation_scope_paths, without_binary,
};
use super::policy::{CommandEnvironment, blocked_command_reason_for};
use super::process::{
    self, CommandHandle, CommandOptions, CommandOutcome, DEFAULT_OUTPUT_LIMIT, DEFAULT_TIMEOUT_MS,
};
use super::report::NodeEventBinding;
use crate::failure::{Failure, Outcome, Signal};
use crate::files::{WorkspaceFiles, WorkspaceSnapshot};
use crate::identity::sha256_hex;
use crate::journal::SessionJournal;
use crate::json::Json;
use crate::obj;
use crate::present::redact_secrets;
use crate::text::js_trim;
use crate::turn::{self, Holder};
use crate::workspace::lock;
use regex::Regex;
use std::sync::mpsc;
use std::sync::{Arc, Condvar, LazyLock, Mutex};
use std::thread;
use std::time::Duration;

/// A project task and the typecheck tasks offered after it.
type SelectedTask = (Task, Option<Vec<TypecheckSelection>>);

/// One page of a run's output (`inspect`): twice what a result shows whole
/// (`COMMAND_OUTPUT_LIMIT`), so a cut output reads back in a page or two.
const OUTPUT_PAGE_BYTES: usize = 24_000;
// Under Claude Code's 300 s limit on a silent MCP tool call.
const INSPECT_EXIT_WAIT: Duration = Duration::from_secs(4 * 60);
const KEPT_FINISHED_RUNS: usize = 20;

/// Commits a formatter's output through the workspace's edit service.
pub type ReplaceFiles<'a> = &'a (dyn Fn(&Replacements, &Signal) -> Outcome<Json> + Sync);

pub struct RunContext<'a> {
    pub credentials: Option<Json>,
    pub signal: Signal,
    /// After a dependency operation changed files: the session's preview
    /// takes them, and this is its state (the result's `preview`).
    pub refresh_preview: Option<&'a (dyn Fn() -> Option<Json> + Sync)>,
    /// The person approved this call: its git changes run in a workspace
    /// that is not isolated (`policy::needs_git_approval`).
    pub approved: bool,
}

/// A run's result, set once.
#[derive(Default)]
struct Completion {
    value: Mutex<Option<Json>>,
    ready: Condvar,
}

impl Completion {
    fn set(&self, value: Json) {
        *lock(&self.value) = Some(value);
        self.ready.notify_all();
    }

    fn get(&self) -> Option<Json> {
        lock(&self.value).clone()
    }

    fn wait(&self) -> Json {
        let mut value = lock(&self.value);
        loop {
            if let Some(value) = value.as_ref() {
                return value.clone();
            }
            value = self
                .ready
                .wait(value)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }
}

struct ManagedRun {
    command: String,
    handle: CommandHandle,
    completion: Arc<Completion>,
}

/// Commands started here take turns, first come first served.
#[derive(Default)]
struct CommandQueue {
    state: Mutex<(u64, u64)>,
    advanced: Condvar,
}

#[derive(Clone, Default)]
struct Metadata {
    validation_scope: Option<String>,
    task_command: Option<String>,
    args: Option<Vec<String>>,
    check: Option<Json>,
    cwd: Option<String>,
    source_revision_id: Option<String>,
    task_id: Option<String>,
    task_kind: Option<String>,
    report: Option<Arc<ManagedReport>>,
    invocation_report: Option<Arc<InvocationReport>>,
    invocation_snapshot: Option<Arc<WorkspaceSnapshot>>,
    invocation_environment: Option<Json>,
    typecheck_selections: Option<Vec<TypecheckSelection>>,
}

pub struct TaskRunner {
    root: String,
    session: String,
    environment: CommandEnvironment,
    journal: Arc<Mutex<SessionJournal>>,
    initial_wait: Duration,
    runs: Mutex<Vec<(String, Arc<ManagedRun>)>>,
    run_sequence: Mutex<usize>,
    report_sequence: Mutex<usize>,
    queue: Arc<CommandQueue>,
}

fn blocked(category: &str, message: impl Into<String>) -> Json {
    obj! { "status" => "blocked", "category" => category, "message" => message.into() }
}

fn text<'a>(input: &'a Json, key: &str) -> Option<&'a str> {
    input.get(key).and_then(Json::as_str)
}

fn strings(input: &Json, key: &str) -> Vec<String> {
    input
        .get(key)
        .and_then(Json::as_array)
        .into_iter()
        .flatten()
        .filter_map(Json::as_str)
        .map(str::to_string)
        .collect()
}

fn redacted_output(output: &str) -> String {
    redact_secrets(&without_binary(js_trim(output)))
}

impl TaskRunner {
    pub fn new(
        root: &str,
        session: &str,
        contract: &Json,
        journal: Arc<Mutex<SessionJournal>>,
    ) -> TaskRunner {
        let initial_wait = 15_000;
        TaskRunner {
            root: root.to_string(),
            session: session.to_string(),
            environment: CommandEnvironment::from_contract(contract),
            journal,
            initial_wait: Duration::from_millis(initial_wait),
            runs: Mutex::new(Vec::new()),
            run_sequence: Mutex::new(0),
            report_sequence: Mutex::new(0),
            queue: Arc::new(CommandQueue::default()),
        }
    }

    pub fn with_initial_wait(mut self, wait: Duration) -> TaskRunner {
        self.initial_wait = wait;
        self
    }

    /// A command started here is still running.
    pub fn running(&self) -> bool {
        lock(&self.runs)
            .iter()
            .any(|(_, run)| run.completion.get().is_none())
    }

    fn files(&self) -> WorkspaceFiles {
        WorkspaceFiles::new(&self.root)
    }

    pub fn run(
        self: &Arc<Self>,
        input: &Json,
        context: &RunContext,
        replace_files: Option<ReplaceFiles<'_>>,
    ) -> Json {
        match text(input, "kind") {
            Some("analyze") => blocked(
                "input",
                "Symbolic analysis requires workspace symbol resolution.",
            ),
            Some("inspect") => self.inspect(input, &context.signal),
            Some("dependency") => self.dependency(input, context),
            Some("project") => self.project(input, context),
            _ => self.command(input, context, replace_files),
        }
    }

    fn find_run(&self, id: &str) -> Option<Arc<ManagedRun>> {
        lock(&self.runs)
            .iter()
            .find(|(known, _)| known == id)
            .map(|(_, run)| run.clone())
    }

    fn inspect(&self, input: &Json, signal: &Signal) -> Json {
        let id = text(input, "run").unwrap_or("");
        let Some(run) = self.find_run(id) else {
            return blocked(
                "input",
                format!("Run {id} does not belong to this session or is no longer available."),
            );
        };
        let cursor = text(input, "cursor");
        // Waiting for the end by default: a turn per burst of test output
        // cost 11 of 107 turns and 13% of a story's input tokens.
        let until = text(input, "until").unwrap_or("exit");
        let waited = (|| -> Outcome<Json> {
            if std::env::var("BLAME_AGENT_INSPECT_WAIT").as_deref() != Ok("false")
                && run.completion.get().is_none()
            {
                if until == "exit" {
                    run.handle.wait_for_exit(INSPECT_EXIT_WAIT, signal)?;
                } else if until == "output" && cursor.is_some() {
                    run.handle
                        .wait_for_update(cursor, Duration::from_secs(30), signal)?;
                }
            }
            self.run_view(id, &run, cursor)
        })();
        match waited {
            Ok(view) => view,
            Err(_) if signal.aborted() => blocked(
                "environment",
                "Managed-run inspection was cancelled; no command outcome is inferred.",
            ),
            Err(failure) => blocked("input", failure.message),
        }
    }

    /// One page of a run's output and, once it ended, its result.
    fn run_view(&self, id: &str, run: &ManagedRun, cursor: Option<&str>) -> Outcome<Json> {
        let snapshot = run.handle.inspect(cursor, Some(OUTPUT_PAGE_BYTES))?;
        // The process ends before the files are looked at and the journal
        // written: show their real result together.
        let completed = match run.completion.get() {
            Some(result) => Some(result),
            None if snapshot.process != "running" => Some(run.completion.wait()),
            None => None,
        };
        // The command is said once, here: never again in its result.
        let completed = completed.map(|result| without_command(result, &run.command));
        if cursor.is_none()
            && let Some(completed) = completed
        {
            // An ended run reads as its result, as a command that ended
            // within the initial wait does: the latest page beside it
            // repeated the output the result already holds.
            return Ok(obj! {
                "status" => "ok",
                "data" => obj! {
                    "run" => id,
                    "command" => run.command.as_str(),
                    "process" => snapshot.process,
                    "completed" => with_full_output(completed, id),
                },
            });
        }
        let unread =
            snapshot.total_bytes.unwrap_or(0) as i64 - snapshot.cursor.parse::<i64>().unwrap_or(0);
        let page = |cursor: &str| obj! { "kind" => "inspect", "run" => id, "cursor" => cursor, "until" => "now" };
        let mut data = obj! {
            "run" => id,
            "command" => run.command.as_str(),
            "process" => snapshot.process,
            "cursor" => snapshot.cursor.as_str(),
            // Pages join exactly: redacted, not trimmed.
            "output" => redact_secrets(&snapshot.output),
        };
        if cursor.is_none() && snapshot.start.unwrap_or(0) > 0 {
            data.set("outputFrom", snapshot.start.unwrap_or(0));
            data.set("earlierOutput", page("0"));
        }
        if unread > 0 {
            data.set("nextOutput", page(&snapshot.cursor));
        }
        if let Some(mut completed) = completed {
            // Paging: the pages are the output; the result keeps its outcome.
            if let Some(data) = completed.get_mut("data") {
                data.remove("output");
            }
            if let Some(message) = completed.get("message").and_then(Json::as_str) {
                let reason = outcome_line(message);
                completed.set("message", reason);
            }
            data.set("completed", completed);
        }
        Ok(obj! { "status" => "ok", "data" => data })
    }

    fn project(self: &Arc<Self>, input: &Json, context: &RunContext) -> Json {
        let outcome = (|| -> Result<Json, (bool, Failure)> {
            let (task, selections) = self.resolve_project_task(input)?;
            if catalog::kind(&task) == "service" && self.environment.managed_preview {
                return Ok(managed_service_result(catalog::task_id(&task)));
            }
            self.execute_project_task(&task, selections, context, &strings(input, "args"))
                .map_err(|failure| (false, failure))
        })();
        match outcome {
            Ok(result) => result,
            Err((selection, failure)) => blocked(
                if selection { "input" } else { "environment" },
                failure.message,
            ),
        }
    }

    fn resolve_project_task(&self, input: &Json) -> Result<SelectedTask, (bool, Failure)> {
        let files = self.files();
        let snapshot = files
            .snapshot(&Signal::default())
            .map_err(|failure| (false, failure))?;
        let tasks = read_task_catalog(&files.root, Some(&snapshot.files), true);
        let package_path = match text(input, "packagePath").filter(|path| !path.is_empty()) {
            Some(path) => Some(
                files
                    .normalize_path(path)
                    .map_err(|failure| (false, failure))?,
            ),
            None => None,
        };
        let scoped: Vec<&Task> = match &package_path {
            Some(path) => tasks
                .iter()
                .filter(|task| package_matches(task, path))
                .collect(),
            None => tasks.iter().collect(),
        };
        let requested = text(input, "task").unwrap_or("");
        let candidates = matching_tasks(&scoped, requested);
        if candidates.len() != 1 {
            let message = if candidates.is_empty() {
                format!("No project task matches {requested}.")
            } else {
                format!(
                    "Project task {requested} is ambiguous: {}.",
                    candidates
                        .iter()
                        .map(|task| catalog::task_id(task))
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            };
            return Err((true, Failure::new(message)));
        }
        let selected = candidates[0].clone();
        if !strings(input, "args").is_empty() && catalog::kind(&selected) != "test" {
            return Err((
                true,
                Failure::new("Extra arguments are supported only for project test tasks."),
            ));
        }
        let selections = (catalog::kind(&selected) == "test")
            .then(|| typecheck_selections(&tasks, catalog::cwd(&selected)));
        Ok((selected, selections))
    }

    fn execute_project_task(
        self: &Arc<Self>,
        task: &Task,
        selections: Option<Vec<TypecheckSelection>>,
        context: &RunContext,
        args: &[String],
    ) -> Outcome<Json> {
        let declared = task_invocation(task, args)?;
        let sequence = {
            let mut sequence = lock(&self.report_sequence);
            *sequence += 1;
            *sequence
        };
        let report = managed_test_report(task, &declared, &self.root, sequence, &context.signal)
            .map(Arc::new);
        let invocation = report
            .as_ref()
            .map_or(declared.clone(), |report| report.invocation.clone());
        let cwd = command_cwd(&self.files(), Some(&invocation.cwd))?;
        let metadata = Metadata {
            cwd: Some(catalog::cwd(task).to_string()),
            task_id: Some(catalog::task_id(task).to_string()),
            task_kind: Some(catalog::kind(task).to_string()),
            validation_scope: catalog::text(task, "validationScope").map(str::to_string),
            task_command: catalog::text(task, "command").map(str::to_string),
            typecheck_selections: selections,
            args: (!args.is_empty()).then(|| args.to_vec()),
            report,
            ..Metadata::default()
        };
        Ok(self.execute(
            &invocation.executable,
            &invocation.args,
            &cwd,
            &invocation_display(&invocation.executable, &invocation.args),
            context,
            metadata,
        ))
    }

    fn command(
        self: &Arc<Self>,
        input: &Json,
        context: &RunContext,
        replace_files: Option<ReplaceFiles<'_>>,
    ) -> Json {
        let command = text(input, "command").unwrap_or("");
        if let Some(request) = formatter::request(command) {
            let Some(replace_files) = replace_files else {
                return blocked(
                    "environment",
                    "Deterministic formatting is unavailable in this execution context.",
                );
            };
            return self.format(&request, text(input, "cwd"), context, replace_files);
        }
        if let Some(recovery) = formatter::recovery(command) {
            return blocked("input", recovery);
        }
        if let Some(denied) =
            blocked_command_reason_for(command, self.environment, context.approved)
        {
            return blocked("input", denied);
        }
        let bin = context
            .credentials
            .as_ref()
            .and_then(|credentials| credentials.get("githubCli"))
            .and_then(|cli| cli.get("binDirectory"))
            .and_then(Json::as_str)
            .filter(|bin| !bin.is_empty());
        let (executable, args) = shell_command(command, bin);
        match command_cwd(&self.files(), text(input, "cwd")) {
            Ok(cwd) => self.execute(
                &executable,
                &args,
                &cwd,
                command,
                context,
                Metadata {
                    cwd: Some(text(input, "cwd").unwrap_or(".").to_string()),
                    ..Metadata::default()
                },
            ),
            Err(failure) => blocked("environment", failure.message),
        }
    }

    fn format(
        &self,
        request: &formatter::FormatterCommand,
        input_cwd: Option<&str>,
        context: &RunContext,
        replace_files: ReplaceFiles<'_>,
    ) -> Json {
        let cwd_input = match &request.cwd {
            Some(cwd) => Some(posix_join(input_cwd.unwrap_or("."), cwd)),
            None => input_cwd.map(str::to_string),
        };
        let files = self.files();
        let cwd = match command_cwd(&files, cwd_input.as_deref()) {
            Ok(cwd) => cwd,
            Err(failure) => return blocked("environment", failure.message),
        };
        let replacements = match formatter::format(&files, request, &cwd, &context.signal) {
            Ok(replacements) => replacements,
            Err(error) => return blocked(error.category, error.message),
        };
        let result = match replace_files(&replacements, &context.signal) {
            Ok(result) => result,
            Err(failure) => return blocked("environment", failure.message),
        };
        if result.get("status").and_then(Json::as_str) != Some("ok") {
            return result;
        }
        let paths: Vec<Json> = replacements
            .iter()
            .map(|(path, _, _)| Json::from(path.as_str()))
            .collect();
        let current = self
            .record_formatter_validation(&files, &replacements)
            .unwrap_or(false);
        let mut formatted = result;
        if let Some(data) = formatted.get_mut("data") {
            data.set("mutation", "deterministic_format");
            data.set("formatter", "prettier");
            data.set("paths", Json::Arr(paths));
            if !current {
                data.set("validation", obj! { "status" => "stale", "reason" => "Source changed after formatting; run a check on the current source." });
            }
        }
        formatted
    }

    fn record_formatter_validation(
        &self,
        files: &WorkspaceFiles,
        replacements: &Replacements,
    ) -> Outcome<bool> {
        let snapshot = files.snapshot(&Signal::default())?;
        let current = replacements.iter().all(|(path, _, content)| {
            snapshot
                .file_states
                .iter()
                .find(|(known, _)| known == path)
                .map(|(_, hash)| hash.as_str())
                == Some(sha256_hex(content).as_str())
        });
        if !current {
            return Ok(false);
        }
        lock(&self.journal).record_validation(
            files,
            obj! {
                "evidenceOrigin" => "formatter_output",
                "paths" => Json::Arr(replacements.iter().map(|(path, _, _)| Json::from(path.as_str())).collect()),
                "sourceRevisionId" => snapshot.revision.source_revision_id.as_str(),
                "status" => "passed",
                "taskKind" => "lint",
            },
        )?;
        Ok(true)
    }

    fn dependency(&self, input: &Json, context: &RunContext<'_>) -> Json {
        let signal = &context.signal;
        let files = self.files();
        let request = DependencyInput {
            action: text(input, "action").unwrap_or("").to_string(),
            packages: strings(input, "packages"),
            package_path: text(input, "packagePath").map(str::to_string),
        };
        let outcome = (|| -> Outcome<Json> {
            let before = files.snapshot(signal)?;
            let result = mutate(&files, &self.session, &request, signal);
            command_changes(&files, &self.journal, &before)?;
            match result? {
                DependencyResult::Blocked { category, message } => Ok(blocked(category, message)),
                DependencyResult::Applied {
                    changed_paths,
                    output,
                } => {
                    if changed_paths.is_empty() {
                        return Ok(
                            obj! { "status" => "ok", "data" => obj! { "changed" => false, "output" => bounded_diagnostic(&output, "", 4_000) } },
                        );
                    }
                    let revision = files
                        .snapshot(&Signal::default())?
                        .revision
                        .source_revision_id;
                    lock(&self.journal).record_validation(
                        &files,
                        obj! {
                            "command" => format!("{} {}", request.action, request.packages.join(" ")),
                            "paths" => Json::Arr(changed_paths.iter().map(Json::from).collect()),
                            "sourceRevisionId" => revision,
                            "status" => "passed",
                            "taskId" => "dependency:consistency",
                            "taskKind" => "build",
                        },
                    )?;
                    // The session's preview takes the new dependencies.
                    let preview = context.refresh_preview.and_then(|refresh| refresh());
                    let data = obj! { "changed" => true, "paths" => Json::Arr(changed_paths.iter().map(Json::from).collect()), "output" => bounded_diagnostic(&output, "", 4_000) }
                        .with_opt("preview", preview);
                    Ok(obj! { "status" => "ok", "data" => data })
                }
            }
        })();
        outcome.unwrap_or_else(|failure| blocked("environment", failure.message))
    }

    /// Runs a command on its own thread: the call returns its result, or
    /// after the initial wait the first page of a managed run.
    fn execute(
        self: &Arc<Self>,
        executable: &str,
        args: &[String],
        cwd: &str,
        command: &str,
        context: &RunContext,
        metadata: Metadata,
    ) -> Json {
        // Commands take turns: one sent while another runs starts when it ends.
        let ticket = {
            let mut state = lock(&self.queue.state);
            state.0 += 1;
            state.0 - 1
        };
        {
            let mut state = lock(&self.queue.state);
            while state.1 != ticket {
                if context.signal.aborted() {
                    drop(state);
                    // Skip this ticket once its turn comes.
                    let queue = self.queue.clone();
                    thread::spawn(move || {
                        let mut state = lock(&queue.state);
                        while state.1 != ticket {
                            state = queue
                                .advanced
                                .wait(state)
                                .unwrap_or_else(|poisoned| poisoned.into_inner());
                        }
                        state.1 += 1;
                        queue.advanced.notify_all();
                    });
                    return blocked(
                        "environment",
                        "The command was cancelled while it waited for the previous command to finish.",
                    );
                }
                state = self
                    .queue
                    .advanced
                    .wait_timeout(state, Duration::from_millis(20))
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .0;
            }
        }
        let label = format!("the command `{}`", crate::text::utf16_prefix(command, 120));
        let (events, received) = mpsc::channel::<Option<CommandHandle>>();
        let completion = Arc::new(Completion::default());
        let holder_generation = Arc::new(Mutex::new(None::<turn::HolderHandle>));
        {
            let runner = self.clone();
            let (executable, args, cwd, command) = (
                executable.to_string(),
                args.to_vec(),
                cwd.to_string(),
                command.to_string(),
            );
            let credentials = context.credentials.clone();
            let signal = context.signal.clone();
            let completion = completion.clone();
            let holder_generation = holder_generation.clone();
            thread::spawn(move || {
                let result =
                    match turn::acquire(&runner.root, &runner.session, Holder { label, run: None })
                    {
                        Err(failure) => blocked("environment", failure.message),
                        Ok(guard) => {
                            *lock(&holder_generation) = Some(guard.handle());
                            let result = runner.execute_locked(
                                &executable,
                                &args,
                                &cwd,
                                &command,
                                credentials.as_ref(),
                                &signal,
                                metadata,
                                &events,
                            );
                            drop(guard);
                            result.unwrap_or_else(|failure| blocked("environment", failure.message))
                        }
                    };
                completion.set(result);
                let _ = events.send(None);
                let mut state = lock(&runner.queue.state);
                state.1 += 1;
                runner.queue.advanced.notify_all();
            });
        }
        let handle = match received.recv() {
            Ok(Some(handle)) => handle,
            _ => return completion.wait(),
        };
        let id = {
            let mut sequence = lock(&self.run_sequence);
            *sequence += 1;
            format!("r{sequence}")
        };
        if let Some(holder) = lock(&holder_generation).as_ref() {
            holder.rename(Holder {
                label: format!("run {id} (`{}`)", crate::text::utf16_prefix(command, 120)),
                run: None,
            });
        }
        let managed = Arc::new(ManagedRun {
            command: command.to_string(),
            handle,
            completion: completion.clone(),
        });
        {
            let mut runs = lock(&self.runs);
            runs.push((id.clone(), managed.clone()));
            // The latest finished runs stay readable, and every running one.
            let finished: Vec<String> = runs
                .iter()
                .filter(|(_, run)| run.completion.get().is_some())
                .map(|(id, _)| id.clone())
                .collect();
            let forget = finished.len().saturating_sub(KEPT_FINISHED_RUNS);
            runs.retain(|(known, _)| !finished[..forget].contains(known));
        }
        let finished = loop {
            match received.recv_timeout(self.initial_wait) {
                Ok(None) => break true,
                Ok(Some(_)) => continue,
                Err(mpsc::RecvTimeoutError::Timeout) => break completion.get().is_some(),
                Err(mpsc::RecvTimeoutError::Disconnected) => break true,
            }
        };
        if finished {
            return with_full_output(completion.wait(), &id);
        }
        // From here the model watches a long run; its edits wait for it.
        if let Some(holder) = lock(&holder_generation).as_ref() {
            holder.rename(Holder {
                label: format!("run {id} (`{}`)", crate::text::utf16_prefix(command, 120)),
                run: Some(id.clone()),
            });
        }
        self.run_view(&id, &managed, None)
            .unwrap_or_else(|failure| blocked("input", failure.message))
    }

    #[allow(clippy::too_many_arguments)]
    fn execute_locked(
        &self,
        executable: &str,
        args: &[String],
        cwd: &str,
        command: &str,
        credentials: Option<&Json>,
        signal: &Signal,
        metadata: Metadata,
        events: &mpsc::Sender<Option<CommandHandle>>,
    ) -> Outcome<Json> {
        signal.check()?;
        let files = self.files();
        let local = crate::pathx::relative(&files.root, cwd);
        let directory = if local.is_empty() {
            ".".to_string()
        } else {
            local
        };
        let (snapshot, validation, invocation_report, invocation_environment) = {
            let _lock = crate::commit::locked(&files)?;
            let snapshot = files.snapshot(signal)?;
            let validation = if metadata.task_id.is_some() {
                metadata.clone()
            } else {
                self.command_validation(command, &directory, &snapshot.files)
            };
            let wants_report = validation.task_kind.as_deref() == Some("test")
                && validation.report.is_none()
                && NODE_RUNNERS.is_match(validation.task_command.as_deref().unwrap_or(command));
            let invocation_report = if wants_report {
                invocation_test_report(&files.root).map(Arc::new)
            } else {
                None
            };
            let invocation_environment = (validation
                .report
                .as_ref()
                .is_some_and(|report| report.node_events.is_some())
                || invocation_report.is_some())
            .then(|| environment_manifest_evidence(&files, &snapshot.files));
            (
                snapshot,
                validation,
                invocation_report,
                invocation_environment,
            )
        };
        let extra = invocation_report
            .as_ref()
            .map(|report| report.environment.clone())
            .unwrap_or_default();
        let started = process::start(
            executable,
            args,
            CommandOptions {
                cwd: cwd.to_string(),
                environment: command_environment(&extra, credentials, executable, cwd),
                signal: signal.clone(),
                timeout_ms: DEFAULT_TIMEOUT_MS,
                maximum_output_bytes: DEFAULT_OUTPUT_LIMIT,
            },
        );
        let outcome = started.map(|handle| {
            let _ = events.send(Some(handle.clone()));
            handle.completion()
        });
        let _lock = crate::commit::locked(&files)?;
        // Another session may have written files meanwhile: they count as the
        // command's changes, and a check sees that its source moved.
        let (after, changed) = command_changes(&files, &self.journal, &snapshot)?;
        let outcome = outcome?;
        let mut merged = Metadata {
            cwd: Some(directory),
            source_revision_id: Some(snapshot.revision.source_revision_id.clone()),
            ..validation
        };
        if metadata.task_id.is_none() {
            merged.report = None;
        }
        merged.invocation_environment = invocation_environment;
        if let Some(report) = invocation_report {
            merged.invocation_report = Some(report);
            merged.invocation_snapshot = Some(Arc::new(snapshot));
        }
        self.recorded_result(&files, command, &outcome, merged, &after, &changed)
    }

    fn command_validation(&self, command: &str, cwd: &str, files: &[String]) -> Metadata {
        let tasks = read_task_catalog(&self.root, Some(files), true);
        let matches_command = |task: &Task| {
            let manager = catalog::text(task, "package_manager").unwrap_or("undefined");
            let script = catalog::text(task, "script").unwrap_or("undefined");
            Some(command) == catalog::text(task, "command")
                || command == format!("{manager} run {script}")
                || command == format!("{manager} {script}")
        };
        let task = tasks.iter().find(|task| {
            catalog::cwd(task) == cwd
                && is_validation_kind(Some(catalog::kind(task)))
                && matches_command(task)
        });
        let mut metadata = Metadata::default();
        match task {
            Some(task) => {
                metadata.task_id = Some(catalog::task_id(task).to_string());
                metadata.task_kind = Some(catalog::kind(task).to_string());
                metadata.validation_scope =
                    catalog::text(task, "validationScope").map(str::to_string);
            }
            None => match project_test_command(command, cwd, &tasks) {
                Some((task_id, args)) => {
                    metadata.task_id = Some(task_id);
                    metadata.task_kind = Some("test".into());
                    metadata.args = (!args.is_empty()).then_some(args);
                }
                None => {
                    if std::env::var("BLAME_AGENT_LITERAL_COMPILER_REPAIR").as_deref()
                        != Ok("false")
                        && plain_compiler_check(command)
                    {
                        metadata.task_kind = Some("typecheck".into());
                        metadata.validation_scope = Some("invocation_only".into());
                    }
                    return metadata;
                }
            },
        }
        let task_id = metadata.task_id.clone().unwrap_or_default();
        let matches: Vec<&Task> = tasks
            .iter()
            .filter(|task| catalog::task_id(task) == task_id && catalog::cwd(task) == cwd)
            .collect();
        metadata.typecheck_selections = Some(typecheck_selections(&tasks, cwd));
        metadata.task_command = (matches.len() == 1).then(|| {
            catalog::text(matches[0], "command")
                .unwrap_or("")
                .to_string()
        });
        metadata
    }

    fn assessment(
        &self,
        files: &WorkspaceFiles,
        output: &str,
        task_kind: Option<&str>,
        exit_code: Option<i32>,
    ) -> Assessment {
        command_failure_assessment(
            output,
            || {
                files
                    .snapshot(&Signal::default())
                    .map(|snapshot| declared_dependencies(files, &snapshot.files))
                    .unwrap_or_default()
            },
            task_kind,
            exit_code,
        )
    }

    fn recorded_result(
        &self,
        files: &WorkspaceFiles,
        command: &str,
        result: &CommandOutcome,
        metadata: Metadata,
        after: &WorkspaceSnapshot,
        changed: &[String],
    ) -> Outcome<Json> {
        let output = redacted_output(&result.all);
        let cwd = metadata.cwd.clone().unwrap_or_else(|| ".".into());
        let after_revision = after.revision.source_revision_id.clone();
        let kind = metadata.task_kind.as_deref();
        if kind == Some("test") || (kind != Some("typecheck") && is_test_invocation(command)) {
            // Counts come from this process's output, read through the exact
            // catalog script when an npm wrapper hides the runner's name.
            let report = metadata.report.as_ref().and_then(|report| report.read());
            let node_events = metadata
                .report
                .as_ref()
                .and_then(|report| report.node_events.clone());
            let presented_result = CommandResult {
                all: &output,
                exit_code: result.exit_code,
                failed: result.failed,
                interruption: result.interruption,
            };
            let changed_source =
                Some(after_revision.as_str()) != metadata.source_revision_id.as_deref();
            let (attributed, single): (Option<Vec<String>>, bool) = match (&node_events, &report) {
                (Some(_), _) | (None, None) => (None, false),
                (None, Some(ReportSources::One(source))) => (Some(vec![source.clone()]), true),
                (None, Some(ReportSources::Many(sources))) => (Some(sources.clone()), false),
            };
            let binding = node_events
                .as_ref()
                .map(|(invocation_id, reporter)| NodeEventBinding {
                    report: match &report {
                        Some(ReportSources::One(source)) => Some(source.clone()),
                        _ => None,
                    },
                    invocation_id: invocation_id.clone(),
                    reporter_sha256: reporter.clone(),
                });
            let mut check = observe_check(
                metadata.task_command.as_deref().unwrap_or(command),
                &presented_result,
                &cwd,
                changed_source,
                attributed.as_deref(),
                single,
                binding.as_ref(),
            );
            if let Some(mut evidence) = check.get("evidence").cloned() {
                evidence.set("command", command);
                evidence.set("cwd", cwd.as_str());
                if let Some(task_id) = &metadata.task_id {
                    evidence.set("taskId", task_id.as_str());
                }
                evidence.set(
                    "args",
                    Json::Arr(
                        metadata
                            .args
                            .clone()
                            .unwrap_or_default()
                            .into_iter()
                            .map(Json::from)
                            .collect(),
                    ),
                );
                evidence.set(
                    "invocationSourceRevisionId",
                    metadata
                        .source_revision_id
                        .clone()
                        .map_or(Json::Null, Json::from),
                );
                evidence.set("completedSourceRevisionId", after_revision.as_str());
                if let Some(before) = &metadata.invocation_environment {
                    evidence.set("manifestEnvironment", obj! { "before" => before.clone(), "after" => environment_manifest_evidence(files, &after.files) });
                }
                check.set("evidence", evidence);
            }
            let observed = match (&metadata.invocation_report, &metadata.invocation_snapshot) {
                (Some(report), Some(snapshot)) => report.read(&files.root, snapshot, after),
                _ => None,
            };
            if let Some((report, evidence)) = observed {
                let environment_after = metadata
                    .invocation_environment
                    .as_ref()
                    .map(|_| environment_manifest_evidence(files, &after.files));
                let counts = report.counts;
                check.set("counts", counts.to_json());
                check.set(
                    "execution",
                    if counts.executed > 0 {
                        "observed"
                    } else {
                        "zero_tests"
                    },
                );
                let reported_files = evidence
                    .get("reportedFileCount")
                    .and_then(Json::as_f64)
                    .unwrap_or(0.0);
                let outcome = if result.interruption.is_some() {
                    "unknown"
                } else if counts.failed > 0 || (report.setup_failed && reported_files > 0.0) {
                    "failed"
                } else if counts.executed == 0 {
                    "unknown"
                } else if report.setup_failed {
                    "failed"
                } else if result.exit_code == Some(0) {
                    "passed"
                } else {
                    "unknown"
                };
                check.set("outcome", outcome);
                check.set("evidenceOrigin", "vitest_report");
                let mut evidence = evidence;
                evidence.set("command", command);
                evidence.set("cwd", cwd.as_str());
                evidence.set(
                    "invocationSourceRevisionId",
                    metadata
                        .source_revision_id
                        .clone()
                        .map_or(Json::Null, Json::from),
                );
                evidence.set("completedSourceRevisionId", after_revision.as_str());
                if let Some(before) = &metadata.invocation_environment {
                    evidence.set(
                        "manifestEnvironment",
                        obj! {
                            "beforeRevisionId" => before.get("revisionId").cloned().unwrap_or(Json::Null),
                            "afterRevisionId" => environment_after.and_then(|after| after.get("revisionId").cloned()).unwrap_or(Json::Null),
                            "boundary" => "Manifest/lock hashes only; installed dependencies and full environment are unknown.",
                        },
                    );
                }
                check.set("evidence", evidence);
            }
            let outcome = check
                .get("outcome")
                .and_then(Json::as_str)
                .unwrap_or("unknown")
                .to_string();
            let failure = if check.get("selectionFailure").and_then(Json::as_str)
                == Some("no_test_files")
            {
                Some(Assessment {
                    category: "command",
                    recovery: format!(
                        "Vitest reported no selected test files from {cwd}. Resolve paths and filters from this working directory and inspect include/exclude settings, then rerun the intended selection. This failed invocation verifies no code; a different passing selection does not satisfy an explicitly required invocation."
                    ),
                })
            } else if outcome == "failed" {
                Some(self.assessment(files, &output, Some("test"), result.exit_code))
            } else {
                None
            };
            let recorded = Metadata {
                task_kind: Some("test".into()),
                check: Some(check.clone()),
                ..metadata.clone()
            };
            self.record_command_validation(
                files,
                command,
                if outcome == "failed" {
                    "failed"
                } else {
                    "unknown"
                },
                after,
                &recorded,
                failure.as_ref(),
            )?;
            let mut presented = validation_output(&self.root, &output);
            if failure.is_some() || !changed.is_empty() {
                presented.set("output", command_output(&output));
            }
            if check.get("evidenceOrigin").and_then(Json::as_str) == Some("node_events")
                && let Some(counts) = check.get("counts")
            {
                let count = |key: &str| counts.get(key).map(Json::stringify).unwrap_or_default();
                let shown = format!(
                    "{}\nActive Node case results: {} passed, {} failed, {} skipped/todo. File workers and suites are excluded. Command outcome: {outcome}. Test scope, selection and freshness are not admitted by these counts.",
                    presented.get("output").and_then(Json::as_str).unwrap_or(""),
                    count("passed"),
                    count("failed"),
                    count("skipped")
                );
                presented.set("output", shown);
            }
            let changed_paths = lock(&self.journal).current_changed_paths(files);
            let script = metadata.task_command.as_deref().map(redacted_output);
            let args: Vec<String> = metadata
                .args
                .clone()
                .unwrap_or_default()
                .iter()
                .map(|arg| redacted_output(arg))
                .collect();
            let scope = runtime_test_scope(
                &check,
                script.as_deref(),
                &args,
                &changed_paths,
                metadata.typecheck_selections.as_deref().unwrap_or(&[]),
            );
            let mut reporting = check_reporting(&check, true);
            reporting.set(
                "invocationSourceRevisionId",
                metadata
                    .source_revision_id
                    .clone()
                    .map_or(Json::Null, Json::from),
            );
            reporting.set("completedSourceRevisionId", after_revision.as_str());
            reporting.set("cwd", cwd.as_str());
            let freshness = check.get("freshness").and_then(Json::as_str) == Some("stale");
            let mut data = obj! { "command" => command }.with_opt("exitCode", result.exit_code);
            data.extend(presented);
            let data = data
                .with_opt("failure", failure.as_ref().map(|failure| obj! { "category" => failure.category, "recovery" => failure.recovery.as_str() }))
                .with("check", check)
                .with("reporting", reporting)
                .with("changed", !changed.is_empty())
                .with("paths", Json::Arr(changed.iter().map(Json::from).collect()))
                .with("validation", obj! { "status" => if freshness { "stale" } else if outcome == "failed" { "failed" } else { "unknown" } })
                .with_opt("testValidationScope", scope);
            return Ok(obj! { "status" => "ok", "data" => data });
        }
        if kind.is_none()
            && changed.is_empty()
            && let Some(inspection) = read_only_inspection(command)
        {
            return Ok(self.inspection_result(files, command, result, &output, inspection));
        }
        let status = if result.failed { "failed" } else { "passed" };
        let failure = if result.interruption.is_some() {
            Some(command_failure())
        } else if result.failed {
            Some(self.assessment(files, &output, kind, result.exit_code))
        } else {
            None
        };
        if Some(after_revision.as_str()) != metadata.source_revision_id.as_deref() {
            if let Some(failure) = &failure {
                if is_validation_kind(kind) {
                    self.record_command_validation(
                        files,
                        command,
                        "failed",
                        after,
                        &metadata,
                        Some(failure),
                    )?;
                }
                return Ok(failed_command_result(
                    result.exit_code,
                    &output,
                    failure,
                    Some(command),
                ));
            }
            return Ok(obj! {
                "status" => "ok",
                "data" => obj! { "changed" => !changed.is_empty(), "paths" => Json::Arr(changed.iter().map(Json::from).collect()) }
                    .with_opt("exitCode", result.exit_code)
                    .with("output", command_output(&output))
                    .with("validation", obj! { "status" => "stale", "reason" => "Source changed during execution; run a check on the resulting code to verify it." }),
            });
        }
        let paths = self.record_command_validation(
            files,
            command,
            status,
            after,
            &metadata,
            failure.as_ref(),
        )?;
        if let Some(failure) = &failure {
            return Ok(failed_command_result(
                result.exit_code,
                &output,
                failure,
                Some(command),
            ));
        }
        let proof = is_validation_kind(kind).then(|| {
            obj! {
                "paths" => Json::Arr(paths.iter().map(Json::from).collect()),
                "sourceRevisionId" => after_revision.as_str(),
                "status" => "passed",
            }
            .with_opt("taskId", metadata.task_id.as_deref())
            .with_opt("taskKind", kind)
            .with_opt("scope", metadata.validation_scope.as_deref())
        });
        let shown = if proof.is_some() {
            validation_output(&self.root, &output)
        } else {
            obj! { "output" => command_output(&output) }
        };
        let mut data = obj! { "command" => command }.with_opt("exitCode", result.exit_code);
        data.extend(shown);
        Ok(
            obj! { "status" => "ok", "data" => data.with("environment", target()).with_opt("validation", proof) },
        )
    }

    /// Read-only inspection is no validation evidence: it stays out of the
    /// check journal, and grep's exit 1 ("no line matched") is no failure.
    fn inspection_result(
        &self,
        files: &WorkspaceFiles,
        command: &str,
        result: &CommandOutcome,
        output: &str,
        inspection: &str,
    ) -> Json {
        // Exit 141: a reader such as `head` closed the pipe once it had
        // enough, and pipefail reports the writer's SIGPIPE.
        let pipe_closed = result.exit_code == Some(141) && command.contains('|');
        let tolerated = result.exit_code == Some(0)
            || pipe_closed
            || (inspection == "search" && result.exit_code == Some(1));
        if result.interruption.is_some() || !tolerated {
            let failure = if result.interruption.is_some() {
                command_failure()
            } else {
                self.assessment(files, output, None, result.exit_code)
            };
            return failed_command_result(result.exit_code, output, &failure, None);
        }
        let data = obj! { "command" => command }
            .with_opt("exitCode", result.exit_code)
            .with_opt(
                "noMatch",
                (result.exit_code == Some(1) && !exit_from_other_stage(command, output))
                    .then_some(true),
            )
            .with_opt("pipeClosedEarly", pipe_closed.then_some(true))
            .with("output", command_output(output))
            .with("environment", target())
            .with_opt(
                "guidance",
                (SOURCE_INSPECTION.is_match(command) && !command.contains("node_modules"))
                    .then_some("search_code (regex, files output, context lines) and read_code (line ranges) answer source inspection with sN aliases and read coverage."),
            );
        obj! { "status" => "ok", "data" => data }
    }

    fn record_command_validation(
        &self,
        files: &WorkspaceFiles,
        command: &str,
        status: &str,
        after: &WorkspaceSnapshot,
        metadata: &Metadata,
        failure: Option<&Assessment>,
    ) -> Outcome<Vec<String>> {
        let mut journal = lock(&self.journal);
        let paths = if metadata.validation_scope.as_deref() == Some("invocation_only") {
            Vec::new()
        } else {
            validation_scope_paths(
                &journal.current_changed_paths(files),
                &after.files,
                metadata.cwd.as_deref().unwrap_or("."),
            )
        };
        let input = obj! {}
            .with_opt("scope", metadata.validation_scope.as_deref())
            .with("command", command)
            .with_opt("cwd", metadata.cwd.as_deref())
            .with("paths", Json::Arr(paths.iter().map(Json::from).collect()))
            .with(
                "sourceRevisionId",
                metadata
                    .source_revision_id
                    .clone()
                    .unwrap_or_else(|| after.revision.source_revision_id.clone()),
            )
            .with("status", status)
            .with_opt("taskId", metadata.task_id.as_deref())
            .with_opt("taskKind", metadata.task_kind.as_deref())
            .with_opt("check", metadata.check.clone())
            .with_opt(
                "args",
                metadata
                    .args
                    .as_ref()
                    .filter(|args| !args.is_empty())
                    .map(|args| Json::Arr(args.iter().map(Json::from).collect())),
            )
            .with_opt("category", failure.map(|failure| failure.category))
            .with_opt("recovery", failure.map(|failure| failure.recovery.as_str()));
        journal.record_validation(files, input)?;
        Ok(paths)
    }
}

static NODE_RUNNERS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?-u:\b)(?:node|vitest|npm|pnpm|yarn|bun)(?-u:\b)").expect("pattern")
});
static SOURCE_INSPECTION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?-u:\b)(?:grep|rg|cat|sed|head|tail)(?-u:\b)").expect("pattern")
});

/// A result whose output was cut says how to page the whole of it.
/// A failed result's message without the output it quotes: its first line,
/// without the sentence that introduces the quoted output.
fn outcome_line(message: &str) -> String {
    let first = message.split('\n').next().unwrap_or("");
    match first.strip_suffix(':') {
        Some(introduced) => introduced
            .rfind(". ")
            .map_or(introduced, |end| &introduced[..=end])
            .trim_end()
            .to_string(),
        None => first.to_string(),
    }
}
fn with_full_output(mut result: Json, id: &str) -> Json {
    let text = result.stringify();
    if !text.contains("diagnostic truncated") && !text.contains(COMMAND_OUTPUT_OMITTED) {
        return result;
    }
    let full = obj! { "kind" => "inspect", "run" => id, "cursor" => "0", "until" => "now" };
    if result.get("status").and_then(Json::as_str) == Some("ok") {
        if let Some(data) = result.get_mut("data") {
            data.set("fullOutput", full);
        }
    } else {
        result.set("fullOutput", full);
    }
    result
}
/// A run's result without the command its inspection already names.
fn without_command(mut result: Json, command: &str) -> Json {
    if let Some(data) = result.get_mut("data")
        && data.get("command").and_then(Json::as_str) == Some(command)
    {
        data.remove("command");
    }
    result
}

fn managed_service_result(task_id: &str) -> Json {
    blocked("environment", format!("Project task {task_id} is a long-running service managed by the preview runtime."))
        .with("recovery", "Inspect the managed preview once when visual evidence matters. Do not start a replacement server or database from run_task.")
}

fn matching_tasks<'a>(tasks: &[&'a Task], requested: &str) -> Vec<&'a Task> {
    let identified: Vec<&Task> = tasks
        .iter()
        .copied()
        .filter(|task| catalog::task_id(task) == requested)
        .collect();
    if !identified.is_empty() {
        return identified;
    }
    let scripted: Vec<&Task> = tasks
        .iter()
        .copied()
        .filter(|task| catalog::text(task, "script") == Some(requested))
        .collect();
    if !scripted.is_empty() {
        return scripted;
    }
    tasks
        .iter()
        .copied()
        .filter(|task| catalog::kind(task) == requested)
        .collect()
}

static MANIFEST_SUFFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:^|/)package\.json$").expect("pattern"));

fn package_matches(task: &Task, package_path: &str) -> bool {
    let normalized = MANIFEST_SUFFIX.replace(package_path, "");
    let normalized = normalized.strip_suffix('/').unwrap_or(&normalized);
    let normalized = if normalized.is_empty() {
        "."
    } else {
        normalized
    };
    catalog::cwd(task) == normalized
        || catalog::task_id(task).starts_with(&format!("{normalized}:"))
}

fn posix_join(base: &str, path: &str) -> String {
    let joined = format!("{base}/{path}");
    let mut parts: Vec<&str> = Vec::new();
    for part in joined.split('/') {
        match part {
            "" | "." => {}
            ".." if parts.last().is_some_and(|last| *last != "..") => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    let joined = parts.join("/");
    if base.starts_with('/') {
        format!("/{joined}")
    } else if joined.is_empty() {
        ".".into()
    } else {
        joined
    }
}
