//! finish_task (`light-finish-service.ts`, `light-completion.ts`,
//! `project-memory.ts`): the completion decision on the session's current
//! changes and checks. Relevant checks are refreshed first: literal
//! no-emit compiler repairs, the checks already requested for each changed
//! package, and the task contract's required checks. The decision, the
//! validation report and a project memory candidate go in the notification.

use crate::checks::{
    check_invocation_key, current_validation_report, failed_literal_compiler_invocations,
    latest_failed_invocations,
};
use crate::failure::{Failure, Outcome, Signal};
use crate::files::WorkspaceFiles;
use crate::identity::sha256_hex;
use crate::journal::SessionJournal;
use crate::json::Json;
use crate::obj;
use crate::run::catalog::{self, Task, read_task_catalog};
use crate::run::output::validation_scope_paths;
use crate::run::runner::{RunContext, TaskRunner};
use crate::text::js_trim;
use crate::workspace::lock;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const CHECK_KINDS: [&str; 4] = ["build", "test", "typecheck", "lint"];

fn text<'a>(value: &'a Json, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Json::as_str)
}

fn array(value: &Json, key: &str) -> Vec<Json> {
    value
        .get(key)
        .and_then(Json::as_array)
        .cloned()
        .unwrap_or_default()
}

fn strings(value: &Json, key: &str) -> Vec<String> {
    array(value, key)
        .iter()
        .filter_map(Json::as_str)
        .map(str::to_string)
        .collect()
}

/// A final validation: a project task (with args for a test) or a literal
/// no-emit compiler command.
#[derive(Clone, Debug)]
struct Selection {
    input: Json,
    paths: Vec<String>,
    cwd: String,
}

#[derive(Clone, Debug)]
struct Required {
    id: String,
    cwd: String,
    task_kind: String,
    input: Json,
}

fn task_of(input: &Json) -> String {
    text(input, "task").unwrap_or("").to_string()
}

fn args_of(input: &Json) -> Option<Vec<String>> {
    input.get("args").and_then(Json::as_array).map(|args| {
        args.iter()
            .filter_map(Json::as_str)
            .map(str::to_string)
            .collect()
    })
}

fn args_json(args: &Option<Vec<String>>) -> String {
    Json::Arr(
        args.clone()
            .unwrap_or_default()
            .into_iter()
            .map(Json::from)
            .collect(),
    )
    .stringify()
}

/// `sameInvocation`: the validation ran this task, in this cwd, with these args.
fn same_invocation(validation: &Json, input: &Json, cwd: &str) -> bool {
    text(validation, "taskId") == Some(task_of(input).as_str())
        && text(validation, "cwd").unwrap_or(".") == cwd
        && args_json(&args_of(validation)) == args_json(&args_of(input))
}

fn invocation_key(input: &Json, cwd: &str) -> String {
    let mut value = obj! { "taskId" => task_of(input), "cwd" => cwd };
    if let Some(args) = input.get("args") {
        value.set("args", args.clone());
    }
    check_invocation_key(&value)
}

/// An execution obligation only; never promotes unknown test scope.
fn passed_execution(validation: &Json, task_kind: &str) -> bool {
    if text(validation, "taskKind") != Some(task_kind) {
        return false;
    }
    if task_kind == "test" {
        let check = validation.get("check");
        let field = |key: &str| {
            check
                .and_then(|check| check.get(key))
                .and_then(Json::as_str)
        };
        return field("process") == Some("exited")
            && field("execution") == Some("observed")
            && field("outcome") == Some("passed");
    }
    text(validation, "status") == Some("passed") && text(validation, "terminal") == Some("passed")
}

fn has_passing_validation(validations: &[Json], changed: &[String], task_ids: &[String]) -> bool {
    if task_ids.is_empty() || changed.is_empty() {
        return false;
    }
    let covered: Vec<String> = validations
        .iter()
        .filter(|validation| {
            text(validation, "status") == Some("passed")
                && text(validation, "terminal") == Some("passed")
                && task_ids
                    .iter()
                    .any(|id| Some(id.as_str()) == text(validation, "taskId").or(Some("")))
        })
        .flat_map(|validation| strings(validation, "paths"))
        .collect();
    changed.iter().all(|path| covered.contains(path))
}

