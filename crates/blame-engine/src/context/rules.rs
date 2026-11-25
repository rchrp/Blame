//! The TypeScript runtime's presentation rules for harness results, on
//! decoded results.
//!
//! - Older-block rules, from `context-projection.ts` and
//!   `read-overlap-projection.ts`: a read a later read supersedes, a read a
//!   later read repeats in part, an edit whose result no longer matters.
//! - Forward rules, from `context-projection.ts` (command echo),
//!   `repair-advice-projection.ts` and `tool-result-presentation.ts`: they
//!   look only at what comes before a result, so they can be applied once,
//!   when the result is new.

use super::Shown;
use super::json::{Json, js_length};
use super::overlap::project_read_overlap;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

/// Successful edits whose input is at least this big are dropped once a
/// trusted check validated them, even if nothing read the file since.
const MIN_VALIDATED_EDIT_BYTES: usize = 4_096;

/// What an older-block rule shows instead of a result.
#[derive(Clone, Debug, PartialEq)]
pub enum Older {
    /// The whole result becomes this text (`edit_code`).
    Text(String),
    /// The result becomes this object, without its images (`read_code`).
    Result(Json),
}

struct Read {
    /// Index in the results.
    result: usize,
    data: Json,
    fragments: Vec<String>,
    projected: Option<Json>,
    superseded: bool,
    path: String,
    receipt: Option<String>,
}

/// `HistoryIndex` of `context-projection.ts`, over the results shown.
#[derive(Default)]
struct History {
    latest_source_change: Option<u64>,
    /// Path to the result that last edited it, and its message.
    latest_edit_by_path: HashMap<String, (usize, u64)>,
    /// Message of the latest complete read of each path.
    latest_read_by_path: HashMap<String, u64>,
    reads: Vec<Read>,
    successful_edits: HashSet<usize>,
    validations: Vec<(u64, HashSet<String>)>,
}

fn status(result: &Json) -> Option<&str> {
    result.get("status").and_then(Json::as_str)
}

fn successful(result: &Json) -> bool {
    status(result) == Some("ok")
}

fn non_empty_array(value: Option<&Json>) -> bool {
    value
        .and_then(Json::as_array)
        .is_some_and(|a| !a.is_empty())
}

/// JavaScript truthiness of an input field.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

fn changed_paths(result: &Json) -> Vec<String> {
    result
        .get("data")
        .and_then(|data| data.get("changes"))
        .and_then(Json::as_array)
        .unwrap_or_default()
        .iter()
        .filter_map(|change| change.get("path").and_then(Json::as_str))
        .map(str::to_owned)
        .collect()
}

/// `completeRead`: the read showed the whole file.
fn complete_read(result: &Json, input: &Value) -> bool {
    let data = result.get("data");
    if let Some(Json::Bool(complete)) = data.and_then(|d| d.get("complete")) {
        return *complete;
    }
    let view = match data.and_then(|d| d.get("view")) {
        Some(Json::Null) | None => input.get("view").and_then(Value::as_str),
        Some(view) => view.as_str(),
    };
    data.and_then(|d| d.get("content"))
        .and_then(Json::as_str)
        .is_some()
        && data.and_then(|d| d.get("truncated")) != Some(&Json::Bool(true))
        && !truthy(input.get("range"))
        && !view.is_some_and(|view| ["range", "outline", "symbol"].contains(&view))
}

/// Source texts a read showed, for comparing reads.
fn read_fragments(data: &Json) -> Vec<String> {
    let mut values: Vec<Option<&Json>> = ["content", "signature", "body", "imports"]
        .iter()
        .map(|key| data.get(key))
        .collect();
    if let Some(segments) = data.get("segments").and_then(Json::as_array) {
        values.extend(segments.iter().map(|segment| segment.get("content")));
    }
    values
        .into_iter()
        .filter_map(|value| value.and_then(Json::as_str))
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
        .collect()
}

