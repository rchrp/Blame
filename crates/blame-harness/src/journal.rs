//! The session journal: one append-only JSON-lines file per session at
//! `<workspace>/.blame/harness/light/<sha256(sessionId)[:24]>.jsonl`, holding
//! hashes and positions, never file contents. The format is the TypeScript
//! harness's (`session-journal.ts`), so a session can move between the two
//! implementations in either direction.
//!
//! This part writes what reads and searches record (aliases, coverage,
//! attention, observation audits, requests) and replays every event type,
//! keeping change and validation events as they were written for the
//! editing and validation parts.

use crate::failure::{Failure, Outcome};
use crate::identity::sha256_hex;
use crate::json::Json;
use crate::obj;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

/// Alias change events between two full lists.
const FULL_ALIAS_LIST_EVERY: usize = 50;
const MAXIMUM_ALIASES: usize = 500;

pub struct SessionJournal {
    file: PathBuf,
    changes: Vec<Json>,
    validations: Vec<Json>,
    aliases: Vec<Json>,
    aliases_digest: String,
    alias_changes: usize,
    coverage: Json,
    coverage_digest: String,
    attention: Option<Json>,
    attention_digest: String,
    request_ids: Vec<String>,
    terminal_state: Option<String>,
}

pub struct ObservationAudit<'a> {
    pub tool: &'a str,
    pub requested_view: &'a str,
    pub rendered_view: &'a str,
    pub bytes: usize,
    pub aliases: usize,
    pub limited: bool,
}

impl SessionJournal {
    pub fn new(workspace_root: &str, session_id: &str) -> SessionJournal {
        let file = PathBuf::from(workspace_root)
            .join(".blame")
            .join("harness")
            .join("light")
            .join(format!(
                "{}.jsonl",
                &sha256_hex(session_id.as_bytes())[..24]
            ));
        let coverage = empty_coverage();
        SessionJournal {
            file,
            changes: Vec::new(),
            validations: Vec::new(),
            aliases: Vec::new(),
            aliases_digest: digest(&Json::Arr(Vec::new())),
            alias_changes: 0,
            coverage_digest: String::new(),
            coverage,
            attention: None,
            attention_digest: String::new(),
            request_ids: Vec::new(),
            terminal_state: None,
        }
    }

    pub fn ingest_user_request(&mut self, id: &str, text: &str) -> Outcome<()> {
        if self.request_ids.iter().any(|known| known == id) {
            return Ok(());
        }
        self.request_ids.push(id.into());
        self.append(&obj! { "type" => "request", "id" => id, "text" => text, "timestamp" => now() })
    }

    /// A committed edit: the input fields, then each path's current state.
    pub fn record_change(
        &mut self,
        files: &crate::files::WorkspaceFiles,
        input: Json,
    ) -> Outcome<()> {
        let mut paths: Vec<String> = Vec::new();
        for path in input
            .get("paths")
            .and_then(Json::as_array)
            .into_iter()
            .flatten()
            .filter_map(Json::as_str)
        {
            if !paths.iter().any(|known| known == path) {
                paths.push(path.to_string());
            }
        }
        let states: Vec<Json> = paths
            .iter()
            .map(|path| {
                let hash = files
                    .read(path)
                    .map(|file| sha256_hex(&file.content))
                    .unwrap_or_else(|_| "absent".into());
                obj! { "path" => path.as_str(), "hash" => hash }
            })
            .collect();
        let mut event = obj! { "type" => "change" };
        event.extend(input);
        event.set("files", Json::Arr(states));
        event.set("timestamp", now());
        self.changes.push(event.clone());
        self.append(&event)
    }

    pub fn record_terminal(&mut self, state: &str) -> Outcome<()> {
        self.record_terminal_summary(state, None)
    }

    /// The terminal event, with finish_task's summary.
    pub fn record_terminal_summary(&mut self, state: &str, summary: Option<&str>) -> Outcome<()> {
        if self.terminal_state.is_some() {
            return Ok(());
        }
        self.terminal_state = Some(state.into());
        self.append(
            &obj! { "type" => "terminal", "state" => state }
                .with_opt("summary", summary)
                .with("timestamp", now()),
        )
    }