fn has_unavailable_validation(validations: &[Json], changed: &[String], task_id: &str) -> bool {
    validations.iter().any(|validation| {
        let paths = strings(validation, "paths");
        text(validation, "category") == Some("environment")
            && text(validation, "status") == Some("failed")
            && text(validation, "terminal") == Some("failed")
            && text(validation, "taskId") == Some(task_id)
            && changed.iter().all(|path| paths.contains(path))
    })
}

fn assert_no_failed_validation(state: &Json) -> Outcome<()> {
    let failed: Vec<String> = array(state, "validations")
        .iter()
        .filter(|validation| {
            text(validation, "terminal") == Some("failed")
                && text(validation, "category") == Some("code")
                && CHECK_KINDS.contains(&text(validation, "taskKind").unwrap_or(""))
        })
        .map(|validation| {
            text(validation, "taskId")
                .or(text(validation, "command"))
                .unwrap_or("undefined")
                .to_string()
        })
        .collect();
    if failed.is_empty() {
        return Ok(());
    }
    Err(Failure::new(format!(
        "Current validation is still failing: {}. Resolve it and run the relevant check before finishing.",
        failed.join(", ")
    )))
}

/// The session's finish: one per finish_task call, on its own journal and
/// runner, as `LightFinishService` builds them.
pub struct FinishService {
    files: WorkspaceFiles,
    session: String,
    contract: Json,
    journal: Arc<Mutex<SessionJournal>>,
    tasks: Arc<TaskRunner>,
    sequence: usize,
    pub activities: Vec<Json>,
    pub notification: Option<Json>,
}

impl FinishService {
    pub fn new(root: &str, session: &str, contract: &Json) -> FinishService {
        let files = WorkspaceFiles::new(root);
        let journal = Arc::new(Mutex::new(SessionJournal::new(&files.root, session)));
        let tasks = Arc::new(TaskRunner::new(
            &files.root,
            session,
            &Json::Null,
            journal.clone(),
        ));
        FinishService {
            files,
            session: session.to_string(),
            contract: contract.clone(),
            journal,
            tasks,
            sequence: 0,
            activities: Vec::new(),
            notification: None,
        }
    }

    fn completion_snapshot(&self) -> Outcome<Json> {
        let _turn = crate::turn::acquire(
            &self.files.root,
            &self.session,
            crate::turn::Holder {
                label: "an edit or a read".into(),
                run: None,
            },
        )?;
        let _lock = crate::commit::locked(&self.files)?;
        lock(&self.journal).completion_snapshot(&self.files, &Signal::default())
    }

    fn validations(&self) -> Vec<Json> {
        lock(&self.journal).current_validations()
    }

