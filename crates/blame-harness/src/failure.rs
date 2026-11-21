//! Errors as the harness reports them: a message the model reads, and the
//! Node error code some recoveries look at (`ENOENT` for a missing path).

use crate::json::Json;
use std::io;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Clone, Debug)]
pub struct Failure {
    pub message: String,
    /// The Node `error.code` of a file-system failure.
    pub code: Option<&'static str>,
    /// `SymbolResolutionError.candidates`, shown as the blocked result's recovery.
    pub candidates: Vec<Json>,
    pub cancelled: bool,
    /// `LightCommitConflict`: the worktree changed under an edit.
    pub conflict: bool,
    /// A scoped patch's recovery text (`ScopedEditRecovery`).
    pub recovery: Option<String>,
    /// A refused finish: the checks still failing, by task.
    /// Boxed so `Failure` stays small enough to return.
    pub failing_checks: Box<[String]>,
}

pub type Outcome<T> = Result<T, Failure>;

impl Failure {
    pub fn new(message: impl Into<String>) -> Failure {
        Failure {
            message: message.into(),
            code: None,
            candidates: Vec::new(),
            cancelled: false,
            conflict: false,
            recovery: None,
            failing_checks: Box::default(),
        }
    }

    pub fn conflict(message: impl Into<String>) -> Failure {
        Failure {
            conflict: true,
            ..Failure::new(message)
        }
    }

    pub fn symbol(message: impl Into<String>, candidates: Vec<Json>) -> Failure {
        Failure {
            candidates,
            ..Failure::new(message)
        }
    }

    pub fn cancelled() -> Failure {
        Failure {
            cancelled: true,
            ..Failure::new("Semantic workspace operation cancelled.")
        }
    }

    /// A Node `fs` error: `ENOENT: no such file or directory, lstat '/x'`.
    pub fn io(error: &io::Error, syscall: &str, path: &Path) -> Failure {
        let (code, description) = node_error(error);
        Failure {
            code: Some(code),
            ..Failure::new(format!(
                "{code}: {description}, {syscall} '{}'",
                path.display()
            ))
        }
    }

    pub fn is_missing(&self) -> bool {
        self.code == Some("ENOENT")
    }
}

impl From<String> for Failure {
    fn from(message: String) -> Self {
        Failure::new(message)
    }
}

impl From<&str> for Failure {
    fn from(message: &str) -> Self {
        Failure::new(message)
    }
}

fn node_error(error: &io::Error) -> (&'static str, &'static str) {
    use io::ErrorKind::*;
    match error.kind() {
        NotFound => ("ENOENT", "no such file or directory"),
        NotADirectory => ("ENOTDIR", "not a directory"),
        PermissionDenied => ("EACCES", "permission denied"),
        IsADirectory => ("EISDIR", "illegal operation on a directory"),
        _ => match error.raw_os_error() {
            // ELOOP and ENAMETOOLONG have no stable ErrorKind yet.
            Some(code) if code == if cfg!(target_os = "linux") { 40 } else { 62 } => {
                ("ELOOP", "too many symbolic links encountered")
            }
            Some(code) if code == if cfg!(target_os = "linux") { 36 } else { 63 } => {
                ("ENAMETOOLONG", "name too long")
            }
            _ => ("EIO", "i/o error"),
        },
    }
}

/// An operation's cancellation, set by a `cancel` message or a closed pipe.
#[derive(Clone, Default, Debug)]
pub struct Signal(Arc<AtomicBool>);

impl Signal {
    pub fn abort(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn aborted(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }

    /// `signal.throwIfAborted()`.
    pub fn check(&self) -> Outcome<()> {
        if self.aborted() {
            Err(Failure::cancelled())
        } else {
            Ok(())
        }
    }
}
