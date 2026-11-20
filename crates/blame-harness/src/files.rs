//! The workspace's files: path safety, reads, and snapshots of the source
//! revision (git-based, with a directory walk when the folder is no
//! repository). Mirrors `workspace-files.ts` and `light-identity.ts`.

use crate::failure::{Failure, Outcome, Signal};
use crate::identity::{Sha256, sha256_hex};
use crate::pathx;
use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

pub const IGNORED_DIRECTORIES: [&str; 18] = [
    ".blame",
    ".code-review-graph",
    ".git",
    ".next",
    ".venv",
    "venv",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    "target",
    ".turbo",
    ".vercel",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "out",
];
const MAX_WORKSPACE_FILES: usize = 50_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChangeStatus {
    Added,
    Deleted,
    Modified,
}

impl ChangeStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            ChangeStatus::Added => "added",
            ChangeStatus::Deleted => "deleted",
            ChangeStatus::Modified => "modified",
        }
    }
}

#[derive(Clone, Debug)]
pub struct WorkspaceChange {
    pub path: String,
    pub status: ChangeStatus,
}

#[derive(Clone, Debug)]
pub struct SourceRevision {
    pub source_revision_id: String,
    pub base_commit: Option<String>,
    pub overlay_merkle_root: String,
}

#[derive(Clone, Debug)]
pub struct WorkspaceSnapshot {
    pub branch: Option<String>,
    pub changes: Vec<WorkspaceChange>,
    pub files: Vec<String>,
    pub file_states: Vec<(String, String)>,
    pub git: bool,
    pub revision: SourceRevision,
}

pub struct ReadFile {
    pub absolute: PathBuf,
    pub content: Vec<u8>,
    pub mode: u32,
    pub path: String,
}

pub struct PathProfile {
    pub directory: bool,
    pub size: u64,
}

pub struct WorkspaceFiles {
    /// `path.resolve(root)`: absolute, lexically normalised.
    pub root: String,
    /// Tools and stack traces may report the symlink-free spelling of the root
    /// (for example /private/var for /var on macOS).
    physical_root: String,
}

impl WorkspaceFiles {
    pub fn new(root: &str) -> WorkspaceFiles {
        let cwd = std::env::current_dir()
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_else(|_| "/".into());
        let root = pathx::resolve(&cwd, root);
        let physical_root = fs::canonicalize(&root)
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_else(|_| root.clone());
        WorkspaceFiles {
            root,
            physical_root,
        }
    }

    pub fn normalize_path(&self, path: &str) -> Outcome<String> {
        if crate::text::js_trim(path).is_empty() || path.contains('\0') {
            return Err(Failure::new("A non-empty workspace path is required."));
        }
        let portable = path.replace('\\', "/");
        let portable = portable.strip_prefix("./").unwrap_or(&portable);
        let absolute = pathx::resolve(&self.root, portable);
        let local = self.local_path(&absolute);
        if local.is_empty() || local == "." {
            return Ok(".".into());
        }
        if pathx::escapes(&local) {
            return Err(Failure::new("Path escapes the workspace root."));
        }
        Ok(local)
    }

    fn local_path(&self, absolute: &str) -> String {
        let local = pathx::relative(&self.root, absolute);
        if self.physical_root == self.root || !pathx::escapes(&local) {
            return local;
        }
        let physical = pathx::relative(&self.physical_root, absolute);
        if pathx::escapes(&physical) {
            local
        } else {
            physical
        }
    }

    pub fn absolute(&self, normalized: &str) -> String {
        pathx::resolve(&self.root, normalized)
    }

