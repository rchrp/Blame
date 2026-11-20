//! What a command changed in the workspace, recorded as its own change
//! (`command-changes.ts`).

use crate::failure::{Outcome, Signal};
use crate::files::{WorkspaceFiles, WorkspaceSnapshot};
use crate::identity::sha256_hex;
use crate::journal::SessionJournal;
use crate::json::Json;
use crate::obj;
use std::sync::Mutex;

/// The snapshot after the command and the paths it changed (none already
/// recorded by the session).
pub fn command_changes(
    files: &WorkspaceFiles,
    journal: &Mutex<SessionJournal>,
    before: &WorkspaceSnapshot,
) -> Outcome<(WorkspaceSnapshot, Vec<String>)> {
    let after = files.snapshot(&Signal::default())?;
    if before.revision.source_revision_id == after.revision.source_revision_id {
        return Ok((after, Vec::new()));
    }
    let mut journal = crate::workspace::lock(journal);
    let recorded = journal.current_changed_paths(files);
    let changes: Vec<(String, String)> = changed_files(files, before, &after)?
        .into_iter()
        .filter(|(path, _)| !recorded.contains(path))
        .collect();
    if changes.is_empty() {
        return Ok((after, Vec::new()));
    }
    let paths: Vec<String> = changes.iter().map(|(path, _)| path.clone()).collect();
    let revision = after.revision.source_revision_id.clone();
    journal.record_change(
        files,
        obj! {
            "beforeFiles" => Json::Arr(changes.iter().map(|(path, hash)| obj! { "path" => path.as_str(), "hash" => hash.as_str() }).collect()),
            "parse" => "not_supported",
            "paths" => Json::Arr(paths.iter().map(Json::from).collect()),
            "receipt" => format!("command-{revision}"),
            "sourceRevisionId" => revision.as_str(),
            "symbols" => Json::Arr(Vec::new()),
        },
    )?;
    Ok((after, paths))
}

/// Each changed path with its hash before the command.
fn changed_files(
    files: &WorkspaceFiles,
    before: &WorkspaceSnapshot,
    after: &WorkspaceSnapshot,
) -> Outcome<Vec<(String, String)>> {
    let state = |snapshot: &WorkspaceSnapshot, path: &str| {
        snapshot
            .file_states
            .iter()
            .find(|(known, _)| known == path)
            .map(|(_, hash)| hash.clone())
    };
    let committed = files.committed_changes(
        before.revision.base_commit.as_deref(),
        after.revision.base_commit.as_deref(),
    )?;
    let mut candidates: Vec<String> = Vec::new();
    for path in before
        .file_states
        .iter()
        .map(|(path, _)| path)
        .chain(after.file_states.iter().map(|(path, _)| path))
        .chain(committed.iter())
    {
        if !candidates.contains(path) {
            candidates.push(path.clone());
        }
    }
    let mut changes = Vec::new();
    for path in candidates {
        let (old, new) = (state(before, &path), state(after, &path));
        if old.is_some() && old == new {
            continue;
        }
        let hash = match old {
            Some(hash) => hash,
            None => baseline_hash(files, before, &path),
        };
        let next = match new {
            Some(hash) => hash,
            None => baseline_hash(files, after, &path),
        };
        if hash != next {
            changes.push((path, hash));
        }
    }
    Ok(changes)
}

fn baseline_hash(files: &WorkspaceFiles, snapshot: &WorkspaceSnapshot, path: &str) -> String {
    match (&snapshot.git, &snapshot.revision.base_commit) {
        (true, Some(commit)) => files
            .baseline(path, commit)
            .ok()
            .flatten()
            .map_or_else(|| "absent".into(), |(content, _)| sha256_hex(&content)),
        _ => "absent".into(),
    }
}
