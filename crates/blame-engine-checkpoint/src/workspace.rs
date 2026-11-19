//! Finding the repository a workspace snapshots into, and the files that keep
//! the snapshots cheap.

use crate::git::{Git, config_path, nul_records, path_from_git, run_plain};
use blame_engine_core::ports::CheckpointError;
use std::collections::BTreeSet;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// Directory, inside the git directory, where this crate keeps its files.
const META_DIR: &str = "blame-checkpoints";

/// A workspace and the git repository its snapshots live in.
pub(crate) struct Workspace {
    pub(crate) git: Git,
    /// Holds this crate's index files, the exclude patterns and the empty
    /// hooks directory. Inside the git directory, so `git worktree remove`
    /// and `git worktree prune` clean it up with the worktree.
    pub(crate) meta: PathBuf,
    /// The user's own index, whose stat data seeds ours; never written.
    user_index: Option<PathBuf>,
    /// The repository this crate created for a workspace that is not one.
    pub(crate) private_repo: Option<PathBuf>,
    exclude_file: Option<PathBuf>,
}

pub(crate) struct Options {
    pub(crate) git_program: OsString,
    pub(crate) private_root: PathBuf,
    pub(crate) exclude: Vec<String>,
}

impl Workspace {
    /// `create` allows making the private repository of a workspace that is
    /// not a git repository; without it, such a workspace that was never
    /// snapshotted gives `None`.
    pub(crate) fn open(
        options: &Options,
        root: &Path,
        create: bool,
    ) -> Result<Option<Self>, CheckpointError> {
        if !root.is_dir() {
            return Err(CheckpointError::Unsupported(root.display().to_string()));
        }
        let (git_dir, private_repo) = match discover_repository(&options.git_program, root)? {
            Some(dir) => (dir, None),
            None => {
                let dir = private_repository(options, root, create)?;
                match dir {
                    Some(dir) => (dir.clone(), Some(dir)),
                    None => return Ok(None),
                }
            }
        };
        let meta = git_dir.join(META_DIR);
        let hooks = meta.join("hooks");
        std::fs::create_dir_all(&hooks).map_err(|error| io_error(&hooks, error))?;
        let exclude_file = write_excludes(&meta, &options.exclude)?;
        let git = Git::new(
            options.git_program.clone(),
            root.to_path_buf(),
            private_repo.clone(),
            hooks,
        );
        let user_index = private_repo.is_none().then(|| git_dir.join("index"));
        Ok(Some(Self {
            git,
            meta,
            user_index,
            private_repo,
            exclude_file,
        }))
    }

    /// Every file a snapshot holds: regular files and symlinks that are
    /// tracked, or untracked and not ignored, minus what the owner excluded.
    ///
    /// Submodules and nested repositories are left out on purpose: their
    /// content belongs to another repository, which a snapshot could neither
    /// restore faithfully nor leave alone if it tried.
    pub(crate) fn list_files(&self) -> Result<Vec<Vec<u8>>, CheckpointError> {
        let mut paths: BTreeSet<Vec<u8>> = BTreeSet::new();
        let tracked = self.git.run(&["ls-files", "-z", "--stage"], None, None)?;
        for record in nul_records(&tracked) {
            // `<mode> <object> <stage>\t<path>`; a conflicted path has three.
            let Some(tab) = record.iter().position(|byte| *byte == b'\t') else {
                continue;
            };
            if record.starts_with(b"160000 ") {
                continue;
            }
            paths.insert(record[tab + 1..].to_vec());
        }
        let exclude_argument = self
            .exclude_file
            .as_ref()
            .map(|file| format!("--exclude-from={}", config_path(file)));
        if let Some(argument) = &exclude_argument {
            // Tracked files the owner excluded are neither saved nor restored.
            let excluded = self.git.run(
                &["ls-files", "-z", "--cached", "--ignored", argument],
                None,
                None,
            )?;
            for record in nul_records(&excluded) {
                paths.remove(record);
            }
        }
        let mut arguments = vec!["ls-files", "-z", "--others", "--exclude-standard"];
        if let Some(argument) = &exclude_argument {
            arguments.push(argument);
        }
        let untracked = self.git.run(&arguments, None, None)?;
        for record in nul_records(&untracked) {
            // A nested repository is listed as a directory.
            if !record.ends_with(b"/") {
                paths.insert(record.to_vec());
            }
        }
        // What git lists may be gone, or may have become a directory (a
        // tracked file replaced by one): only files and symlinks are saved.
        let root = self.git.work_tree();
        paths.retain(|path| {
            std::fs::symlink_metadata(path_from_git(root, path))
                .map(|meta| meta.is_file() || meta.file_type().is_symlink())
                .unwrap_or(false)
        });
        Ok(paths.into_iter().collect())
    }

