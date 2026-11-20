//! Workspace snapshots.
//!
//! Implements the core's `Checkpointer` with git trees kept under a private
//! ref namespace, so snapshots never touch the branch, the index or the
//! stash, and survive any later commit, merge or rebase.
//!
//! # How it works
//!
//! * A snapshot is a **tree** of every file that is tracked, or untracked and
//!   not ignored. It is built from a private index file (one per session, kept
//!   inside the git directory), never the user's. Because that index keeps the
//!   stat data of the files it has seen, a snapshot after a small edit reads
//!   only the edited files.
//! * The tree is pointed at by `refs/blame/checkpoints/<session>/<id>`, which
//!   keeps it from being garbage collected. A tree rather than a commit: no
//!   author identity is needed (a fresh VM has none), and `git log --all` and
//!   graph views skip refs that do not point at a commit. The reference
//!   returned to the engine is the tree's object id, so a restarted engine can
//!   restore it as long as the object exists.
//! * A restore checks the tree out into a *copy* of that private index with
//!   `git read-tree --reset -u`: files that differ are rewritten, files that
//!   are in the index but not in the tree are deleted (with the directories
//!   that became empty), everything else is not touched, ignored files
//!   included. HEAD, the branch, the stash and the user's index are never
//!   written. If the process dies halfway, running the restore again
//!   finishes the job: the copy is re-synchronised with the disk first.
//! * A workspace that is not the top of a git work tree (a plain folder, or a
//!   subdirectory of a repository) gets a private bare repository under the
//!   location given at construction, with the workspace as its work tree.
//!
//! # Decisions
//!
//! * **The user's index is left as it is** by `restore`: it is the user's
//!   staging area, and rewinding the agent's file changes is not a reason to
//!   unstage anything. Paths the agent staged and that a restore deletes show
//!   up in `git status` as staged additions that are missing from the disk.
//! * **Empty directories** cannot be stored by git. They are neither saved nor
//!   recreated; directories a restore empties are removed.
//! * **Submodules and nested repositories** are not part of a snapshot and a
//!   restore does not touch them.
//! * **Files are saved the way git would add them**: `core.autocrlf` and
//!   `.gitattributes` conversions apply on both sides, so a restored file is
//!   what `git checkout` would have written.
//! * **Special files** (sockets, FIFOs) and unreadable files: the former are
//!   skipped, the latter make the snapshot fail with the path in the error.
//!
//! # Cost
//!
//! The first snapshot of a git checkout seeds its index from the user's, so
//! it costs about what `git status` costs, plus one object per file that
//! differs from the repository's. In a folder that is not a repository every
//! file is read, compressed and written once to the private repository: the
//! time and disk space are proportional to the folder's size (see the
//! measurements in the crate's notes). Later snapshots pay only for what
//! changed. Objects from released snapshots stay in the repository until the
//! user's own `git gc` prunes them; this crate never runs gc.

mod git;
mod workspace;

use async_trait::async_trait;
use blame_engine_core::ports::{CheckpointError, Checkpointer, PathChange, PathChangeKind};
use blame_engine_protocol::SessionId;
use git::nul_records;
use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use workspace::{Options, Workspace, io_error};

/// Patterns (in `.gitignore` syntax) for what Blame itself writes into a
/// workspace and a rewind must not touch: its own directory, and the
/// developer's env files that it copies in for previews (secrets, and not the
/// agent's work).
pub const BLAME_WORKSPACE_EXCLUDES: &[&str] = &[
    ".blame/",
    ".env",
    ".env.*",
    "!*.example",
    "!*.sample",
    "!*.template",
];

const REF_PREFIX: &str = "refs/blame/checkpoints";

/// `Checkpointer` on the `git` command line.
#[derive(Clone)]
pub struct GitCheckpointer {
    inner: Arc<Inner>,
}

struct Inner {
    options: Options,
    counter: AtomicU64,
    /// One lock per session index file: operations of a session never overlap
    /// in this process; other sessions are independent.
    locks: Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>,
}