    pub fn finish(
        &mut self,
        summary: &str,
        images: Vec<Json>,
        tool_call: Option<&str>,
        signal: &Signal,
    ) -> Outcome<String> {
        let initial = self.completion_snapshot()?;
        let changed = strings(&initial, "changedPaths");
        if text(&self.contract, "effect_requirement") == Some("source_change") && changed.is_empty()
        {
            return Err(Failure::new("Completion requires a current source change."));
        }
        assert_no_failed_validation(&initial)?;
        let (task_ids, required, unsettled) =
            self.validate_if_needed(&initial, tool_call, signal)?;
        let current = self.completion_snapshot()?;
        assert_no_failed_validation(&current)?;
        let validations = array(&current, "validations");
        let changed = strings(&current, "changedPaths");
        let obligations: Vec<(String, bool)> = required
            .iter()
            .map(|requirement| {
                (
                    format!("check:{}", requirement.id),
                    validations.iter().any(|item| {
                        same_invocation(item, &requirement.input, &requirement.cwd)
                            && passed_execution(item, &requirement.task_kind)
                    }),
                )
            })
            .collect();
        let scope_verified = if !changed.is_empty() {
            has_passing_validation(&validations, &changed, task_ids.as_deref().unwrap_or(&[]))
        } else {
            !required.is_empty()
                && required.iter().all(|requirement| {
                    validations.iter().any(|item| {
                        same_invocation(item, &requirement.input, &requirement.cwd)
                            && text(item, "status") == Some("passed")
                            && text(item, "terminal") == Some("passed")
                    })
                })
        };
        let verified = scope_verified && obligations.iter().all(|(_, passed)| *passed);
        let unavailable = (!changed.is_empty() || !required.is_empty()) && !verified;
        let revision = text(&current, "sourceRevisionId").unwrap_or("").to_string();
        let observed_passing_test = validations.iter().any(|item| {
            text(item, "sourceRevisionId") == Some(revision.as_str())
                && passed_execution(item, "test")
        });
        let decision = completion_decision(
            &revision,
            verified,
            unavailable,
            changed.is_empty() && required.is_empty(),
            &obligations,
            observed_passing_test,
            unsettled,
        );
        let validation_task = task_ids.unwrap_or_default().into_iter().find(|task| {
            has_passing_validation(&validations, &changed, std::slice::from_ref(task))
        });
        lock(&self.journal).record_terminal_summary(
            if unavailable {
                "completed_with_validation_unavailable"
            } else {
                "completed"
            },
            Some(summary),
        )?;
        let memory = if verified {
            validation_task
                .as_deref()
                .and_then(|task| self.completion_memory(summary, &current, task))
        } else {
            None
        };
        let report = current_validation_report(&current, &self.validations());
        self.notification = Some(
            obj! { "completion" => decision }
                .with_opt(
                    "images",
                    (!images.is_empty()).then(|| Json::Arr(images.clone())),
                )
                .with_opt("memory", memory)
                .with("submission_outcome", "accepted")
                .with("validationReport", report)
                .with("summary", summary)
                .with("verified", verified),
        );
        Ok(summary.to_string())
    }

    fn required_inputs(&self) -> Outcome<Vec<Required>> {
        let checks = array(&self.contract, "required_checks");
        validate_required_checks(&checks)?;
        if checks.is_empty() {
            return Ok(Vec::new());
        }
        let snapshot = self.files.snapshot(&Signal::default())?;
        let tasks = read_task_catalog(&self.files.root, Some(&snapshot.files), true);
        let mut required = Vec::new();
        for check in &checks {
            let id = text(check, "id").unwrap_or("");
            let task = js_trim(text(check, "task").unwrap_or("")).to_string();
            let matches: Vec<&Task> = tasks
                .iter()
                .filter(|item| catalog::task_id(item) == task)
                .collect();
            if matches.len() != 1 || !CHECK_KINDS.contains(&catalog::kind(matches[0])) {
                return Err(Failure::new(format!(
                    "Required check {id} needs an exact build/test/typecheck/lint catalog ID: {task}."
                )));
            }
            let item = matches[0];
            let args = strings(check, "args");
            if !args.is_empty() && catalog::kind(item) != "test" {
                return Err(Failure::new(format!(
                    "Required check {id}: extra argv is supported only for test tasks."
                )));
            }
            let input = obj! { "kind" => "project", "task" => task.as_str() }.with_opt(
                "args",
                (catalog::kind(item) == "test")
                    .then(|| Json::Arr(args.iter().map(Json::from).collect())),
            );
            required.push(Required {
                id: id.to_string(),
                cwd: catalog::cwd(item).to_string(),
                task_kind: catalog::kind(item).to_string(),
                input,
            });
        }
        Ok(required)
    }