    /// A validation (a check a command ran, a formatter's output, the
    /// dependency consistency): the input fields in their order, then its id,
    /// paths (the session's changed paths by default), terminal, the paths'
    /// current states and the time, as `recordValidation` writes them.
    pub fn record_validation(
        &mut self,
        files: &crate::files::WorkspaceFiles,
        input: Json,
    ) -> Outcome<()> {
        let text = |key: &str| input.get(key).and_then(Json::as_str).map(str::to_string);
        let paths: Vec<String> = match input.get("paths").and_then(Json::as_array) {
            Some(paths) => paths
                .iter()
                .filter_map(Json::as_str)
                .map(str::to_string)
                .collect(),
            None => self.changed_paths(),
        };
        let terminal = text("terminal").unwrap_or_else(|| {
            match text("status").as_deref() {
                Some("passed") => "passed",
                Some("failed") => "failed",
                _ => "unknown",
            }
            .to_string()
        });
        let identity = text("command").or_else(|| text("taskId")).or_else(|| {
            text("evidenceOrigin").map(|origin| {
                Json::Arr(vec![
                    Json::from(origin),
                    Json::Arr(paths.iter().map(Json::from).collect()),
                ])
                .stringify()
            })
        });
        let id = text("id").unwrap_or_else(|| {
            format!(
                "validation://{}",
                sha256_hex(
                    format!("{}\0{}", identity.as_deref().unwrap_or("undefined"), now()).as_bytes()
                )
            )
        });
        let mut event = obj! { "type" => "validation" };
        event.extend(input);
        event.set("id", id);
        event.set("paths", Json::Arr(paths.iter().map(Json::from).collect()));
        event.set("terminal", terminal);
        event.set("files", Json::Arr(file_states(files, &paths)));
        event.set("timestamp", now());
        self.validations.push(event.clone());
        self.append(&event)
    }

    /// The validations recorded in this session, public fields only.
    pub fn current_validations(&self) -> Vec<Json> {
        self.validations.iter().map(public_validation).collect()
    }

    /// The session's net changed paths (re-read from the journal).
    pub fn current_changed_paths(&mut self, files: &crate::files::WorkspaceFiles) -> Vec<String> {
        self.hydrate();
        self.current_changes_by_path(files)
            .into_iter()
            .map(|(path, _)| path)
            .collect()
    }

    /// Every file change in recording order: `{ after, before?, path, timestamp }`.
    pub fn file_transitions(&mut self) -> Vec<Json> {
        self.hydrate();
        let mut transitions = Vec::new();
        for change in &self.changes {
            for path in strings(change.get("paths")) {
                let Some(after) = state_hash(change.get("files"), &path) else {
                    continue;
                };
                transitions.push(
                    obj! { "after" => after }
                        .with_opt("before", state_hash(change.get("beforeFiles"), &path))
                        .with("path", path.as_str())
                        .with(
                            "timestamp",
                            change.get("timestamp").cloned().unwrap_or(Json::Null),
                        ),
                );
            }
        }
        transitions
    }

    /// What finish_task and `@checks` judge: the session's current changes
    /// and the validations still current for the workspace's revision.
    pub fn completion_snapshot(
        &mut self,
        files: &crate::files::WorkspaceFiles,
        signal: &crate::failure::Signal,
    ) -> Outcome<Json> {
        self.hydrate();
        let snapshot = files.snapshot(signal)?;
        let current = self.current_changes_by_path(files);
        let mut changes: Vec<Json> = Vec::new();
        for (_, change) in &current {
            let public = public_change(change);
            if !changes.contains(&public) {
                changes.push(public);
            }
        }
        let revision = snapshot.revision.source_revision_id.clone();
        let validations = self.current_validation_events(files, &revision);
        let mut symbols: Vec<String> = Vec::new();
        for change in &changes {
            for symbol in strings(change.get("symbols")) {
                if !symbols.contains(&symbol) {
                    symbols.push(symbol);
                }
            }
        }
        let states: Vec<Json> = current
            .iter()
            .filter_map(|(path, change)| {
                state_hash(change.get("files"), path)
                    .map(|hash| obj! { "path" => path.as_str(), "hash" => hash })
            })
            .collect();
        Ok(obj! {
            "changedPaths" => Json::Arr(current.iter().map(|(path, _)| Json::from(path)).collect()),
            "changes" => Json::Arr(changes),
            "files" => Json::Arr(states),
            "sourceRevisionId" => revision,
            "symbols" => Json::Arr(symbols.into_iter().map(Json::from).collect()),
            "validations" => Json::Arr(validations.iter().map(public_validation).collect()),
        })
    }