    /// Makes `index` describe the workspace as it is now. Only files whose
    /// stat data changed are read, so after the first call this costs what
    /// `git status` costs.
    ///
    /// With `info_only` no object is written: for looking at the workspace or
    /// for restoring it, where the state being described is thrown away.
    pub(crate) fn sync_index(&self, index: &Path, info_only: bool) -> Result<(), CheckpointError> {
        if !index.exists() {
            self.seed(index);
        }
        let files = self.list_files()?;
        let wanted: BTreeSet<&[u8]> = files.iter().map(Vec::as_slice).collect();
        let known = self.git.run(&["ls-files", "-z"], Some(index), None)?;
        // Dropped before anything is added: a path that turned from a file
        // into a directory (or back) must not exist twice in the index.
        let stale: Vec<u8> = nul_records(&known)
            .filter(|path| !wanted.contains(path))
            .flat_map(|path| path.iter().copied().chain([0]))
            .collect();
        if !stale.is_empty() {
            self.git.run(
                &["update-index", "--force-remove", "-z", "--stdin"],
                Some(index),
                Some(&stale),
            )?;
        }
        let mut arguments = vec!["update-index", "--add"];
        if info_only {
            arguments.push("--info-only");
        }
        // `--stdin` must come last.
        arguments.extend(["-z", "--stdin"]);
        let input: Vec<u8> = files
            .iter()
            .flat_map(|path| path.iter().copied().chain([0]))
            .collect();
        if !input.is_empty() {
            self.git.run(&arguments, Some(index), Some(&input))?;
        }
        Ok(())
    }

    /// Starts an index from a copy of the user's, so the first snapshot of a
    /// large checkout does not read every file: git trusts stat data it wrote
    /// itself. Whatever staged, conflicted or sparse state the copy carries is
    /// overwritten by `sync_index`; failing to copy only costs time.
    fn seed(&self, index: &Path) {
        if let Some(user_index) = &self.user_index {
            let _ = std::fs::copy(user_index, index);
        }
    }
}

/// The git directory of the repository whose work tree root is `root`, if it
/// is one. A workspace that is a subdirectory of a repository is not: git
/// would resolve paths against the repository's top, so it gets a private
/// repository like any other folder.
fn discover_repository(
    program: &OsString,
    root: &Path,
) -> Result<Option<PathBuf>, CheckpointError> {
    let (code, output) = run_plain(
        program,
        root,
        &[
            "rev-parse",
            "--absolute-git-dir",
            "--is-inside-work-tree",
            "--show-prefix",
        ],
    )?;
    if code != 0 {
        return Ok(None);
    }
    let text = String::from_utf8_lossy(&output);
    let mut lines = text.split('\n');
    let git_dir = lines.next().unwrap_or_default();
    let inside = lines.next() == Some("true");
    let prefix = lines.next().unwrap_or_default();
    if inside && prefix.is_empty() && !git_dir.is_empty() {
        Ok(Some(PathBuf::from(git_dir)))
    } else {
        Ok(None)
    }
}

fn private_repository(
    options: &Options,
    root: &Path,
    create: bool,
) -> Result<Option<PathBuf>, CheckpointError> {
    let dir = options.private_root.join(private_name(root));
    if dir.join("HEAD").is_file() {
        return Ok(Some(dir));
    }
    if !create {
        return Ok(None);
    }
    std::fs::create_dir_all(&options.private_root)
        .map_err(|error| io_error(&options.private_root, error))?;
    let target = dir.to_string_lossy().into_owned();
    run_plain(
        &options.git_program,
        &options.private_root,
        &["init", "--quiet", "--bare", &target],
    )
    .and_then(|(code, _)| {
        if code == 0 {
            Ok(())
        } else {
            Err(CheckpointError::Failed(format!(
                "could not create {}",
                dir.display()
            )))
        }
    })?;
    Ok(Some(dir))
}

/// A directory name that is readable and unique per workspace path.
fn private_name(root: &Path) -> String {
    let canonical = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let text = canonical.to_string_lossy();
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    let label: String = canonical
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .take(32)
        .collect();
    format!("{label}-{hash:016x}.git")
}

fn write_excludes(meta: &Path, patterns: &[String]) -> Result<Option<PathBuf>, CheckpointError> {
    if patterns.is_empty() {
        return Ok(None);
    }
    let file = meta.join("exclude");
    let mut content = patterns.join("\n");
    content.push('\n');
    if std::fs::read_to_string(&file).ok().as_deref() != Some(content.as_str()) {
        std::fs::write(&file, content).map_err(|error| io_error(&file, error))?;
    }
    Ok(Some(file))
}

pub(crate) fn io_error(path: &Path, error: std::io::Error) -> CheckpointError {
    CheckpointError::Failed(format!("{}: {error}", path.display()))
}