impl GitCheckpointer {
    /// `private_root` is where the git directories of workspaces that are not
    /// repositories are created. It must not be inside a workspace.
    pub fn new(private_root: impl Into<PathBuf>) -> Self {
        Self {
            inner: Arc::new(Inner {
                options: Options {
                    git_program: OsString::from("git"),
                    private_root: private_root.into(),
                    exclude: Vec::new(),
                },
                counter: AtomicU64::new(0),
                locks: Mutex::new(HashMap::new()),
            }),
        }
    }

    /// Leaves paths matching these `.gitignore`-style patterns out of
    /// snapshots and out of restores, whether tracked or not. See
    /// [`BLAME_WORKSPACE_EXCLUDES`].
    pub fn with_excludes(self, patterns: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.configure(|options| options.exclude = patterns.into_iter().map(Into::into).collect())
    }

    /// Uses this `git` executable instead of the one on `PATH`.
    pub fn with_git_program(self, program: impl Into<OsString>) -> Self {
        let program = program.into();
        self.configure(|options| options.git_program = program)
    }

    fn configure(self, change: impl FnOnce(&mut Options)) -> Self {
        // Construction time: nothing else holds the Arc yet.
        let mut inner = Arc::try_unwrap(self.inner)
            .unwrap_or_else(|_| unreachable!("configured before being shared"));
        change(&mut inner.options);
        Self {
            inner: Arc::new(inner),
        }
    }
}

#[async_trait]
impl Checkpointer for GitCheckpointer {
    // The git work is blocking child processes; these run on the blocking
    // pool. Dropping the future does not cancel work that already started: a
    // restore in flight still finishes, which is what keeps it consistent.
    async fn snapshot(
        &self,
        workspace_root: &Path,
        session: &SessionId,
    ) -> Result<String, CheckpointError> {
        let (inner, root, session) = (
            self.inner.clone(),
            workspace_root.to_owned(),
            session.clone(),
        );
        blocking(move || inner.snapshot(&root, session.as_str())).await
    }

    async fn restore(&self, workspace_root: &Path, snapshot: &str) -> Result<(), CheckpointError> {
        let (inner, root, snapshot) = (
            self.inner.clone(),
            workspace_root.to_owned(),
            snapshot.to_owned(),
        );
        blocking(move || inner.restore(&root, &snapshot)).await
    }

    async fn changes(
        &self,
        workspace_root: &Path,
        from: &str,
        to: Option<&str>,
    ) -> Result<Vec<PathChange>, CheckpointError> {
        let (inner, root) = (self.inner.clone(), workspace_root.to_owned());
        let (from, to) = (from.to_owned(), to.map(str::to_owned));
        blocking(move || inner.changes(&root, &from, to.as_deref())).await
    }

    async fn release(
        &self,
        workspace_root: &Path,
        session: &SessionId,
    ) -> Result<(), CheckpointError> {
        let (inner, root, session) = (
            self.inner.clone(),
            workspace_root.to_owned(),
            session.clone(),
        );
        blocking(move || inner.release(&root, session.as_str())).await
    }
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, CheckpointError> + Send + 'static,
) -> Result<T, CheckpointError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| CheckpointError::Failed(format!("checkpoint task failed: {error}")))?
}

impl Inner {
    fn open(&self, root: &Path, create: bool) -> Result<Option<Workspace>, CheckpointError> {
        Workspace::open(&self.options, root, create)
    }

    fn lock(&self, index: &Path) -> Arc<Mutex<()>> {
        let mut locks = self
            .locks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        locks.entry(index.to_owned()).or_default().clone()
    }

    fn scratch_index(&self, workspace: &Workspace, purpose: &str) -> PathBuf {
        sweep_scratch(&workspace.meta);
        let count = self.counter.fetch_add(1, Ordering::Relaxed);
        workspace.meta.join(format!(
            "{SCRATCH_PREFIX}{purpose}-{}-{count}.index",
            std::process::id()
        ))
    }

