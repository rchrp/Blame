//! What the journal's checks say about the current source
//! (`light-validation-report.ts`, `light-check-repair.ts`): the `@checks`
//! view, the invalidation receipt after an edit, and the advisory repair
//! plan after a failed check. Validations are the journal's public ones.

use crate::failure::{Outcome, Signal};
use crate::files::WorkspaceFiles;
use crate::json::Json;
use crate::obj;
use crate::run::catalog::{self, plain_compiler_check, read_task_catalog};
use crate::run::check::check_reporting;

const CHECK_KINDS: [&str; 4] = ["build", "test", "typecheck", "lint"];

fn text<'a>(value: &'a Json, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Json::as_str)
}

fn is_check_kind(value: &Json) -> bool {
    text(value, "taskKind").is_some_and(|kind| CHECK_KINDS.contains(&kind))
}

fn array(value: &Json, key: &str) -> Vec<Json> {
    value
        .get(key)
        .and_then(Json::as_array)
        .cloned()
        .unwrap_or_default()
}

fn or_null(value: Option<&Json>) -> Json {
    value
        .filter(|value| !matches!(value, Json::Null))
        .cloned()
        .unwrap_or(Json::Null)
}

/// `[cwd, taskId ?? command, args]`: literal selections stay distinct even
/// when they share a catalog task.
pub fn check_invocation_key(value: &Json) -> String {
    Json::Arr(vec![
        Json::from(text(value, "cwd").unwrap_or(".")),
        or_null(
            value
                .get("taskId")
                .filter(|id| !matches!(id, Json::Null))
                .or(value.get("command")),
        ),
        value.get("args").cloned().unwrap_or(Json::Arr(Vec::new())),
    ])
    .stringify()
}

fn latest_by<F: Fn(&Json) -> String>(validations: &[Json], key: F) -> Vec<Json> {
    let mut latest: Vec<(String, Json)> = Vec::new();
    for value in validations {
        let identity = key(value);
        match latest.iter_mut().find(|(known, _)| *known == identity) {
            Some(slot) => slot.1 = value.clone(),
            None => latest.push((identity, value.clone())),
        }
    }
    latest.into_iter().map(|(_, value)| value).collect()
}

pub fn latest_failed_invocations(validations: &[Json]) -> Vec<Json> {
    let mut failed: Vec<Json> = latest_by(validations, check_invocation_key)
        .into_iter()
        .filter(|value| {
            text(value, "taskId").is_some()
                && is_check_kind(value)
                && text(value, "terminal") == Some("failed")
        })
        .collect();
    failed.extend(failed_literal_compiler_invocations(validations));
    failed
}

/// Only exact no-emit compiler commands; never arbitrary or compound shell.
pub fn failed_literal_compiler_invocations(validations: &[Json]) -> Vec<Json> {
    let literal: Vec<Json> = validations
        .iter()
        .filter(|value| text(value, "command").is_some_and(plain_compiler_check))
        .cloned()
        .collect();
    latest_by(&literal, |value| {
        Json::Arr(vec![
            Json::from(text(value, "cwd").unwrap_or(".")),
            Json::from(text(value, "command").unwrap_or("")),
        ])
        .stringify()
    })
    .into_iter()
    .filter(|value| {
        text(value, "taskId").is_none()
            && text(value, "taskKind") == Some("typecheck")
            && text(value, "terminal") == Some("failed")
    })
    .collect()
}

fn previous_checks(state: &Json, history: &[Json]) -> Vec<Json> {
    let mut latest: Vec<(String, Json, usize)> = Vec::new();
    for (index, validation) in history.iter().enumerate() {
        if is_check_kind(validation)
            || validation
                .get("check")
                .is_some_and(|check| !matches!(check, Json::Null))
        {
            let key = check_invocation_key(validation);
            match latest.iter_mut().find(|(known, _, _)| *known == key) {
                Some(slot) => {
                    slot.1 = validation.clone();
                    slot.2 = index;
                }
                None => latest.push((key, validation.clone(), index)),
            }
        }
    }
    let current: Vec<String> = array(state, "validations")
        .iter()
        .map(check_invocation_key)
        .collect();
    let revision = text(state, "sourceRevisionId");
    let mut previous: Vec<(Json, usize)> = latest
        .into_iter()
        .filter(|(key, _, _)| !current.contains(key))
        .map(|(_, validation, index)| (validation, index))
        .collect();
    previous.sort_by_key(|entry| std::cmp::Reverse(entry.1));
    previous
        .into_iter()
        .map(|(validation, _)| {
            let source = text(&validation, "sourceRevisionId");
            obj! {
                "id" => or_null(validation.get("id")),
                "task" => or_null(validation.get("taskId")),
                "cwd" => text(&validation, "cwd").unwrap_or("."),
                "args" => validation.get("args").cloned().unwrap_or(Json::Arr(Vec::new())),
            }
            .with_opt(
                "command",
                text(&validation, "taskId")
                    .is_none()
                    .then(|| validation.get("command").cloned())
                    .flatten()
                    .filter(|command| !matches!(command, Json::Null)),
            )
            .with(
                "sourceRevisionId",
                or_null(validation.get("sourceRevisionId")),
            )
            .with("recordedAt", or_null(validation.get("timestamp")))
            .with(
                "sourceState",
                if source.is_some() && source != revision {
                    "earlier_source"
                } else {
                    "not_current"
                },
            )
            .with(
                "previousOutcome",
                or_null(
                    validation
                        .get("check")
                        .and_then(|check| check.get("outcome"))
                        .or(validation.get("terminal")),
                ),
            )
            .with("eligibleForCurrentSource", false)
            .with("admission", "unverified")
        })
        .collect()
}