    fn resolve_existing_path(&self, path: &str) -> Outcome<(PathBuf, fs::Metadata)> {
        let normalized = self.normalize_path(path)?;
        let candidate = PathBuf::from(pathx::resolve(&self.root, &normalized));
        let link = fs::symlink_metadata(&candidate)
            .map_err(|error| Failure::io(&error, "lstat", &candidate))?;
        if link.file_type().is_symlink() {
            return Err(Failure::new(
                "Symbolic-link files are not supported by exact harness reads.",
            ));
        }
        let resolved = fs::canonicalize(&candidate)
            .map_err(|error| Failure::io(&error, "realpath", &candidate))?;
        let root = fs::canonicalize(&self.root)
            .map_err(|error| Failure::io(&error, "realpath", Path::new(&self.root)))?;
        let local = pathx::relative(&root.to_string_lossy(), &resolved.to_string_lossy());
        if pathx::escapes(&local) {
            return Err(Failure::new("Resolved path escapes the workspace root."));
        }
        let metadata =
            fs::metadata(&resolved).map_err(|error| Failure::io(&error, "stat", &resolved))?;
        Ok((resolved, metadata))
    }

    fn resolve_existing(&self, path: &str) -> Outcome<(PathBuf, fs::Metadata)> {
        let (resolved, metadata) = self.resolve_existing_path(path)?;
        if !metadata.is_file() {
            return Err(Failure::new("Target is not a regular file."));
        }
        Ok((resolved, metadata))
    }

    pub fn read(&self, path: &str) -> Outcome<ReadFile> {
        let (absolute, metadata) = self.resolve_existing(path)?;
        let content =
            fs::read(&absolute).map_err(|error| Failure::io(&error, "open", &absolute))?;
        Ok(ReadFile {
            absolute,
            content,
            mode: metadata.permissions().mode() & 0o777,
            path: self.normalize_path(path)?,
        })
    }

    pub fn file_size(&self, path: &str) -> Outcome<u64> {
        Ok(self.resolve_existing(path)?.1.size())
    }

    pub fn path_profile(&self, path: &str) -> Outcome<PathProfile> {
        let (_, metadata) = self.resolve_existing_path(path)?;
        Ok(PathProfile {
            directory: metadata.is_dir(),
            size: metadata.size(),
        })
    }

    pub fn blob_hash(&self, path: &str) -> Outcome<String> {
        Ok(sha256_hex(&self.read(path)?.content))
    }

    pub fn snapshot(&self, signal: &Signal) -> Outcome<WorkspaceSnapshot> {
        signal.check()?;
        let git = self
            .git_optional(&["rev-parse", "--show-toplevel"])
            .is_some();
        let base_commit = if git {
            self.git_optional(&["rev-parse", "HEAD"])
        } else {
            None
        };
        let files = if git {
            self.git_files()?
        } else {
            self.walk_files(signal)?
        };
        let changed = if git {
            self.git_changed_paths(base_commit.is_some())?
        } else {
            files.clone()
        };
        let (entries, file_states, mut changes) =
            self.changed_state(changed, base_commit.as_deref(), signal)?;
        if git {
            let untracked: HashSet<String> =
                nul_list(&self.git(&["ls-files", "--others", "--exclude-standard", "-z"])?)
                    .into_iter()
                    .filter(|path| is_harness_source_path(path))
                    .collect();
            for change in &mut changes {
                if untracked.contains(&change.path) {
                    change.status = ChangeStatus::Added;
                }
            }
        }
        let branch = if git {
            self.git_optional(&["branch", "--show-current"])
        } else {
            None
        };
        let revision = source_revision(base_commit, &entries);
        Ok(WorkspaceSnapshot {
            branch,
            changes,
            files,
            file_states,
            git,
            revision,
        })
    }

    #[allow(clippy::type_complexity)]
    fn changed_state(
        &self,
        mut paths: Vec<String>,
        base_commit: Option<&str>,
        signal: &Signal,
    ) -> Outcome<(Vec<String>, Vec<(String, String)>, Vec<WorkspaceChange>)> {
        paths.sort_by(|left, right| crate::text::utf16_compare(left, right));
        let mut entries = Vec::new();
        let mut states = Vec::new();
        let mut changes = Vec::new();
        for path in paths {
            signal.check()?;
            let (digest, kind, content_hash) = self.path_state(&path)?;
            entries.push(format!("{path}\0{digest}\0{kind}"));
            let hash = match kind {
                "file" => content_hash,
                "gone" => "absent".to_string(),
                _ => digest.clone(),
            };
            states.push((path.clone(), hash));
            let status = if kind == "gone" {
                ChangeStatus::Deleted
            } else if base_commit.is_some() {
                ChangeStatus::Modified
            } else {
                ChangeStatus::Added
            };
            changes.push(WorkspaceChange { path, status });
        }
        Ok((entries, states, changes))
    }

