//! Commits of edits (`light-commit.ts`): under the workspace lock, check the
//! source revision and each file's preimage, record every mutation in
//! `pending.json` before writing, write files atomically, and roll back on a
//! failure. A pending record left by a crash (of either implementation) is
//! recovered before the next locked operation, as in TypeScript.

use crate::failure::{Failure, Outcome, Signal};
use crate::files::WorkspaceFiles;
use crate::identity::sha256_hex;
use crate::json::Json;
use crate::lock::WorkspaceLock;
use crate::obj;
use crate::pathx;
use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct Mutation {
    pub after: Option<Vec<u8>>,
    pub before: Option<Vec<u8>>,
    pub mode: Option<u32>,
    pub path: String,
}

pub struct CommitResult {
    pub changed_paths: Vec<String>,
    pub source_revision_id: String,
}

fn pending_file(files: &WorkspaceFiles) -> PathBuf {
    Path::new(&files.root)
        .join(".blame")
        .join("harness")
        .join("light-write")
        .join("pending.json")
}

/// The workspace lock, after recovering an interrupted write.
pub fn locked(files: &WorkspaceFiles) -> Outcome<WorkspaceLock> {
    let lock = WorkspaceLock::acquire(&files.root)?;
    recover_interrupted_write(files)?;
    Ok(lock)
}

fn content_hash(content: Option<&[u8]>) -> Option<String> {
    content.map(sha256_hex)
}

fn optional_content(files: &WorkspaceFiles, path: &str) -> Outcome<Option<Vec<u8>>> {
    match files.read(path) {
        Ok(file) => Ok(Some(file.content)),
        Err(failure) if failure.is_missing() => Ok(None),
        Err(failure) => Err(failure),
    }
}