/// Omits an oversized identity instead of cutting cwd or argv into another invocation.
fn bounded_previous_checks(checks: &[Json], limit: usize, maximum_bytes: usize) -> Vec<Json> {
    let mut kept: Vec<Json> = Vec::new();
    for check in checks {
        if kept.len() >= limit {
            break;
        }
        let mut candidate = kept.clone();
        candidate.push(check.clone());
        if Json::Arr(candidate).stringify().len() <= maximum_bytes {
            kept.push(check.clone());
        }
    }
    kept
}

/// `@checks`: current-source checks and bounded earlier ones.
pub fn current_validation_report(state: &Json, history: &[Json]) -> Json {
    let validations = array(state, "validations");
    let checks: Vec<Json> = validations
        .iter()
        .skip(validations.len().saturating_sub(16))
        .map(|validation| {
            let paths = array(validation, "paths");
            let admitted = is_check_kind(validation)
                && text(validation, "status") == Some("passed")
                && text(validation, "terminal") == Some("passed");
            let check = validation
                .get("check")
                .filter(|check| !matches!(check, Json::Null));
            obj! {}
                .with_opt("scope", validation.get("scope").cloned())
                .with("id", or_null(validation.get("id")))
                .with("task", or_null(validation.get("taskId")))
                .with("command", or_null(validation.get("command")))
                .with(
                    "args",
                    validation
                        .get("args")
                        .cloned()
                        .unwrap_or(Json::Arr(Vec::new())),
                )
                .with("cwd", text(validation, "cwd").unwrap_or("."))
                .with(
                    "sourceRevisionId",
                    or_null(validation.get("sourceRevisionId")),
                )
                .with("recordedAt", or_null(validation.get("timestamp")))
                .with("taskKind", or_null(validation.get("taskKind")))
                .with(
                    "recordedPaths",
                    Json::Arr(paths.iter().take(32).cloned().collect()),
                )
                .with("recordedPathCount", paths.len())
                .with("recordedPathsTruncated", paths.len() > 32)
                .with("status", or_null(validation.get("status")))
                .with("terminal", or_null(validation.get("terminal")))
                .with("category", or_null(validation.get("category")))
                .with(
                    "reporting",
                    check.map_or(Json::Null, |check| check_reporting(check, false)),
                )
                .with_opt(
                    "evidence",
                    check
                        .and_then(|check| check.get("evidence"))
                        .filter(|evidence| !matches!(evidence, Json::Null))
                        .cloned(),
                )
                .with(
                    "admission",
                    if admitted { "admitted" } else { "unverified" },
                )
        })
        .collect();
    let previous = previous_checks(state, history);
    obj! {
        "sourceRevisionId" => or_null(state.get("sourceRevisionId")),
        "scope" => "current_source_only",
        "checks" => Json::Arr(checks.clone()),
        "total" => validations.len(),
        "truncated" => validations.len() > checks.len(),
    }
    .with("failed", validations.iter().filter(|item| text(item, "status") == Some("failed")).count())
    .with("previousChecks", Json::Arr(bounded_previous_checks(&previous, 8, 6_000)))
    .with("previousTotal", previous.len())
    .with("environment", "not_rechecked")
    .with("userCriteria", "not_assessed")
    .with("guidance", "checks contains only current-source journal entries. previousChecks is bounded historical evidence, never eligible for current source. Source identity does not recheck installed dependencies or the environment, prove invocation start time, or assess user criteria. This view launches no commands and admits no validation. Null counters are unreported, never zero; pending differs from skipped.")
}