    fn changed_paths(&self) -> Vec<String> {
        let mut paths: Vec<String> = Vec::new();
        for change in &self.changes {
            for path in strings(change.get("paths")) {
                if !paths.contains(&path) {
                    paths.push(path);
                }
            }
        }
        paths
    }

    /// Each changed path with its latest change, when that change still
    /// describes the file and differs from the file's state before the session.
    fn current_changes_by_path(&self, files: &crate::files::WorkspaceFiles) -> Vec<(String, Json)> {
        let mut latest: Vec<(String, &Json)> = Vec::new();
        let mut initial: Vec<(String, String)> = Vec::new();
        for change in &self.changes {
            for path in strings(change.get("paths")) {
                let known = latest.iter().position(|(known, _)| *known == path);
                if known.is_none()
                    && let Some(before) = state_hash(change.get("beforeFiles"), &path)
                {
                    initial.push((path.clone(), before));
                }
                match known {
                    Some(index) => latest[index].1 = change,
                    None => latest.push((path, change)),
                }
            }
        }
        latest
            .into_iter()
            .filter(|(path, change)| {
                let after = state_hash(change.get("files"), path);
                let before = initial
                    .iter()
                    .find(|(known, _)| known == path)
                    .map(|(_, hash)| hash.clone());
                after != before && file_state_current(files, path, change.get("files"))
            })
            .map(|(path, change)| (path, change.clone()))
            .collect()
    }

    fn current_validation_events(
        &self,
        files: &crate::files::WorkspaceFiles,
        revision: &str,
    ) -> Vec<Json> {
        let mut latest: Vec<(String, Json)> = Vec::new();
        for validation in &self.validations {
            if validation.get("sourceRevisionId").and_then(Json::as_str) != Some(revision) {
                continue;
            }
            let states = validation.get("files");
            if !strings_of_paths(states)
                .iter()
                .all(|path| file_state_current(files, path, states))
            {
                continue;
            }
            let text = |key: &str| validation.get(key).and_then(Json::as_str).map(Json::from);
            let identity = text("taskId").or_else(|| text("command")).or_else(|| {
                text("evidenceOrigin").map(|origin| {
                    Json::Arr(vec![
                        origin,
                        validation.get("paths").cloned().unwrap_or(Json::Null),
                    ])
                })
            });
            let key = Json::Arr(vec![
                text("cwd").unwrap_or_else(|| Json::from(".")),
                identity.unwrap_or(Json::Null),
                validation
                    .get("args")
                    .cloned()
                    .unwrap_or(Json::Arr(Vec::new())),
            ])
            .stringify();
            // A Map keeps the first insertion's position.
            match latest.iter_mut().find(|(known, _)| *known == key) {
                Some(slot) => slot.1 = validation.clone(),
                None => latest.push((key, validation.clone())),
            }
        }
        latest
            .into_iter()
            .map(|(_, validation)| validation)
            .collect()
    }

    pub fn record_observation_audit(&mut self, audit: ObservationAudit<'_>) -> Outcome<()> {
        self.append(&obj! {
            "tool" => audit.tool,
            "requestedView" => audit.requested_view,
            "renderedView" => audit.rendered_view,
            "bytes" => audit.bytes,
            "aliases" => audit.aliases,
            "limited" => audit.limited,
            "type" => "observation_audit",
            "timestamp" => now(),
        })
    }