impl History {
    fn index(results: &[Shown<'_>]) -> Self {
        let mut history = Self::default();
        for (index, shown) in results.iter().enumerate() {
            let Some(original) = &shown.original else {
                continue;
            };
            let result = &original.result;
            match shown.name {
                "read_code" => history.index_read(index, shown, result),
                "edit_code" if successful(result) => {
                    history.successful_edits.insert(index);
                    for path in changed_paths(result) {
                        history
                            .latest_edit_by_path
                            .insert(path, (index, shown.message));
                    }
                }
                _ => {}
            }
            history.index_source_change(shown, result);
            if shown.name == "run_task" {
                history.index_validation(shown, result);
            }
        }
        history.project_overlapping_reads();
        history
    }

    fn index_read(&mut self, index: usize, shown: &Shown<'_>, result: &Json) {
        if !successful(result) {
            return;
        }
        let Some(data) = result.get("data").filter(|d| d.is_object()) else {
            return;
        };
        let Some(path) = data
            .get("path")
            .and_then(Json::as_str)
            .or_else(|| shown.input.get("target").and_then(Value::as_str))
        else {
            return;
        };
        let read = Read {
            result: index,
            data: data.clone(),
            fragments: read_fragments(data),
            projected: None,
            superseded: false,
            path: path.to_owned(),
            receipt: result
                .get("receipt")
                .and_then(Json::as_str)
                .map(str::to_owned),
        };
        let complete = complete_read(result, shown.input);
        for previous in &mut self.reads {
            // `readSupersedes`: a complete read, or one that repeats every
            // fragment of the earlier one.
            if previous.path == read.path
                && (complete
                    || (!previous.fragments.is_empty()
                        && previous.fragments.iter().all(|fragment| {
                            read.fragments
                                .iter()
                                .any(|replacement| replacement.contains(fragment.as_str()))
                        })))
            {
                previous.superseded = true;
            }
        }
        if complete {
            self.latest_read_by_path
                .insert(read.path.clone(), shown.message);
        }
        self.reads.push(read);
    }

    /// Edits, commands that changed files, and formatter writes.
    fn index_source_change(&mut self, shown: &Shown<'_>, result: &Json) {
        if !successful(result) {
            return;
        }
        let data = result.get("data");
        let completed = data
            .and_then(|d| d.get("completed"))
            .and_then(|c| c.get("data"));
        let changed = (shown.name == "edit_code" && !changed_paths(result).is_empty())
            || data.and_then(|d| d.get("changed")) == Some(&Json::Bool(true))
            || data.and_then(|d| d.get("mutation")).and_then(Json::as_str)
                == Some("deterministic_format")
            || (shown.name == "run_task"
                && (non_empty_array(data.and_then(|d| d.get("paths")))
                    || non_empty_array(completed.and_then(|c| c.get("paths")))));
        if changed {
            self.latest_source_change = Some(
                self.latest_source_change
                    .map_or(shown.message, |latest| latest.max(shown.message)),
            );
        }
    }

    fn index_validation(&mut self, shown: &Shown<'_>, result: &Json) {
        let Some(validation) = result.get("data").and_then(|d| d.get("validation")) else {
            return;
        };
        let paths: HashSet<String> = validation
            .get("paths")
            .and_then(Json::as_array)
            .unwrap_or_default()
            .iter()
            .filter_map(Json::as_str)
            .map(str::to_owned)
            .collect();
        let trusted = validation
            .get("taskKind")
            .and_then(Json::as_str)
            .is_some_and(|kind| {
                ["build", "dependencies", "lint", "test", "typecheck"].contains(&kind)
            });
        if validation.get("status").and_then(Json::as_str) == Some("passed")
            && trusted
            && !paths.is_empty()
        {
            self.validations.push((shown.message, paths));
        }
    }

    /// From the latest read back, each read loses what the later reads of
    /// its file still show.
    fn project_overlapping_reads(&mut self) {
        let mut retained: HashMap<String, Vec<String>> = HashMap::new();
        for read in self.reads.iter_mut().rev() {
            if read.superseded {
                continue;
            }
            let references = retained.get(&read.path).cloned().unwrap_or_default();
            if references.is_empty() {
                retained.insert(read.path.clone(), read.fragments.clone());
                continue;
            }
            let projection = project_read_overlap(&read.data, &references);
            if projection.changed {
                read.projected = Some(projection.data);
            }
            let mut kept = references;
            kept.extend(projection.retained);
            retained.insert(read.path.clone(), kept);
        }
    }

    /// `validatedCurrentEdit`: a trusted check passed on every changed path
    /// after the edit and after the latest source change.
    fn validated_edit(&self, shown: &Shown<'_>, result: &Json) -> bool {
        let paths = changed_paths(result);
        let input_bytes = serde_json::to_string(shown.input).map_or(0, |text| text.len());
        if paths.is_empty() || input_bytes < MIN_VALIDATED_EDIT_BYTES {
            return false;
        }
        self.validations.iter().any(|(message, validated)| {
            *message > shown.message
                && self
                    .latest_source_change
                    .is_none_or(|latest| *message > latest)
                && paths.iter().all(|path| validated.contains(path))
        })
    }

    /// `unobservedCurrentEdit`: the latest edit of a path that no complete
    /// read has shown since; its result is how the model knows the file.
    fn unobserved_edit(&self, index: usize, result: &Json) -> bool {
        changed_paths(result).iter().any(|path| {
            self.latest_edit_by_path
                .get(path)
                .is_some_and(|(edit, message)| {
                    *edit == index
                        && self
                            .latest_read_by_path
                            .get(path)
                            .is_none_or(|read| read <= message)
                })
        })
    }
}

/// What the older-block rules show instead of each result, in the order of
/// `projectBlock`: a compactable edit, then a read repeated in part, then a
/// superseded read.
pub fn older_rules(results: &[Shown<'_>]) -> Vec<Option<Older>> {
    let history = History::index(results);
    let mut out: Vec<Option<Older>> = vec![None; results.len()];
    for (index, shown) in results.iter().enumerate() {
        let Some(original) = &shown.original else {
            continue;
        };
        let result = &original.result;
        if history.successful_edits.contains(&index)
            && (!history.unobserved_edit(index, result) || history.validated_edit(shown, result))
        {
            out[index] = Some(Older::Text(format!(
                "Historical completed edit (not an executable tool call): {}",
                result.to_text()
            )));
        }
    }
    for read in &history.reads {
        let shown = &results[read.result];
        if let Some(projected) = &read.projected {
            out[read.result] = Some(Older::Result(Json::object(vec![
                ("data", Some(projected.clone())),
                ("receipt", read.receipt.clone().map(Json::String)),
                (
                    "status",
                    Some(Json::str("partially_superseded_by_later_read")),
                ),
            ])));
        } else if read.superseded
            || history
                .latest_read_by_path
                .get(&read.path)
                .is_some_and(|latest| *latest > shown.message)
        {
            let mut data = read.data.clone();
            for key in ["content", "signature", "body", "imports", "segments"] {
                data.remove(key);
            }
            data.set("path", Json::str(read.path.clone()));
            match &read.receipt {
                Some(receipt) => data.set("receipt", Json::str(receipt.clone())),
                None => {
                    data.remove("receipt");
                }
            }
            out[read.result] = Some(Older::Result(Json::object(vec![
                ("data", Some(data)),
                ("status", Some(Json::str("superseded_by_later_read"))),
            ])));
        }
    }
    out
}

/// `projectCommandResult`: a `run_task` result does not repeat the command
/// the model just wrote. True when it changed `result`.
pub fn drop_command_echo(result: &mut Json, input: &Value) -> bool {
    let Some(command) = input.get("command").and_then(Value::as_str) else {
        return false;
    };
    match result.get_mut("data") {
        // The harness trims the command it echoes.
        Some(data)
            if data.get("command").and_then(Json::as_str).map(str::trim)
                == Some(command.trim()) =>
        {
            data.remove("command");
            true
        }
        _ => false,
    }
}

const ADVICE_KEYS: [&str; 4] = ["guidance", "instruction", "recovery", "note"];
/// Advice shorter than this is cheaper to repeat than to track.
const MIN_ADVICE_LENGTH: usize = 80;

const REFERENCE_INSTRUCTION: &str = "Same visible repair plan. Rerun the failed selection \
before green checks; retain every required final-source check. No verification is admitted. \
read_code @checks returns the full plan.";

/// What the forward rules remember of the results before the current one.
#[derive(Default)]
pub struct Seen {
    /// Long advice already shown (`presentToolResults`).
    advice: HashSet<String>,
    /// Each repair plan shown in full, by its JSON text, with the call that
    /// showed it (`compactRepairAdvice`).
    plans: HashMap<String, String>,
}

impl Seen {
    /// Applies the forward rules to a new result. True when it changed.
    pub fn present(&mut self, shown: &Shown<'_>, result: &mut Json) -> bool {
        let repaired = self.repair_plan(shown, result, true);
        let condensed = self.condense(result, true);
        repaired || condensed
    }

    /// Learns from a result shown as it is: what it shows counts as seen.
    pub fn observe(&mut self, shown: &Shown<'_>, result: &Json) {
        let mut copy = result.clone();
        self.repair_plan(shown, &mut copy, false);
        self.condense(&mut copy, false);
    }

    /// `condensed`: long advice already shown earlier is dropped.
    fn condense(&mut self, value: &mut Json, apply: bool) -> bool {
        if value.get("status").is_none() {
            return false;
        }
        self.condense_value(value, apply)
    }

    fn condense_value(&mut self, value: &mut Json, apply: bool) -> bool {
        let mut changed = false;
        match value {
            Json::Array(items) => {
                for item in items {
                    changed |= self.condense_value(item, apply);
                }
            }
            Json::Object(entries) => {
                let mut kept = Vec::with_capacity(entries.len());
                for (name, mut item) in std::mem::take(entries) {
                    if let Json::String(text) = &item
                        && ADVICE_KEYS.contains(&name.as_str())
                        && js_length(text) >= MIN_ADVICE_LENGTH
                        && !self.advice.insert(text.clone())
                        && apply
                    {
                        changed = true;
                        continue;
                    }
                    changed |= self.condense_value(&mut item, apply);
                    kept.push((name, item));
                }
                *entries = kept;
            }
            _ => {}
        }
        changed
    }

    /// `compactRepairAdvice`: a repair plan already shown in full becomes a
    /// reference to the call that showed it, unless the reference would not
    /// be shorter or the model needs the plan right there (a failed run, an
    /// explicit `@checks` read).
    fn repair_plan(&mut self, shown: &Shown<'_>, result: &mut Json, apply: bool) -> bool {
        if !["run_task", "edit_code", "read_code"].contains(&shown.name)
            || !matches!(status(result), Some("ok" | "blocked"))
        {
            return false;
        }
        let Some((plan, place)) = locate_plan(result) else {
            return false;
        };
        if !valid_plan(&plan) {
            return false;
        }
        let serialized = plan.to_text();
        let previous = self.plans.get(&serialized).cloned();
        let forced = (shown.name == "read_code"
            && shown.input.get("target").and_then(Value::as_str) == Some("@checks"))
            || (shown.name == "run_task" && failed(result));
        let reference = Json::object(vec![
            ("kind", Some(Json::str("repair_plan_reference"))),
            (
                "sourceRevisionId",
                plan.get("sourceRevisionId")
                    .filter(|id| id.as_str().is_some())
                    .cloned(),
            ),
            ("advisoryOnly", Some(Json::Bool(true))),
            ("fullPlanToolCallId", previous.clone().map(Json::String)),
            ("instruction", Some(Json::str(REFERENCE_INSTRUCTION))),
        ]);
        if previous.is_none() || forced || js_length(&reference.to_text()) >= js_length(&serialized)
        {
            self.plans.insert(serialized, shown.call.0.clone());
            return false;
        }
        if !apply {
            return false;
        }
        place.replace(result, reference);
        true
    }
}

enum PlanPlace {
    /// `data.validationRepair` of an `ok` result.
    Data,
    /// The JSON on the last line of a `blocked` result's `recovery`.
    Recovery { head: String, tail: Json },
}

impl PlanPlace {
    fn replace(self, result: &mut Json, reference: Json) {
        match self {
            PlanPlace::Data => {
                if let Some(data) = result.get_mut("data") {
                    data.set("validationRepair", reference);
                }
            }
            PlanPlace::Recovery { head, mut tail } => {
                tail.set("validationRepair", reference);
                result.set(
                    "recovery",
                    Json::String(format!("{head}{}", tail.to_text())),
                );
            }
        }
    }
}

fn locate_plan(result: &Json) -> Option<(Json, PlanPlace)> {
    let data = result.get("data").filter(|d| d.is_object());
    let plan = data
        .and_then(|d| d.get("validationRepair"))
        .filter(|p| p.is_object());
    if status(result) == Some("ok")
        && let Some(plan) = plan
    {
        return Some((plan.clone(), PlanPlace::Data));
    }
    if status(result) != Some("blocked") {
        return None;
    }
    let recovery = result.get("recovery")?.as_str()?;
    let split = recovery.rfind('\n').map_or(0, |newline| newline + 1);
    let tail = Json::parse(&recovery[split..]).filter(|t| t.is_object())?;
    let plan = tail
        .get("validationRepair")
        .filter(|p| p.is_object())?
        .clone();
    Some((
        plan,
        PlanPlace::Recovery {
            head: recovery[..split].to_owned(),
            tail,
        },
    ))
}

fn valid_plan(plan: &Json) -> bool {
    let repair_first = plan.get("repairFirst").and_then(Json::as_array);
    plan.get("advisoryOnly") == Some(&Json::Bool(true))
        && plan
            .get("sourceRevisionId")
            .is_none_or(|id| id.as_str().is_some())
        && repair_first.is_some_and(|steps| !steps.is_empty())
        && plan
            .get("requiredAfterRepair")
            .and_then(Json::as_array)
            .is_some()
        && repair_first.unwrap_or_default().iter().all(|step| {
            let input = step.get("input").filter(|i| i.is_object());
            match input.and_then(|i| i.get("kind")).and_then(Json::as_str) {
                Some("project") => input
                    .and_then(|i| i.get("task"))
                    .and_then(Json::as_str)
                    .is_some(),
                Some("command") => input
                    .and_then(|i| i.get("command"))
                    .and_then(Json::as_str)
                    .is_some(),
                _ => false,
            }
        })
}

/// A blocked result, a failed check or a non-zero exit, here or in the
/// managed run it completed.
fn failed(result: &Json) -> bool {
    if status(result) == Some("blocked") {
        return true;
    }
    let Some(data) = result.get("data").filter(|d| d.is_object()) else {
        return false;
    };
    let check_failed = data
        .get("check")
        .or_else(|| data.get("reporting"))
        .and_then(|c| c.get("outcome"))
        .and_then(Json::as_str)
        == Some("failed");
    let exit_failed = matches!(
        data.get("exitCode"),
        Some(Json::Number(n)) if n.parse::<f64>().is_ok_and(|n| n != 0.0)
    );
    check_failed
        || exit_failed
        || data
            .get("completed")
            .filter(|c| c.is_object())
            .is_some_and(failed)
}