    /// Refreshes what the final source needs: `(task ids, required, unsettled)`.
    #[allow(clippy::type_complexity)]
    fn validate_if_needed(
        &mut self,
        state: &Json,
        tool_call: Option<&str>,
        signal: &Signal,
    ) -> Outcome<(Option<Vec<String>>, Vec<Required>, bool)> {
        let required = self.required_inputs()?;
        let changed = strings(state, "changedPaths");
        if changed.is_empty() && required.is_empty() {
            return Ok((None, Vec::new(), false));
        }
        let mut unsettled = false;
        // A direct no-emit compiler is a repair lead, never a substitute for
        // a project obligation: refresh it first, never arbitrary shell.
        for failed in failed_literal_compiler_invocations(&self.validations()) {
            if text(&failed, "category") != Some("code") {
                continue;
            }
            let input =
                obj! { "kind" => "command", "command" => text(&failed, "command").unwrap_or("") }
                    .with_opt("cwd", text(&failed, "cwd").filter(|cwd| *cwd != "."));
            match self.run_settled(&input, tool_call, signal)? {
                None => unsettled = true,
                Some(result) => {
                    if blocked_code(&result) {
                        return Err(Failure::new(text(&result, "message").unwrap_or("")));
                    }
                    assert_no_failed_validation(&self.completion_snapshot()?)?;
                }
            }
        }
        let mut inputs = self.validation_inputs(&changed)?;
        for selection in &required {
            if !inputs.iter().any(|item| {
                same_invocation(
                    &obj! { "taskId" => task_of(&item.input), "cwd" => item.cwd.as_str() }
                        .with_opt("args", item.input.get("args").cloned()),
                    &selection.input,
                    &selection.cwd,
                )
            }) {
                inputs.push(Selection {
                    input: selection.input.clone(),
                    paths: changed.clone(),
                    cwd: selection.cwd.clone(),
                });
            }
        }
        let failed_keys: Vec<String> = latest_failed_invocations(&self.validations())
            .iter()
            .map(check_invocation_key)
            .collect();
        // Failed selections first, a stable order within each group.
        inputs.sort_by_key(|item| !failed_keys.contains(&invocation_key(&item.input, &item.cwd)));
        let validations = array(state, "validations");
        let pending = inputs
            .iter()
            .filter(|item| {
                item.input.get("args").is_some()
                    && !validations
                        .iter()
                        .any(|validation| same_invocation(validation, &item.input, &item.cwd))
            })
            .count();
        if pending > 16 {
            return Err(Failure::new(
                "Automatic validation refresh is limited to 16 test selections. Refresh the requested tests with run_task before finishing.",
            ));
        }
        for item in &inputs {
            let matching: Vec<Json> = validations
                .iter()
                .filter(|validation| same_invocation(validation, &item.input, &item.cwd))
                .cloned()
                .collect();
            let requirement = required.iter().find(|selection| {
                same_invocation(
                    &obj! { "taskId" => task_of(&item.input), "cwd" => item.cwd.as_str() }
                        .with_opt("args", item.input.get("args").cloned()),
                    &selection.input,
                    &selection.cwd,
                )
            });
            let task = task_of(&item.input);
            // Failed selection evidence and a missing exact obligation stay:
            // repeating an unavailable discovery cannot validate the source.
            let no_test_files = matching.iter().any(|validation| {
                text(validation, "category") == Some("command")
                    && validation
                        .get("check")
                        .and_then(|check| check.get("selectionFailure"))
                        .and_then(Json::as_str)
                        == Some("no_test_files")
                    && text(validation, "terminal") == Some("failed")
            });
            let skip = no_test_files
                || requirement.is_some_and(|requirement| {
                    matching
                        .iter()
                        .any(|validation| passed_execution(validation, &requirement.task_kind))
                })
                || (requirement.is_none()
                    && has_passing_validation(&matching, &item.paths, std::slice::from_ref(&task)))
                || has_unavailable_validation(&matching, &item.paths, &task)
                || (requirement.is_some()
                    && matching.iter().any(|validation| {
                        text(validation, "category") == Some("environment")
                            && text(validation, "status") == Some("failed")
                            && text(validation, "terminal") == Some("failed")
                    }))
                || matching
                    .iter()
                    .any(|validation| text(validation, "status") == Some("unknown"));
            if skip {
                continue;
            }
            match self.run_settled(&item.input, tool_call, signal)? {
                None => unsettled = true,
                Some(result) => {
                    if blocked_code(&result) {
                        return Err(Failure::new(text(&result, "message").unwrap_or("")));
                    }
                    // No round on green checks while a refreshed code failure blocks.
                    assert_no_failed_validation(&self.completion_snapshot()?)?;
                }
            }
        }
        Ok((
            Some(inputs.iter().map(|item| task_of(&item.input)).collect()),
            required,
            unsettled,
        ))
    }

