#![allow(dead_code)]

use blame_engine_checkpoint::GitCheckpointer;
use blame_engine_core::ports::{Checkpointer, PathChange, PathChangeKind};
use blame_engine_protocol::SessionId;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

/// A directory that is removed when dropped.
pub struct Tmp(pub PathBuf);

impl Tmp {
    pub fn new() -> Self {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let dir = std::fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!(
                "blame-checkpoint-test-{}-{}",
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub fn git(dir: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .current_dir(dir)
        .args([
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "protocol.file.allow=always",
        ])
        .args(args)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@t")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@t")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).into_owned()
}

/// Like `git` but tolerates failure (a conflicting merge, for instance).
pub fn git_lenient(dir: &Path, args: &[&str]) {
    let _ = Command::new("git")
        .current_dir(dir)
        .args(args)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@t")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@t")
        .output()
        .unwrap();
}

/// A repository with one commit holding `a.txt` and `dir/b.txt`.
pub fn repo(tmp: &Tmp) -> PathBuf {
    let root = tmp.path().join("repo");
    std::fs::create_dir_all(root.join("dir")).unwrap();
    git(&root, &["init", "-q", "-b", "main", "."]);
    git(&root, &["config", "user.email", "t@t"]);
    git(&root, &["config", "user.name", "t"]);
    git(&root, &["config", "commit.gpgsign", "false"]);
    write(&root, "a.txt", "a\n");
    write(&root, "dir/b.txt", "b\n");
    write(&root, ".gitignore", "node_modules/\n.env\n*.log\n");
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-q", "-m", "one"]);
    root
}

pub fn checkpointer(tmp: &Tmp) -> GitCheckpointer {
    GitCheckpointer::new(tmp.path().join("private"))
}

pub fn session(name: &str) -> SessionId {
    SessionId::from(name)
}

pub fn write(root: &Path, relative: &str, content: &str) {
    write_bytes(root, relative, content.as_bytes());
}

pub fn write_bytes(root: &Path, relative: &str, content: &[u8]) {
    let path = root.join(relative);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, content).unwrap();
}

pub fn read(root: &Path, relative: &str) -> String {
    std::fs::read_to_string(root.join(relative)).unwrap()
}

pub fn exists(root: &Path, relative: &str) -> bool {
    std::fs::symlink_metadata(root.join(relative)).is_ok()
}

/// Everything in the workspace but `.git`, as `path -> description`:
/// directories (when asked), file content with the executable bit, symlink
/// targets. Ignored files included: a restore must leave those alone, so the
/// tests compare them too.
pub fn state(root: &Path, with_dirs: bool) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    walk(root, root, with_dirs, &mut out);
    out
}

fn walk(root: &Path, dir: &Path, with_dirs: bool, out: &mut BTreeMap<String, String>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let entry = entry.unwrap();
        let path = entry.path();
        let relative = path
            .strip_prefix(root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        if relative == ".git" {
            continue;
        }
        let meta = std::fs::symlink_metadata(&path).unwrap();
        if meta.file_type().is_symlink() {
            let target = std::fs::read_link(&path).unwrap();
            out.insert(relative, format!("link -> {}", target.display()));
        } else if meta.is_dir() {
            if with_dirs {
                out.insert(relative.clone(), "dir".into());
            }
            walk(root, &path, with_dirs, out);
        } else {
            #[cfg(unix)]
            let exec = {
                use std::os::unix::fs::PermissionsExt;
                meta.permissions().mode() & 0o111 != 0
            };
            #[cfg(not(unix))]
            let exec = false;
            let content = std::fs::read(&path).unwrap();
            out.insert(
                relative,
                format!("file exec={exec} {:?}", String::from_utf8_lossy(&content)),
            );
        }
    }
}

pub fn changes(list: &[PathChange]) -> Vec<(String, &'static str)> {
    let mut out: Vec<_> = list
        .iter()
        .map(|c| {
            (
                c.path.clone(),
                match c.kind {
                    PathChangeKind::Added => "added",
                    PathChangeKind::Modified => "modified",
                    PathChangeKind::Deleted => "deleted",
                },
            )
        })
        .collect();
    out.sort();
    out
}

pub async fn snapshot(c: &GitCheckpointer, root: &Path, name: &str) -> String {
    c.snapshot(root, &session(name)).await.unwrap()
}

/// The user's index bytes and the refs outside our namespace: things a
/// snapshot or a restore must leave exactly as they were.
pub fn user_state(root: &Path) -> (Vec<u8>, String, String) {
    let git_dir = git(root, &["rev-parse", "--absolute-git-dir"]);
    let index = std::fs::read(Path::new(git_dir.trim()).join("index")).unwrap_or_default();
    let refs = git(root, &["for-each-ref", "--format=%(refname) %(objectname)"])
        .lines()
        .filter(|line| !line.starts_with("refs/blame/"))
        .collect::<Vec<_>>()
        .join("\n");
    let head = git(root, &["rev-parse", "HEAD"]);
    (index, refs, head)
}