    fn snapshot(&self, root: &Path, session: &str) -> Result<String, CheckpointError> {
        let key = session_key(session)?;
        let workspace = self.open(root, true)?.ok_or_else(|| unsupported(root))?;
        let index = workspace.meta.join(format!("{key}.index"));
        let lock = self.lock(&index);
        let _held = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        // A snapshot killed while git held this index's lock leaves the lock
        // behind, and nothing else would ever remove it. A session has one
        // engine, and this process is the only one touching it right now.
        remove_if_exists(&lock_file(&index))?;

        let tree = match write_tree(&workspace, &index) {
            Ok(tree) => tree,
            Err(_) => {
                // The index is only a cache: a copy that git cannot read any
                // more (shared index gone, an object pruned) is rebuilt.
                let _ = std::fs::remove_file(&index);
                write_tree(&workspace, &index)?
            }
        };
        let id = self.next_id();
        let reference = format!("{REF_PREFIX}/{key}/{id}");
        workspace
            .git
            .run(&["update-ref", &reference, &tree], None, None)?;
        Ok(tree)
    }

    fn restore(&self, root: &Path, snapshot: &str) -> Result<(), CheckpointError> {
        let workspace = self
            .open(root, false)?
            .ok_or_else(|| CheckpointError::MissingSnapshot(snapshot.to_owned()))?;
        let tree = resolve_tree(&workspace, snapshot)?;
        // A restore is not tied to a session. It works on a scratch index of
        // its own, named for this call so that a scratch left by a killed
        // process (and its lock) can never get in the way; the worktree's
        // restores take turns.
        let turn = self.lock(&workspace.meta.join("worktree"));
        let _held = turn.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let index = self.scratch_index(&workspace, "restore");
        let result = (|| {
            // Describes the disk as it is, without storing its objects: this
            // state is about to be thrown away. Everything not in the
            // snapshot is in this index, so the checkout below deletes it.
            workspace.sync_index(&index, true)?;
            workspace.git.run(
                &["read-tree", "--reset", "-u", "--no-sparse-checkout", &tree],
                Some(&index),
                None,
            )?;
            Ok(())
        })();
        // Never kept: its entries were hashed without storing objects.
        remove_scratch(&index);
        result
    }

    fn changes(
        &self,
        root: &Path,
        from: &str,
        to: Option<&str>,
    ) -> Result<Vec<PathChange>, CheckpointError> {
        let workspace = self
            .open(root, false)?
            .ok_or_else(|| CheckpointError::MissingSnapshot(from.to_owned()))?;
        let from_tree = resolve_tree(&workspace, from)?;
        let output = match to {
            Some(to) => {
                let to_tree = resolve_tree(&workspace, to)?;
                workspace.git.run(
                    &[
                        "diff-tree",
                        "-r",
                        "-z",
                        "--raw",
                        "--no-renames",
                        &from_tree,
                        &to_tree,
                    ],
                    None,
                    None,
                )?
            }
            None => {
                let turn = self.lock(&workspace.meta.join("worktree"));
                let _held = turn.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                let index = self.scratch_index(&workspace, "changes");
                let result = (|| {
                    workspace.sync_index(&index, true)?;
                    workspace.git.run(
                        &[
                            "diff-index",
                            "--cached",
                            "-r",
                            "-z",
                            "--raw",
                            "--no-renames",
                            &from_tree,
                        ],
                        Some(&index),
                        None,
                    )
                })();
                remove_scratch(&index);
                result?
            }
        };
        Ok(parse_raw_diff(&output))
    }

    fn release(&self, root: &Path, session: &str) -> Result<(), CheckpointError> {
        let key = session_key(session)?;
        let Some(workspace) = self.open(root, false)? else {
            return Ok(());
        };
        let index = workspace.meta.join(format!("{key}.index"));
        let lock = self.lock(&index);
        {
            let _held = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let prefix = format!("{REF_PREFIX}/{key}/");
            let listing = workspace.git.run(
                &["for-each-ref", "--format=%(refname)", &prefix],
                None,
                None,
            )?;
            let commands: Vec<u8> = String::from_utf8_lossy(&listing)
                .lines()
                .filter(|line| !line.is_empty())
                .flat_map(|name| format!("delete {name}\0\0").into_bytes())
                .collect();
            if !commands.is_empty() {
                workspace
                    .git
                    .run(&["update-ref", "--stdin", "-z"], None, Some(&commands))?;
            }
            remove_if_exists(&index)?;
        }
        self.locks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&index);
        if let Some(private) = &workspace.private_repo {
            // Nothing else is kept in a private repository: when the last
            // snapshot is released, so is its disk space.
            let remaining = workspace.git.run(
                &[
                    "for-each-ref",
                    "--count=1",
                    "--format=%(refname)",
                    REF_PREFIX,
                ],
                None,
                None,
            )?;
            if remaining.iter().all(u8::is_ascii_whitespace) {
                std::fs::remove_dir_all(private).map_err(|error| io_error(private, error))?;
            }
        }
        Ok(())
    }

    fn next_id(&self) -> String {
        let count = self.counter.fetch_add(1, Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        // The process id keeps two engines on one repository apart.
        format!("{nanos:x}-{:x}-{count:x}", std::process::id())
    }
}