    /// (state digest, kind, content hash) of one path.
    fn path_state(&self, path: &str) -> Outcome<(String, &'static str, String)> {
        let absolute = PathBuf::from(pathx::resolve(&self.root, path));
        let info = match fs::symlink_metadata(&absolute) {
            Ok(info) => info,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok((sha256_hex(b"gone"), "gone", String::new()));
            }
            Err(error) => return Err(Failure::io(&error, "lstat", &absolute)),
        };
        if info.file_type().is_symlink() {
            let target = fs::read_link(&absolute)
                .map_err(|error| Failure::io(&error, "readlink", &absolute))?;
            return Ok((
                sha256_hex(target.to_string_lossy().as_bytes()),
                "symlink",
                String::new(),
            ));
        }
        if !info.is_file() {
            return Ok((sha256_hex(b"non-file"), "other", String::new()));
        }
        let mut file = match fs::File::open(&absolute) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok((sha256_hex(b"gone"), "gone", String::new()));
            }
            Err(error) => return Err(Failure::io(&error, "open", &absolute)),
        };
        let mut content = Sha256::new();
        let mut state = Sha256::new();
        state.update(format!("{}\0", info.permissions().mode() & 0o777).as_bytes());
        let mut buffer = vec![0u8; 64 * 1024];
        loop {
            let read = file
                .read(&mut buffer)
                .map_err(|error| Failure::io(&error, "read", &absolute))?;
            if read == 0 {
                break;
            }
            content.update(&buffer[..read]);
            state.update(&buffer[..read]);
        }
        Ok((state.hex(), "file", content.hex()))
    }

    fn git_files(&self) -> Outcome<Vec<String>> {
        let output = self.git(&[
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
        ])?;
        let mut seen = HashSet::new();
        let mut files: Vec<String> = nul_list(&output)
            .into_iter()
            .filter(|path| is_harness_source_path(path) && seen.insert(path.clone()))
            .collect();
        files.truncate(MAX_WORKSPACE_FILES);
        Ok(files)
    }

    fn git_changed_paths(&self, has_head: bool) -> Outcome<Vec<String>> {
        let tracked = if has_head {
            nul_list(&self.git(&["diff", "--no-renames", "--name-only", "-z", "HEAD", "--"])?)
        } else {
            nul_list(&self.git(&["ls-files", "--cached", "-z"])?)
        };
        let untracked =
            nul_list(&self.git(&["ls-files", "--others", "--exclude-standard", "-z"])?);
        let mut seen = HashSet::new();
        Ok(tracked
            .into_iter()
            .chain(untracked)
            .filter(|path| is_harness_source_path(path) && seen.insert(path.clone()))
            .collect())
    }

    fn walk_files(&self, signal: &Signal) -> Outcome<Vec<String>> {
        let mut files = Vec::new();
        self.visit(Path::new(&self.root), &mut files, signal)?;
        files.sort_by(|left: &String, right: &String| crate::text::utf16_compare(left, right));
        Ok(files)
    }

    fn visit(&self, directory: &Path, files: &mut Vec<String>, signal: &Signal) -> Outcome<()> {
        signal.check()?;
        if files.len() >= MAX_WORKSPACE_FILES {
            return Ok(());
        }
        let entries =
            fs::read_dir(directory).map_err(|error| Failure::io(&error, "scandir", directory))?;
        // readdir order is the file system's; the result is sorted afterwards,
        // but the 50,000 bound cuts in directory order, as in Node.
        let mut entries: Vec<fs::DirEntry> = entries.filter_map(Result::ok).collect();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let name = entry.file_name().to_string_lossy().into_owned();
            if IGNORED_DIRECTORIES.contains(&name.as_str()) {
                continue;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let absolute = entry.path();
            if kind.is_dir() {
                self.visit(&absolute, files, signal)?;
            } else if kind.is_file() {
                files.push(pathx::relative(&self.root, &absolute.to_string_lossy()));
            }
        }
        Ok(())
    }

    pub fn git(&self, args: &[&str]) -> Outcome<String> {
        let output = Command::new("git")
            .args(args)
            .current_dir(&self.root)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .map_err(|error| Failure::new(format!("git {}: {error}", args.join(" "))))?;
        if !output.status.success() {
            return Err(Failure::new(format!(
                "Command failed: git {}",
                args.join(" ")
            )));
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }

    pub fn git_optional(&self, args: &[&str]) -> Option<String> {
        let output = self.git(args).ok()?;
        let trimmed = crate::text::js_trim(&output);
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    }
}