    /// The checks already requested for each changed package.
    fn validation_inputs(&self, changed: &[String]) -> Outcome<Vec<Selection>> {
        let snapshot = self.files.snapshot(&Signal::default())?;
        let observations = self.validations();
        let attempted: Vec<Option<&str>> = observations
            .iter()
            .map(|validation| text(validation, "taskId"))
            .collect();
        let tasks: Vec<Task> = read_task_catalog(&self.files.root, Some(&snapshot.files), true)
            .into_iter()
            .filter(|task| attempted.contains(&Some(catalog::task_id(task))))
            .collect();
        let mut scopes: Vec<String> = Vec::new();
        for task in &tasks {
            if !scopes.iter().any(|cwd| cwd == catalog::cwd(task)) {
                scopes.push(catalog::cwd(task).to_string());
            }
        }
        let failed: Vec<String> = latest_failed_invocations(&observations)
            .iter()
            .filter(|validation| {
                text(validation, "terminal") == Some("failed")
                    && text(validation, "category") == Some("code")
                    && CHECK_KINDS.contains(&text(validation, "taskKind").unwrap_or(""))
            })
            .filter_map(|validation| text(validation, "taskId").map(str::to_string))
            .collect();
        let mut selections = Vec::new();
        for cwd in scopes {
            let paths = validation_scope_paths(changed, &snapshot.files, &cwd);
            if paths.is_empty() {
                continue;
            }
            let scoped: Vec<&Task> = tasks
                .iter()
                .filter(|task| catalog::cwd(task) == cwd)
                .collect();
            let chosen = select_validation_task(&scoped, &paths);
            let mut required: Vec<&Task> = scoped
                .iter()
                .copied()
                .filter(|task| failed.iter().any(|id| id == catalog::task_id(task)))
                .collect();
            if let Some(chosen) = chosen
                && !required
                    .iter()
                    .any(|task| catalog::task_id(task) == catalog::task_id(chosen))
            {
                required.push(chosen);
            }
            // Every literal test selection of the package stays: one catalog
            // id cannot represent two filters of the same test task.
            let mut package: Vec<(String, Selection)> = Vec::new();
            let mut put = |key: String, selection: Selection| match package
                .iter_mut()
                .find(|(known, _)| *known == key)
            {
                Some(slot) => slot.1 = selection,
                None => package.push((key, selection)),
            };
            for task in required.iter().filter(|task| catalog::kind(task) != "test") {
                put(
                    catalog::task_id(task).to_string(),
                    Selection {
                        input: obj! { "kind" => "project", "task" => catalog::task_id(task) },
                        paths: paths.clone(),
                        cwd: cwd.clone(),
                    },
                );
            }
            for observation in &observations {
                let task_id = text(observation, "taskId").unwrap_or("");
                if text(observation, "cwd") != Some(cwd.as_str())
                    || !scoped.iter().any(|task| {
                        catalog::task_id(task) == task_id && catalog::kind(task) == "test"
                    })
                {
                    continue;
                }
                let args = array(observation, "args");
                put(
                    Json::Arr(vec![Json::from(task_id), Json::Arr(args.clone())]).stringify(),
                    Selection {
                        input: obj! { "kind" => "project", "task" => task_id, "args" => Json::Arr(args) },
                        paths: paths.clone(),
                        cwd: cwd.clone(),
                    },
                );
            }
            selections.extend(package.into_iter().map(|(_, selection)| selection));
        }
        Ok(selections)
    }

