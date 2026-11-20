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
use std::os::unix::fs::OpenOptionsExt;
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

    pub fn record_terminal(&mut self, state: &str) -> Outcome<()> {
        if self.terminal_state.is_some() {
            return Ok(());
        }
        self.terminal_state = Some(state.into());
        self.append(&obj! { "type" => "terminal", "state" => state, "timestamp" => now() })
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
        self.changes
            .iter()
            .map(|change| {
                obj! {
                    "parse" => change.get("parse").cloned().unwrap_or(Json::Null),
                    "paths" => change.get("paths").cloned().unwrap_or(Json::Arr(Vec::new())),
                    "receipt" => change.get("receipt").cloned().unwrap_or(Json::Null),
                    "symbols" => change.get("symbols").cloned().unwrap_or(Json::Arr(Vec::new())),
                    "timestamp" => change.get("timestamp").cloned().unwrap_or(Json::Null),
                }
            })
            .collect()
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
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(&self.file)
            .map_err(|error| Failure::io(&error, "open", &self.file))?;
        file.write_all(line.as_bytes())
            .map_err(|error| Failure::io(&error, "write", &self.file))
    }
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