fn source_revision(base_commit: Option<String>, entries: &[String]) -> SourceRevision {
    let overlay_merkle_root = sha256_hex(entries.join("\n").as_bytes());
    let id = sha256_hex(
        format!(
            "{}\0{}",
            base_commit.as_deref().unwrap_or("no-git"),
            overlay_merkle_root
        )
        .as_bytes(),
    );
    SourceRevision {
        source_revision_id: format!("src_{}", &id[..32]),
        base_commit,
        overlay_merkle_root,
    }
}

fn nul_list(output: &str) -> Vec<String> {
    output
        .split('\0')
        .filter(|part| !part.is_empty())
        .map(str::to_string)
        .collect()
}

pub fn is_harness_source_path(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    let segments: Vec<&str> = normalized.split('/').collect();
    let basename = segments
        .last()
        .map(|value| value.to_lowercase())
        .unwrap_or_default();
    !path.is_empty()
        && !segments
            .iter()
            .any(|segment| IGNORED_DIRECTORIES.contains(segment))
        && !segments.contains(&".ssh")
        && !(basename.starts_with(".env") && basename != ".env.example")
        && ![".npmrc", "id_rsa", "id_ed25519", "known_hosts"].contains(&basename.as_str())
}

pub fn assert_mutable_workspace_path(path: &str) -> Outcome<()> {
    let normalized = path.replace('\\', "/").to_lowercase();
    let segments: Vec<&str> = normalized.split('/').collect();
    let basename = segments.last().copied().unwrap_or("");
    if segments.contains(&"node_modules") {
        return Err(Failure::new(
            "Dependency internals are runtime-managed and excluded from code navigation and edits.",
        ));
    }
    if segments.contains(&".blame")
        || segments.contains(&".code-review-graph")
        || segments.contains(&".git")
        || segments.contains(&".ssh")
        || (basename.starts_with(".env") && basename != ".env.example")
        || [".npmrc", "id_rsa", "id_ed25519", "known_hosts"].contains(&basename)
    {
        return Err(Failure::new(
            "Harness policy protects metadata and secret paths.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_and_refuses_escapes() {
        let files = WorkspaceFiles::new("/tmp/workspace");
        assert_eq!(files.normalize_path("./src\\a.ts").unwrap(), "src/a.ts");
        assert_eq!(files.normalize_path(".").unwrap(), ".");
        assert_eq!(
            files.normalize_path("../x").unwrap_err().message,
            "Path escapes the workspace root."
        );
        assert!(files.normalize_path(" ").is_err());
    }

    #[test]
    fn protects_metadata_and_secrets() {
        assert!(assert_mutable_workspace_path("a/.env.local").is_err());
        assert!(assert_mutable_workspace_path(".env.example").is_ok());
        assert!(assert_mutable_workspace_path("node_modules/x/index.js").is_err());
        assert!(!is_harness_source_path("dist/a.js"));
        assert!(is_harness_source_path("src/a.js"));
    }
}