const SCRATCH_PREFIX: &str = "scratch-";

fn lock_file(index: &Path) -> PathBuf {
    let mut name = index.as_os_str().to_owned();
    name.push(".lock");
    PathBuf::from(name)
}

fn remove_scratch(index: &Path) {
    let _ = std::fs::remove_file(index);
    let _ = std::fs::remove_file(lock_file(index));
}

/// Removes scratch indexes (and locks) that a killed process left behind.
/// Anything younger than ten minutes may belong to a live operation.
fn sweep_scratch(meta: &Path) {
    let Ok(entries) = std::fs::read_dir(meta) else {
        return;
    };
    for entry in entries.flatten() {
        let old = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age > std::time::Duration::from_secs(600));
        if old
            && entry
                .file_name()
                .to_string_lossy()
                .starts_with(SCRATCH_PREFIX)
        {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

fn unsupported(root: &Path) -> CheckpointError {
    CheckpointError::Unsupported(root.display().to_string())
}

fn remove_if_exists(path: &Path) -> Result<(), CheckpointError> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(io_error(path, error)),
    }
}

fn write_tree(workspace: &Workspace, index: &Path) -> Result<String, CheckpointError> {
    workspace.sync_index(index, false)?;
    let output = workspace.git.run(&["write-tree"], Some(index), None)?;
    Ok(String::from_utf8_lossy(&output).trim().to_owned())
}

/// The tree a snapshot reference names, if it still exists.
fn resolve_tree(workspace: &Workspace, snapshot: &str) -> Result<String, CheckpointError> {
    let missing = || CheckpointError::MissingSnapshot(snapshot.to_owned());
    // Only a full object id: nothing that git could read as an option or as
    // a revision expression.
    let valid_length = snapshot.len() == 40 || snapshot.len() == 64;
    if !valid_length || !snapshot.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(missing());
    }
    let revision = format!("{snapshot}^{{tree}}");
    let (code, output) = workspace.git.run_checked(
        &["rev-parse", "--verify", "--quiet", &revision],
        None,
        None,
        &[0, 1],
    )?;
    if code != 0 {
        return Err(missing());
    }
    Ok(String::from_utf8_lossy(&output).trim().to_owned())
}

/// A session id as one path and ref component, the same on every platform:
/// anything but lowercase letters, digits, `-` and `_` is escaped, which also
/// keeps ids apart on case-insensitive filesystems.
fn session_key(session: &str) -> Result<String, CheckpointError> {
    if session.is_empty() {
        return Err(CheckpointError::Failed("empty session id".into()));
    }
    let mut key = String::with_capacity(session.len());
    for byte in session.bytes() {
        match byte {
            b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' => key.push(byte as char),
            other => key.push_str(&format!("%{other:02x}")),
        }
    }
    Ok(key)
}

/// `:<mode> <mode> <sha> <sha> <status>\0<path>\0` records.
fn parse_raw_diff(output: &[u8]) -> Vec<PathChange> {
    let mut records = nul_records(output);
    let mut changes = Vec::new();
    while let (Some(meta), Some(path)) = (records.next(), records.next()) {
        let status = meta.rsplit(|b| *b == b' ').next().and_then(|s| s.first());
        let kind = match status {
            Some(b'A') => PathChangeKind::Added,
            Some(b'D') => PathChangeKind::Deleted,
            // A file that became a symlink (T) is a change of that file.
            _ => PathChangeKind::Modified,
        };
        changes.push(PathChange {
            path: String::from_utf8_lossy(path).into_owned(),
            kind,
        });
    }
    changes
}