fn recover_interrupted_write(files: &WorkspaceFiles) -> Outcome<()> {
    let pending = pending_file(files);
    let source = match fs::read(&pending) {
        Ok(source) => String::from_utf8_lossy(&source).into_owned(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(Failure::io(&error, "open", &pending)),
    };
    if source.is_empty() {
        return Ok(());
    }
    let mutations = decode_mutations(&source)?;
    for mutation in &mutations {
        let current = content_hash(optional_content(files, &mutation.path)?.as_deref());
        if current != content_hash(mutation.before.as_deref())
            && current != content_hash(mutation.after.as_deref())
        {
            return Err(Failure::conflict(format!(
                "Interrupted edit conflicts with a newer change in {}; automatic recovery preserved the worktree.",
                mutation.path
            )));
        }
    }
    restore_files(files, &mutations, true)?;
    fs::remove_file(&pending).map_err(|error| Failure::io(&error, "rm", &pending))
}

/// Writes each mutation's `before` back, last first.
pub fn restore_files(
    files: &WorkspaceFiles,
    mutations: &[Mutation],
    require_owned_state: bool,
) -> Outcome<()> {
    for mutation in mutations.iter().rev() {
        if require_owned_state {
            let current = content_hash(optional_content(files, &mutation.path)?.as_deref());
            if current == content_hash(mutation.before.as_deref()) {
                continue;
            }
            if current != content_hash(mutation.after.as_deref()) {
                return Err(Failure::conflict(format!(
                    "Recovery preserved a concurrent change in {}.",
                    mutation.path
                )));
            }
        }
        write_mutation(files, mutation, false)?;
    }
    Ok(())
}

pub fn commit(
    files: &WorkspaceFiles,
    mutations: &[Mutation],
    expected_revision: &str,
    signal: &Signal,
) -> Outcome<CommitResult> {
    signal.check()?;
    let _lock = locked(files)?;
    if files.snapshot(signal)?.revision.source_revision_id != expected_revision {
        return Err(Failure::conflict(
            "The worktree changed while the edit batch was being prepared.",
        ));
    }
    let changed: Vec<&Mutation> = mutations
        .iter()
        .filter(|mutation| {
            content_hash(mutation.before.as_deref()) != content_hash(mutation.after.as_deref())
        })
        .collect();
    for mutation in &changed {
        let path = files.normalize_path(&mutation.path)?;
        if path != mutation.path {
            return Err(Failure::conflict(format!(
                "Edit path is not canonical: {path}."
            )));
        }
        resolve_for_write_verified(files, &path)?;
        if content_hash(optional_content(files, &path)?.as_deref())
            != content_hash(mutation.before.as_deref())
        {
            return Err(Failure::conflict(format!(
                "File changed before commit: {path}."
            )));
        }
    }
    signal.check()?;
    apply_all(files, &changed)?;
    let snapshot = files.snapshot(signal)?;
    Ok(CommitResult {
        changed_paths: changed
            .iter()
            .map(|mutation| mutation.path.clone())
            .collect(),
        source_revision_id: snapshot.revision.source_revision_id,
    })
}

fn apply_all(files: &WorkspaceFiles, mutations: &[&Mutation]) -> Outcome<()> {
    if mutations.is_empty() {
        return Ok(());
    }
    let pending = pending_file(files);
    let record = Json::Arr(
        mutations
            .iter()
            .map(|mutation| encode_mutation(mutation))
            .collect(),
    )
    .stringify();
    write_file_atomic(&pending, record.as_bytes(), 0o600)?;
    let mut applied: Vec<Mutation> = Vec::new();
    for mutation in mutations {
        applied.push((*mutation).clone());
        if let Err(error) = write_mutation(files, mutation, true) {
            if let Err(rollback) = restore_files(files, &applied, true) {
                return Err(Failure::new(format!(
                    "Edit rollback failed; recovery is pending. {} {}",
                    error.message, rollback.message
                )));
            }
            let _ = fs::remove_file(&pending);
            return Err(error);
        }
    }
    fs::remove_file(&pending).map_err(|error| Failure::io(&error, "rm", &pending))
}

fn encode_mutation(mutation: &Mutation) -> Json {
    let encoded = |content: &Option<Vec<u8>>| {
        content.as_ref().map_or(Json::Null, |content| {
            Json::from(crate::base64::encode(content))
        })
    };
    obj! { "after" => encoded(&mutation.after), "before" => encoded(&mutation.before) }
        .with_opt("mode", mutation.mode)
        .with("path", mutation.path.as_str())
}

/// `pendingMutationsSchema`: strict entries of base64 or null contents.
fn decode_mutations(source: &str) -> Outcome<Vec<Mutation>> {
    let invalid = || Failure::new("The pending edit record is invalid.");
    let value = Json::parse(source).map_err(|_| invalid())?;
    let entries = value.as_array().ok_or_else(invalid)?;
    entries
        .iter()
        .map(|entry| {
            let fields = entry.as_object().ok_or_else(invalid)?;
            if fields
                .iter()
                .any(|(key, _)| !["after", "before", "mode", "path"].contains(&key.as_str()))
            {
                return Err(invalid());
            }
            let content = |key: &str| match entry.get(key) {
                Some(Json::Null) => Ok(None),
                Some(Json::Str(text)) => Ok(Some(crate::base64::decode(text))),
                _ => Err(invalid()),
            };
            Ok(Mutation {
                after: content("after")?,
                before: content("before")?,
                mode: entry
                    .get("mode")
                    .and_then(Json::as_f64)
                    .map(|mode| mode as u32),
                path: entry
                    .get("path")
                    .and_then(Json::as_str)
                    .filter(|path| !path.is_empty())
                    .ok_or_else(invalid)?
                    .to_string(),
            })
        })
        .collect()
}

/// `resolveForWriteVerified`: the nearest existing ancestor stays inside the root.
fn resolve_for_write_verified(files: &WorkspaceFiles, path: &str) -> Outcome<String> {
    let absolute = files.resolve_for_write(path)?;
    let root = fs::canonicalize(&files.root)
        .map_err(|error| Failure::io(&error, "realpath", Path::new(&files.root)))?;
    let mut ancestor = absolute.clone();
    while ancestor != files.root {
        match fs::canonicalize(&ancestor) {
            Ok(resolved) => {
                if pathx::escapes(&pathx::relative(
                    &root.to_string_lossy(),
                    &resolved.to_string_lossy(),
                )) {
                    return Err(Failure::new(
                        "Write target resolves outside the workspace root.",
                    ));
                }
                return Ok(absolute);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                ancestor = pathx::resolve(&ancestor, "..")
            }
            Err(error) => return Err(Failure::io(&error, "realpath", Path::new(&ancestor))),
        }
    }
    Ok(absolute)
}

fn write_mutation(files: &WorkspaceFiles, mutation: &Mutation, after: bool) -> Outcome<()> {
    let absolute = PathBuf::from(resolve_for_write_verified(files, &mutation.path)?);
    match if after {
        &mutation.after
    } else {
        &mutation.before
    } {
        None => match fs::remove_file(&absolute) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                Err(Failure::io(&error, "rm", &absolute))
            }
            _ => Ok(()),
        },
        Some(content) => {
            if let Some(parent) = absolute.parent() {
                fs::create_dir_all(parent).map_err(|error| Failure::io(&error, "mkdir", parent))?;
            }
            write_file_atomic(&absolute, content, mutation.mode.unwrap_or(0o644))
        }
    }
}

/// write-file-atomic: a temporary sibling, synced, given its mode, renamed over.
fn write_file_atomic(path: &Path, content: &[u8], mode: u32) -> Outcome<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| Failure::io(&error, "mkdir", parent))?;
    }
    let unique = sha256_hex(
        format!(
            "{}{:?}{}",
            path.display(),
            std::time::SystemTime::now(),
            std::process::id()
        )
        .as_bytes(),
    );
    let temporary = PathBuf::from(format!("{}.{}", path.display(), &unique[..8]));
    let result = (|| {
        let mut file = fs::File::create(&temporary)?;
        file.write_all(content)?;
        file.sync_all()?;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(mode))?;
        fs::rename(&temporary, path)
    })();
    result.map_err(|error| {
        let _ = fs::remove_file(&temporary);
        Failure::io(&error, "open", path)
    })
}