    pub fn record_aliases(&mut self, entries: Vec<Json>) -> Outcome<()> {
        let skip = entries.len().saturating_sub(MAXIMUM_ALIASES);
        let aliases: Vec<Json> = entries.into_iter().skip(skip).collect();
        let digest = digest(&Json::Arr(aliases.clone()));
        if digest == self.aliases_digest {
            return Ok(());
        }
        let previous: Vec<(String, String)> = self
            .aliases
            .iter()
            .map(|entry| (alias_name(entry), entry.stringify()))
            .collect();
        self.aliases = aliases;
        self.aliases_digest = digest;
        // Rewriting all 500 aliases on every read made a story's journal 12 MB
        // (US-041). Most events carry only what changed, with a full list now
        // and then so a reload replays few of them.
        if !previous.is_empty() && self.alias_changes < FULL_ALIAS_LIST_EVERY {
            self.alias_changes += 1;
            let changed: Vec<Json> = self
                .aliases
                .iter()
                .filter(|entry| {
                    let name = alias_name(entry);
                    previous
                        .iter()
                        .find(|(known, _)| *known == name)
                        .map(|(_, text)| text.as_str())
                        != Some(entry.stringify().as_str())
                })
                .cloned()
                .collect();
            let order: Vec<Json> = self
                .aliases
                .iter()
                .map(|entry| Json::from(alias_name(entry)))
                .collect();
            return self.append(&obj! {
                "type" => "alias_changes",
                "order" => Json::Arr(order),
                "changed" => Json::Arr(changed),
                "timestamp" => now(),
            });
        }
        self.alias_changes = 0;
        let entries = Json::Arr(self.aliases.clone());
        self.append(&obj! { "type" => "aliases", "entries" => entries, "timestamp" => now() })
    }

    pub fn current_aliases(&self) -> &[Json] {
        &self.aliases
    }

    pub fn record_coverage(&mut self, state: Json) -> Outcome<()> {
        let digest = digest(&state);
        if digest == self.coverage_digest {
            return Ok(());
        }
        self.coverage = state.clone();
        self.coverage_digest = digest;
        self.append(&obj! { "type" => "coverage", "state" => state, "timestamp" => now() })
    }

    pub fn record_attention(&mut self, state: Json) -> Outcome<()> {
        let digest = digest(&state);
        if digest == self.attention_digest {
            return Ok(());
        }
        self.attention = Some(state.clone());
        self.attention_digest = digest;
        self.append(&obj! { "type" => "attention", "state" => state, "timestamp" => now() })
    }

    pub fn current_attention(&self) -> Option<&Json> {
        self.attention.as_ref()
    }

    pub fn current_coverage(&self) -> &Json {
        &self.coverage
    }

    /// `@changes`: the session's recorded changes, public fields only.
    pub fn current_changes(&self) -> Vec<Json> {
        self.changes.iter().map(public_change).collect()
    }

    pub fn validations(&self) -> &[Json] {
        &self.validations
    }

    pub fn terminal_state(&self) -> Option<&str> {
        self.terminal_state.as_deref()
    }

    pub fn hydrate(&mut self) {
        let events = self.read_events();
        self.changes = events
            .iter()
            .filter(|event| event_type(event) == "change")
            .cloned()
            .collect();
        self.validations = events
            .iter()
            .filter(|event| event_type(event) == "validation")
            .cloned()
            .collect();
        let (aliases, changes) = replayed_aliases(&events);
        let skip = aliases.len().saturating_sub(MAXIMUM_ALIASES);
        self.aliases = aliases.into_iter().skip(skip).collect();
        self.alias_changes = changes;
        self.aliases_digest = digest(&Json::Arr(self.aliases.clone()));
        if let Some(state) = events
            .iter()
            .rev()
            .find(|event| event_type(event) == "coverage")
            .and_then(|event| event.get("state"))
        {
            self.coverage = state.clone();
        }
        self.coverage_digest = digest(&self.coverage);
        if let Some(state) = events
            .iter()
            .rev()
            .find(|event| event_type(event) == "attention")
            .and_then(|event| event.get("state"))
        {
            self.attention = Some(state.clone());
        }
        self.attention_digest = self.attention.as_ref().map(digest).unwrap_or_default();
        self.request_ids = events
            .iter()
            .filter(|event| event_type(event) == "request")
            .filter_map(|event| event.get("id").and_then(Json::as_str).map(str::to_string))
            .collect();
        self.terminal_state = events
            .iter()
            .rev()
            .find(|event| event_type(event) == "terminal")
            .and_then(|event| {
                event
                    .get("state")
                    .and_then(Json::as_str)
                    .map(str::to_string)
            });
    }