    /// A check whose source changed while it ran proves nothing: one more
    /// try; after two, none (the finish reports the work unverified).
    fn run_settled(
        &mut self,
        input: &Json,
        tool_call: Option<&str>,
        signal: &Signal,
    ) -> Outcome<Option<Json>> {
        for _ in 0..2 {
            let result = self.run_validation(input, tool_call, signal)?;
            let stale = result.get("status").and_then(Json::as_str) == Some("ok")
                && result
                    .get("data")
                    .and_then(|data| data.get("validation"))
                    .and_then(|validation| validation.get("status"))
                    .and_then(Json::as_str)
                    == Some("stale");
            if !stale {
                return Ok(Some(result));
            }
        }
        Ok(None)
    }

    fn run_validation(
        &mut self,
        input: &Json,
        tool_call: Option<&str>,
        signal: &Signal,
    ) -> Outcome<Json> {
        self.sequence += 1;
        let id = format!(
            "{}:validation:{}",
            tool_call.unwrap_or("finish"),
            self.sequence
        );
        self.activities.push(
            obj! { "input" => input.clone(), "phase" => "started", "toolCallId" => id.as_str() },
        );
        let context = RunContext {
            credentials: None,
            signal: signal.clone(),
        };
        let mut output = self.tasks.run(input, &context, None);
        // Final validation owns this invocation to its end: a running handle
        // is no evidence that the requested test finished.
        while output.get("status").and_then(Json::as_str) == Some("ok") {
            let Some(run) = output
                .get("data")
                .and_then(|data| data.get("run"))
                .and_then(Json::as_str)
                .map(str::to_string)
            else {
                break;
            };
            std::thread::sleep(Duration::from_millis(100));
            signal.check()?;
            let inspected =
                self.tasks
                    .run(&obj! { "kind" => "inspect", "run" => run }, &context, None);
            output = match inspected.get("data").and_then(|data| data.get("completed")) {
                Some(completed) if inspected.get("status").and_then(Json::as_str) == Some("ok") => {
                    completed.clone()
                }
                _ => inspected,
            };
        }
        signal.check()?;
        self.activities.push(obj! { "input" => input.clone(), "output" => output.clone(), "phase" => "finished", "toolCallId" => id.as_str() });
        Ok(output)
    }

    fn completion_memory(&self, summary: &str, state: &Json, task: &str) -> Option<Json> {
        let files = array(state, "files");
        if files.is_empty() || files.len() > 24 {
            return None;
        }
        let validation = array(state, "validations").into_iter().find(|item| {
            text(item, "taskId") == Some(task) && text(item, "terminal") == Some("passed")
        });
        let mut unique: Vec<(String, Json)> = Vec::new();
        for file in &files {
            let path = text(file, "path").unwrap_or("").to_string();
            let entry = obj! { "hash" => file.get("hash").cloned().unwrap_or(Json::Null), "path" => path.as_str() };
            match unique.iter_mut().find(|(known, _)| *known == path) {
                Some(slot) => slot.1 = entry,
                None => unique.push((path, entry)),
            }
        }
        let mut symbols: Vec<String> = Vec::new();
        for symbol in strings(state, "symbols") {
            if !symbols.contains(&symbol) {
                symbols.push(symbol);
            }
        }
        let candidate = obj! {
            "files" => Json::Arr(unique.into_iter().take(24).map(|(_, entry)| entry).collect()),
            "objective" => clean_text(text(&self.contract, "objective").unwrap_or(""), 1_000),
            "sourceRevisionId" => state.get("sourceRevisionId").cloned().unwrap_or(Json::Null),
        }
        .with_opt(
            "storyId",
            text(&self.contract, "story_id").filter(|story| !story.is_empty()),
        )
        .with("summary", clean_text(summary, 1_600))
        .with(
            "symbols",
            Json::Arr(symbols.into_iter().take(32).map(Json::from).collect()),
        )
        .with_opt(
            "validationKind",
            validation
                .as_ref()
                .and_then(|validation| text(validation, "taskKind"))
                .filter(|kind| !kind.is_empty()),
        )
        .with_opt(
            "validationTaskId",
            Some(task).filter(|task| !task.is_empty()),
        );
        let fingerprint = sha256_hex(candidate.stringify().as_bytes());
        Some(candidate.with("fingerprint", fingerprint))
    }
}

