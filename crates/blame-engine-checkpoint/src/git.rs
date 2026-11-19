//! Running the `git` command line, and nothing else.
//!
//! Every call is plumbing with `-z` output, and every call is configured so
//! that it can neither run the user's code nor disturb the user's own git
//! commands: no hooks, no fsmonitor, no optional locks, no automatic gc.

use blame_engine_core::ports::CheckpointError;
use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Variables that would point git somewhere else than the workspace, for
/// instance when the engine was itself started by a git hook.
const INHERITED_VARIABLES: &[&str] = &[
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_NAMESPACE",
    "GIT_PREFIX",
    "GIT_CEILING_DIRECTORIES",
];

/// Everything needed to run git against one workspace.
#[derive(Clone, Debug)]
pub(crate) struct Git {
    program: OsString,
    work_tree: PathBuf,
    /// Set when the repository is ours (workspace that is not a git
    /// repository); otherwise git discovers it from the work tree.
    git_dir: Option<PathBuf>,
    /// An empty directory, so `core.hooksPath` finds no hook to run.
    hooks_dir: PathBuf,
}

impl Git {
    pub(crate) fn new(
        program: OsString,
        work_tree: PathBuf,
        git_dir: Option<PathBuf>,
        hooks_dir: PathBuf,
    ) -> Self {
        Self {
            program,
            work_tree,
            git_dir,
            hooks_dir,
        }
    }

    pub(crate) fn work_tree(&self) -> &Path {
        &self.work_tree
    }

    /// Runs `git <args>` with `index` as the index, feeding `stdin`.
    pub(crate) fn run(
        &self,
        args: &[&str],
        index: Option<&Path>,
        stdin: Option<&[u8]>,
    ) -> Result<Vec<u8>, CheckpointError> {
        self.run_checked(args, index, stdin, &[0])
            .map(|(_, output)| output)
    }

    /// Like `run`, but a non-zero exit among `accepted` is not an error; the
    /// code is returned with the output.
    pub(crate) fn run_checked(
        &self,
        args: &[&str],
        index: Option<&Path>,
        stdin: Option<&[u8]>,
        accepted: &[i32],
    ) -> Result<(i32, Vec<u8>), CheckpointError> {
        let mut command = base_command(&self.program, &self.work_tree);
        command
            .arg("-c")
            .arg(format!("core.hooksPath={}", config_path(&self.hooks_dir)));
        for setting in SAFE_SETTINGS {
            command.arg("-c").arg(setting);
        }
        if let Some(git_dir) = &self.git_dir {
            command.arg("--git-dir").arg(git_dir);
            command.arg("--work-tree").arg(&self.work_tree);
            command.arg("-c").arg("core.bare=false");
        }
        command.args(args);
        if let Some(index) = index {
            command.env("GIT_INDEX_FILE", index);
        }
        execute(command, args, stdin, accepted)
    }
}

/// Settings every call carries.
const SAFE_SETTINGS: &[&str] = &[
    // The user's fsmonitor hook is a command we must not run.
    "core.fsmonitor=false",
    // Sparse checkout would otherwise mark files outside the cone as absent
    // when a tree is checked out into our private index.
    "core.sparseCheckout=false",
    "index.sparse=false",
    // A conversion that is not reversible must not make a snapshot fail.
    "core.safecrlf=false",
    "gc.auto=0",
    "maintenance.auto=false",
    // Snapshots are written at the start of every turn: speed over size.
    "core.looseCompression=1",
];

fn base_command(program: &OsString, cwd: &Path) -> Command {
    let mut command = Command::new(program);
    command.current_dir(cwd);
    for name in INHERITED_VARIABLES {
        command.env_remove(name);
    }
    // Never take the optional locks (such as refreshing the user's index)
    // that would make the user's own concurrent git commands fail.
    command.env("GIT_OPTIONAL_LOCKS", "0");
    command.env("GIT_TERMINAL_PROMPT", "0");
    command.env("GIT_EDITOR", "true");
    command.stdin(Stdio::piped());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // No console window flashing for every git call.
        command.creation_flags(0x0800_0000);
    }
    command
}

/// A git call outside any repository, to find out whether there is one.
pub(crate) fn run_plain(
    program: &OsString,
    cwd: &Path,
    args: &[&str],
) -> Result<(i32, Vec<u8>), CheckpointError> {
    let mut command = base_command(program, cwd);
    command.args(args);
    execute(command, args, None, &[0, 128, 129])
}

fn execute(
    mut command: Command,
    args: &[&str],
    stdin: Option<&[u8]>,
    accepted: &[i32],
) -> Result<(i32, Vec<u8>), CheckpointError> {
    let label = args.first().copied().unwrap_or("git");
    let mut child = command
        .spawn()
        .map_err(|error| CheckpointError::Failed(format!("could not run git: {error}")))?;
    let mut input = child.stdin.take();
    // Written from a thread: git may fill its output pipes before it has read
    // all of a large path list.
    let output = std::thread::scope(|scope| {
        if let Some(mut pipe) = input.take() {
            let data = stdin.unwrap_or_default();
            scope.spawn(move || {
                // A git that exits early closes the pipe; its exit status
                // tells the story.
                let _ = pipe.write_all(data);
            });
        }
        child.wait_with_output()
    })
    .map_err(|error| CheckpointError::Failed(format!("git {label}: {error}")))?;
    let code = output.status.code().unwrap_or(-1);
    if !accepted.contains(&code) {
        let message = String::from_utf8_lossy(&output.stderr);
        return Err(CheckpointError::Failed(format!(
            "git {label} exited with {code}: {}",
            message.trim()
        )));
    }
    Ok((code, output.stdout))
}

/// A path as git reads it in `-c key=value`: forward slashes, which Windows
/// accepts and which avoids backslash escapes.
pub(crate) fn config_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    if cfg!(windows) {
        text.replace('\\', "/")
    } else {
        text.into_owned()
    }
}

/// Splits `-z` output into records.
pub(crate) fn nul_records(buffer: &[u8]) -> impl Iterator<Item = &[u8]> {
    buffer
        .split(|byte| *byte == 0)
        .filter(|part| !part.is_empty())
}

/// A path as git reports it (UTF-8 or raw bytes on Unix) to a filesystem path.
pub(crate) fn path_from_git(root: &Path, relative: &[u8]) -> PathBuf {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        root.join(std::ffi::OsStr::from_bytes(relative))
    }
    #[cfg(not(unix))]
    {
        root.join(String::from_utf8_lossy(relative).as_ref())
    }
}