    fn read_events(&self) -> Vec<Json> {
        let Ok(content) = fs::read(&self.file) else {
            return Vec::new();
        };
        String::from_utf8_lossy(&content)
            .split('\n')
            .filter(|line| !line.is_empty())
            .filter_map(|line| Json::parse(line).ok())
            .collect()
    }

    /// Appends one line, created with mode 0600 like the TypeScript journal.
    fn append(&self, event: &Json) -> Outcome<()> {
        let line = format!("{}\n", event.stringify());
        let directory = self.file.parent().expect("journal file has a directory");
        fs::create_dir_all(directory).map_err(|error| Failure::io(&error, "mkdir", directory))?;
        let mut file = crate::platform::private_file(OpenOptions::new().create(true).append(true))
            .open(&self.file)
            .map_err(|error| Failure::io(&error, "open", &self.file))?;
        file.write_all(line.as_bytes())
            .map_err(|error| Failure::io(&error, "write", &self.file))
    }
}

fn strings(value: Option<&Json>) -> Vec<String> {
    value
        .and_then(Json::as_array)
        .into_iter()
        .flatten()
        .filter_map(Json::as_str)
        .map(str::to_string)
        .collect()
}

fn strings_of_paths(states: Option<&Json>) -> Vec<String> {
    states
        .and_then(Json::as_array)
        .into_iter()
        .flatten()
        .filter_map(|state| state.get("path").and_then(Json::as_str).map(str::to_string))
        .collect()
}

fn state_hash(states: Option<&Json>, path: &str) -> Option<String> {
    states
        .and_then(Json::as_array)?
        .iter()
        .find(|state| state.get("path").and_then(Json::as_str) == Some(path))
        .and_then(|state| state.get("hash").and_then(Json::as_str).map(str::to_string))
}

fn file_states(files: &crate::files::WorkspaceFiles, paths: &[String]) -> Vec<Json> {
    let mut unique: Vec<&String> = Vec::new();
    for path in paths {
        if !unique.contains(&path) {
            unique.push(path);
        }
    }
    unique
        .into_iter()
        .map(|path| {
            let hash = files
                .read(path)
                .map(|file| sha256_hex(&file.content))
                .unwrap_or_else(|_| "absent".into());
            obj! { "path" => path.as_str(), "hash" => hash }
        })
        .collect()
}

fn file_state_current(
    files: &crate::files::WorkspaceFiles,
    path: &str,
    states: Option<&Json>,
) -> bool {
    let Some(expected) = state_hash(states, path) else {
        return false;
    };
    match files.read(path) {
        Ok(file) => sha256_hex(&file.content) == expected,
        Err(_) => expected == "absent",
    }
}

fn public_change(change: &Json) -> Json {
    obj! {
        "parse" => change.get("parse").cloned().unwrap_or(Json::Null),
        "paths" => change.get("paths").cloned().unwrap_or(Json::Arr(Vec::new())),
        "receipt" => change.get("receipt").cloned().unwrap_or(Json::Null),
        "symbols" => change.get("symbols").cloned().unwrap_or(Json::Arr(Vec::new())),
        "timestamp" => change.get("timestamp").cloned().unwrap_or(Json::Null),
    }
}