fn blocked_code(result: &Json) -> bool {
    text(result, "status") == Some("blocked") && text(result, "category") == Some("code")
}

fn select_validation_task<'a>(tasks: &[&'a Task], paths: &[String]) -> Option<&'a Task> {
    let mut scored: Vec<(&Task, usize)> = tasks
        .iter()
        .copied()
        .filter(|task| CHECK_KINDS.contains(&catalog::kind(task)))
        .map(|task| {
            let scope = if catalog::cwd(task) == "." {
                String::new()
            } else {
                format!("{}/", catalog::cwd(task))
            };
            let scoped = paths.iter().filter(|path| path.starts_with(&scope)).count();
            let priority = CHECK_KINDS.len()
                - CHECK_KINDS
                    .iter()
                    .position(|kind| *kind == catalog::kind(task))
                    .unwrap_or(0);
            (task, scoped * 100 + priority)
        })
        .collect();
    scored.sort_by_key(|(_, score)| std::cmp::Reverse(*score));
    scored.first().map(|(task, _)| *task)
}

fn completion_decision(
    revision: &str,
    verified: bool,
    unavailable: bool,
    non_mutating: bool,
    obligations: &[(String, bool)],
    observed_passing_test: bool,
    unsettled: bool,
) -> Json {
    let missing: Vec<Json> = obligations
        .iter()
        .filter(|(_, passed)| !passed)
        .map(|(id, _)| Json::from(id.as_str()))
        .collect();
    let mut satisfied: Vec<Json> = if verified {
        vec![Json::from("validation")]
    } else {
        Vec::new()
    };
    satisfied.extend(
        obligations
            .iter()
            .filter(|(_, passed)| *passed)
            .map(|(id, _)| Json::from(id.as_str())),
    );
    let mut reservations = Vec::new();
    if !missing.is_empty() {
        reservations.push(obj! {
            "code" => "REQUIRED_CHECK_UNCONFIRMED",
            "message" => "A required final-source invocation has no observed passing execution. User acceptance criteria remain a separate assessment.",
            "obligation_ids" => Json::Arr(missing.clone()),
        });
    }
    if unavailable && !non_mutating {
        let message = if unsettled {
            "Project files changed while the final checks ran, twice in a row, so no check covers the final source. Another program, such as a running dev server or an editor, may be writing to the project."
        } else if observed_passing_test {
            "A test invocation reported a passing result. Its evidence does not establish verification of the current source."
        } else {
            "No current project validation was available."
        };
        reservations.push(obj! { "code" => "VALIDATION_UNAVAILABLE", "message" => message, "obligation_ids" => Json::Arr(Vec::new()) });
    }
    obj! {
        "source_revision_id" => revision,
        "delivery" => "satisfied",
        "verification" => if verified { "verified" } else if non_mutating { "not_applicable" } else { "unverified" },
        "satisfied_obligations" => Json::Arr(satisfied),
        "missing_obligations" => Json::Arr(missing),
        "failed_obligations" => Json::Arr(Vec::new()),
        "reservations" => Json::Arr(reservations),
    }
}

/// `lightRequiredChecksSchema`: at most 16 checks with unique ids.
fn validate_required_checks(checks: &[Json]) -> Outcome<()> {
    static ID: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"^[A-Za-z0-9_.:-]{1,120}$").expect("pattern")
    });
    let mut ids: Vec<&str> = Vec::new();
    for check in checks {
        let id = text(check, "id")
            .filter(|id| ID.is_match(id))
            .ok_or_else(|| Failure::new("Invalid required check id."))?;
        let task = js_trim(text(check, "task").unwrap_or(""));
        if task.is_empty() || crate::text::utf16_len(task) > 300 {
            return Err(Failure::new(format!(
                "Invalid required check task for {id}."
            )));
        }
        ids.push(id);
    }
    if checks.len() > 16 {
        return Err(Failure::new("At most 16 required checks."));
    }
    let mut unique = ids.clone();
    unique.sort();
    unique.dedup();
    if unique.len() != ids.len() {
        return Err(Failure::new("Required check ids must be unique."));
    }
    Ok(())
}