/// After an edit: which recorded invocations no longer apply.
pub fn validation_state_after_edit(
    state: &Json,
    history: &[Json],
    edit_revision: Option<&str>,
) -> Option<Json> {
    let revision = text(state, "sourceRevisionId");
    if edit_revision != revision {
        return None;
    }
    let previous = previous_checks(state, history);
    if previous.is_empty() {
        return None;
    }
    let checks = bounded_previous_checks(&previous, 6, 1_800);
    Some(obj! {
        "sourceRevisionId" => or_null(state.get("sourceRevisionId")),
        "observation" => "current_source_snapshot_after_operation",
        "invalidatedChecks" => Json::Arr(checks.clone()),
        "omitted" => previous.len() - checks.len(),
        "nextRead" => obj! { "target" => "@checks" },
        "guidance" => "These invocation results do not apply to this source snapshot. After the final source/test edit, rerun every required invocation and any optional check you claim as final. Historical success, current passing tests, admitted verification and user acceptance are distinct. This receipt runs no check and rechecks no environment.",
    })
}

/// The advisory plan after failed checks: rerun the failed selection after
/// repairing it, then every required invocation on the final source.
pub fn check_repair_plan(
    files: &WorkspaceFiles,
    validations: &[Json],
    state: &Json,
    contract: &Json,
) -> Outcome<Option<Json>> {
    let failures = latest_failed_invocations(validations);
    if failures.is_empty() {
        return Ok(None);
    }
    let snapshot = files.snapshot(&Signal::default())?;
    let tasks = read_task_catalog(&files.root, Some(&snapshot.files), true);
    let exact = |task: &str, cwd: Option<&str>| -> Option<Json> {
        let matches: Vec<&Json> = tasks
            .iter()
            .filter(|value| {
                catalog::task_id(value) == task && cwd.is_none_or(|cwd| catalog::cwd(value) == cwd)
            })
            .collect();
        (matches.len() == 1 && CHECK_KINDS.contains(&catalog::kind(matches[0])))
            .then(|| matches[0].clone())
    };
    let revision = text(state, "sourceRevisionId");
    let mut repair_first = Vec::new();
    for value in &failures {
        let item = text(value, "taskId")
            .and_then(|task| exact(task, Some(text(value, "cwd").unwrap_or("."))));
        let args = array(value, "args");
        let input = match &item {
            Some(item) if args.is_empty() || catalog::kind(item) == "test" => Some(
                obj! { "kind" => "project", "task" => catalog::task_id(item) }.with_opt(
                    "args",
                    (catalog::kind(item) == "test").then(|| Json::Arr(args.clone())),
                ),
            ),
            _ if text(value, "taskId").is_none()
                && text(value, "command").is_some_and(plain_compiler_check) =>
            {
                Some(
                    obj! { "kind" => "command", "command" => text(value, "command").unwrap_or("") }
                        .with_opt("cwd", text(value, "cwd").filter(|cwd| *cwd != ".")),
                )
            }
            _ => None,
        };
        let Some(input) = input else { continue };
        let source = text(value, "sourceRevisionId");
        repair_first.push(
            obj! {
                "input" => input,
                "cwd" => item.as_ref().map(|item| catalog::cwd(item).to_string()).or_else(|| text(value, "cwd").map(str::to_string)).unwrap_or_else(|| ".".into()),
                "category" => or_null(value.get("category")),
                "sourceRevisionId" => or_null(value.get("sourceRevisionId")),
                "freshness" => if source == revision { "current" } else { "earlier_source" },
            }
            .with_opt("recovery", text(value, "recovery").filter(|recovery| !recovery.is_empty())),
        );
    }
    if repair_first.is_empty() {
        return Ok(None);
    }
    let required_checks = array(contract, "required_checks");
    let mut required = Vec::new();
    for value in &required_checks {
        let task = text(value, "task").unwrap_or("");
        let Some(item) = exact(task, None) else {
            continue;
        };
        let args = array(value, "args");
        if !args.is_empty() && catalog::kind(&item) != "test" {
            continue;
        }
        let input = obj! { "kind" => "project", "task" => task }.with_opt(
            "args",
            (catalog::kind(&item) == "test").then(|| Json::Arr(args.clone())),
        );
        required.push(obj! { "id" => or_null(value.get("id")), "input" => input, "cwd" => catalog::cwd(&item) });
    }
    Ok(Some(obj! {
        "sourceRevisionId" => or_null(state.get("sourceRevisionId")),
        "advisoryOnly" => true,
        "repairFirst" => Json::Arr(repair_first.iter().take(4).cloned().collect()),
        "omittedFailures" => repair_first.len().saturating_sub(4),
        "requiredAfterRepair" => Json::Arr(required.iter().take(16).cloned().collect()),
        "omittedRequirements" => required.len().saturating_sub(16),
        "unresolvedRequirements" => required_checks.len() as i64 - required.len() as i64,
        "instruction" => "Investigate the failed selection first, including environment or test-expectation errors; an earlier-source failure is a repair lead, not a current result. Rerun that exact selection after repairing it before repeating already passing checks. After the final source/test edit, run every required invocation on that final source. Do not weaken tests, public types or user criteria. This advice runs no command and admits no validation or acceptance.",
    }))
}