/// `publicValidation`: absent fields stay absent, as `undefined` does in JSON.
pub fn public_validation(validation: &Json) -> Json {
    let field = |key: &str| {
        validation
            .get(key)
            .filter(|value| !matches!(value, Json::Null))
            .cloned()
    };
    let args = field("args").filter(|args| args.as_array().is_some_and(|items| !items.is_empty()));
    obj! {}
        .with_opt("scope", field("scope"))
        .with_opt("args", args)
        .with_opt("check", field("check"))
        .with_opt("category", field("category"))
        .with_opt("command", field("command"))
        .with_opt("cwd", field("cwd"))
        .with_opt("evidenceOrigin", field("evidenceOrigin"))
        .with("id", validation.get("id").cloned().unwrap_or(Json::Null))
        .with(
            "paths",
            validation
                .get("paths")
                .cloned()
                .unwrap_or(Json::Arr(Vec::new())),
        )
        .with_opt("recovery", field("recovery"))
        .with_opt("sourceRevisionId", field("sourceRevisionId"))
        .with(
            "status",
            validation.get("status").cloned().unwrap_or(Json::Null),
        )
        .with_opt("taskId", field("taskId"))
        .with_opt("taskKind", field("taskKind"))
        .with(
            "terminal",
            validation.get("terminal").cloned().unwrap_or(Json::Null),
        )
        .with(
            "timestamp",
            validation.get("timestamp").cloned().unwrap_or(Json::Null),
        )
}

fn empty_coverage() -> Json {
    obj! { "entries" => Json::Arr(Vec::new()), "receiptSequence" => 0 }
}

fn digest(value: &Json) -> String {
    sha256_hex(value.stringify().as_bytes())
}

fn event_type(event: &Json) -> &str {
    event.get("type").and_then(Json::as_str).unwrap_or("")
}

fn alias_name(entry: &Json) -> String {
    entry
        .get("alias")
        .and_then(Json::as_str)
        .unwrap_or("")
        .to_string()
}

/// The alias list after the last full list and the changes recorded since.
fn replayed_aliases(events: &[Json]) -> (Vec<Json>, usize) {
    let mut aliases: Vec<Json> = Vec::new();
    let mut changes = 0;
    for event in events {
        match event_type(event) {
            "aliases" => {
                aliases = event
                    .get("entries")
                    .and_then(Json::as_array)
                    .cloned()
                    .unwrap_or_default();
                changes = 0;
            }
            "alias_changes" => {
                let mut by_alias: Vec<(String, Json)> = aliases
                    .iter()
                    .map(|entry| (alias_name(entry), entry.clone()))
                    .collect();
                for entry in event
                    .get("changed")
                    .and_then(Json::as_array)
                    .into_iter()
                    .flatten()
                {
                    let name = alias_name(entry);
                    match by_alias.iter_mut().find(|(known, _)| *known == name) {
                        Some(slot) => slot.1 = entry.clone(),
                        None => by_alias.push((name, entry.clone())),
                    }
                }
                aliases = event
                    .get("order")
                    .and_then(Json::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|name| {
                        let name = name.as_str()?;
                        by_alias
                            .iter()
                            .find(|(known, _)| known == name)
                            .map(|(_, entry)| entry.clone())
                    })
                    .collect();
                changes += 1;
            }
            _ => {}
        }
    }
    (aliases, changes)
}

/// `new Date().toISOString()`.
pub fn now() -> String {
    let elapsed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    iso_timestamp(elapsed.as_millis() as i64)
}

pub fn iso_timestamp(milliseconds: i64) -> String {
    let days = milliseconds.div_euclid(86_400_000);
    let rest = milliseconds.rem_euclid(86_400_000);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    if month <= 2 {
        year += 1;
    }
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3_600_000,
        rest / 60_000 % 60,
        rest / 1_000 % 60,
        rest % 1_000
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_iso_timestamps() {
        assert_eq!(iso_timestamp(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_timestamp(1_795_000_000_123), "2026-11-18T11:06:40.123Z");
    }

    #[test]
    fn replays_alias_changes_onto_the_last_full_list() {
        let events = vec![
            Json::parse(r#"{"type":"aliases","entries":[{"alias":"s1","kind":"path","path":"a"}]}"#).unwrap(),
            Json::parse(r#"{"type":"alias_changes","order":["s1","s2"],"changed":[{"alias":"s2","kind":"path","path":"b"}]}"#)
                .unwrap(),
        ];
        let (aliases, changes) = replayed_aliases(&events);
        assert_eq!(changes, 1);
        assert_eq!(
            Json::Arr(aliases).stringify(),
            r#"[{"alias":"s1","kind":"path","path":"a"},{"alias":"s2","kind":"path","path":"b"}]"#
        );
    }
}