/// `cleanText`: one line, no control characters or markup brackets, cut at
/// a character boundary within `maximum_bytes`.
fn clean_text(value: &str, maximum_bytes: usize) -> String {
    let stripped: String = value
        .chars()
        .map(|character| match character {
            '\u{0}'..='\u{1f}' | '\u{7f}' => ' ',
            '<' => '‹',
            '>' => '›',
            '"' => '\'',
            other => other,
        })
        .collect();
    let mut collapsed = String::new();
    let mut space = false;
    for character in stripped.chars() {
        if crate::text::is_js_space(character) {
            space = true;
            continue;
        }
        if space && !collapsed.is_empty() {
            collapsed.push(' ');
        }
        space = false;
        collapsed.push(character);
    }
    if collapsed.len() <= maximum_bytes {
        return collapsed;
    }
    let mut end = maximum_bytes;
    while end > 0 && !collapsed.is_char_boundary(end) {
        end -= 1;
    }
    js_trim(&collapsed[..end]).to_string()
}

/// `finishImages`: repeated screenshots dropped, the agent's order kept.
pub fn finish_images(images: &Json) -> Vec<Json> {
    let mut seen: Vec<String> = Vec::new();
    let mut result = Vec::new();
    for image in images.as_array().into_iter().flatten() {
        let reference = text(image, "ref").unwrap_or("");
        let id = reference
            .strip_prefix("screenshot:")
            .unwrap_or(reference)
            .to_string();
        if seen.contains(&id) {
            continue;
        }
        seen.push(id.clone());
        result.push(obj! { "caption" => text(image, "caption").unwrap_or(""), "id" => id });
    }
    result
}

/// executeLocalFinishTask: `{ notification, summary, validationActivities }`.
pub fn execute_finish(
    root: &str,
    contract: Option<&Json>,
    input: &Json,
    context: &Json,
    signal: &Signal,
) -> Json {
    let Some(summary) = text(input, "summary") else {
        return obj! { "status" => "blocked", "category" => "code", "message" => "A finish summary is required." };
    };
    let contract = contract.cloned().unwrap_or(Json::Null);
    let session = text(&contract, "session_id")
        .unwrap_or("unscoped-session")
        .to_string();
    // The service's own images ({ caption, id }) when the caller already has
    // them; otherwise the tool's refs, ignored unless all are valid.
    let images = match input.get("finishImages") {
        Some(images) => images.as_array().cloned().unwrap_or_default(),
        None => match input.get("images") {
            Some(images)
                if crate::validate::parse_leniently(&finish_images_schema(), images).is_ok() =>
            {
                finish_images(images)
            }
            _ => Vec::new(),
        },
    };
    let mut service = FinishService::new(root, &session, &contract);
    let tool_call = text(context, "toolCallId").filter(|id| !id.is_empty());
    match service.finish(summary, images, tool_call, signal) {
        Ok(summary) => obj! {
            "status" => "ok",
            "data" => obj! {}
                .with_opt("notification", service.notification.clone())
                .with("summary", summary)
                .with("validationActivities", Json::Arr(service.activities.clone())),
        },
        Err(failure) => {
            let blocked =
                obj! { "status" => "blocked", "category" => "code", "message" => failure.message };
            // A caller that reports validation activities as they happen
            // (`onValidationActivity`) also gets those of a refused finish.
            if input.get("reportActivities") == Some(&Json::Bool(true)) {
                return blocked.with(
                    "validationActivities",
                    Json::Arr(service.activities.clone()),
                );
            }
            blocked
        }
    }
}

fn finish_images_schema() -> crate::validate::Schema {
    match crate::validate::finish_task_schema() {
        crate::validate::Schema::Object { fields, .. } => fields
            .into_iter()
            .find(|(name, _, _)| *name == "images")
            .map(|(_, schema, _)| schema)
            .expect("images"),
        _ => unreachable!("finish_task_schema is an object"),
    }
}
