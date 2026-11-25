//! A workspace command's process (`workspace-command-process.ts`): its own
//! process group, stdout and stderr decoded as UTF-8 into one bounded
//! buffer, inspection by byte cursor while it runs, and termination of the
//! whole group on cancellation, timeout or the output limit.

use crate::failure::{Failure, Outcome, Signal};
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

pub const DEFAULT_TIMEOUT_MS: u64 = 120_000;
pub const DEFAULT_OUTPUT_LIMIT: usize = 512 * 1024;
/// Output still arriving after the exit (Node's 'close' after 'exit').
const DRAIN: Duration = Duration::from_millis(100);
/// How often a waiting command looks at its cancellation signal.
const POLL: Duration = Duration::from_millis(20);

pub struct CommandOptions {
    pub cwd: String,
    /// The complete environment of the process.
    pub environment: Vec<(String, String)>,
    pub signal: Signal,
    pub timeout_ms: u64,
    pub maximum_output_bytes: usize,
}

#[derive(Clone, Debug)]
pub struct CommandOutcome {
    pub all: String,
    pub exit_code: Option<i32>,
    pub failed: bool,
    pub interruption: Option<&'static str>,
}

#[derive(Clone, Debug)]
pub struct Snapshot {
    pub cursor: String,
    pub output: String,
    pub process: &'static str,
    /// With a page limit: where the page starts, and the whole output's size.
    pub start: Option<usize>,
    pub total_bytes: Option<usize>,
}

#[derive(Default)]
struct State {
    bytes: Vec<u8>,
    finished: bool,
    exited: bool,
    open_streams: usize,
    exit_code: Option<i32>,
    interruption: Option<&'static str>,
    error: Option<String>,
    drain_at: Option<Instant>,
    outcome: Option<CommandOutcome>,
}

struct Shared {
    state: Mutex<State>,
    changed: Condvar,
    pid: Option<u32>,
    timeout_ms: u64,
    limit: usize,
}

/// A running (or finished) command.
#[derive(Clone)]
pub struct CommandHandle(Arc<Shared>);

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn append(&self, chunk: &[u8]) {
        let mut state = self.lock();
        if state.finished || state.interruption.is_some() {
            return;
        }
        let remaining = self.limit - state.bytes.len();
        let retained = &chunk[..chunk.len().min(remaining)];
        state.bytes.extend_from_slice(retained);
        if chunk.len() > remaining {
            drop(state);
            self.interrupt("output_limit");
            return;
        }
        drop(state);
        self.changed.notify_all();
    }

    fn interrupt(&self, reason: &'static str) {
        let mut state = self.lock();
        if state.finished || state.interruption.is_some() {
            return;
        }
        state.interruption = Some(reason);
        state.drain_at.get_or_insert(Instant::now() + DRAIN);
        drop(state);
        self.terminate();
        self.changed.notify_all();
    }

    /// SIGKILL to the process group, as `process.kill(-pid)`; without unsafe
    /// code the signal goes through kill(1). On Windows, the process tree
    /// through `taskkill /T /F`, as the TypeScript harness does.
    fn terminate(&self) {
        let Some(pid) = self.pid else { return };
        if cfg!(windows) {
            let _ = hidden(
                Command::new("taskkill")
                    .args(["/pid", &pid.to_string(), "/T", "/F"])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null()),
            )
            .status();
            return;
        }
        let group = Command::new("kill")
            .args(["-9", "--", &format!("-{pid}")])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        if !group.is_ok_and(|status| status.success()) {
            let _ = Command::new("kill")
                .args(["-9", &pid.to_string()])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }

    fn finish(&self, state: &mut State) {
        if state.finished {
            return;
        }
        state.finished = true;
        let diagnostic = match state.interruption {
            Some("cancelled") => Some("Command cancelled before completion.".to_string()),
            Some("timed_out") => Some(format!("Command timed out after {} ms.", self.timeout_ms)),
            Some(_) => Some("Command stopped: its output passed the captured output limit. Write the output to a file, then search or read that file.".to_string()),
            None => state.error.clone(),
        };
        let output = String::from_utf8_lossy(&state.bytes).into_owned();
        let all = [Some(output), diagnostic]
            .into_iter()
            .flatten()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        state.outcome = Some(CommandOutcome {
            all,
            exit_code: state.exit_code,
            failed: state.exit_code != Some(0)
                || state.interruption.is_some()
                || state.error.is_some(),
            interruption: state.interruption,
        });
    }
}

/// Starts `executable args` in `cwd`; a spawn failure becomes a finished
/// command whose output is Node's error message.
pub fn start(executable: &str, args: &[String], options: CommandOptions) -> Outcome<CommandHandle> {
    options.signal.check()?;
    let mut command = platform_command(executable, args, &options.environment);
    #[allow(unused_mut)]
    let mut spawned = configured(&mut command, &options).spawn();
    #[cfg(unix)]
    if spawned
        .as_ref()
        .err()
        .and_then(std::io::Error::raw_os_error)
        == Some(ENOEXEC)
    {
        let path = options
            .environment
            .iter()
            .find(|(name, _)| name == "PATH")
            .map(|(_, value)| value.as_str());
        if let Some(mut retry) = sh_command(executable, args, path, &options.cwd) {
            spawned = configured(&mut retry, &options).spawn();
        }
    }
    let pid = spawned.as_ref().ok().map(|child| child.id());
    let shared = Arc::new(Shared {
        state: Mutex::new(State::default()),
        changed: Condvar::new(),
        pid,
        timeout_ms: options.timeout_ms,
        limit: options.maximum_output_bytes,
    });
    let mut child = match spawned {
        Ok(child) => child,
        Err(error) => {
            let mut state = shared.lock();
            state.error = Some(format!("spawn {executable} {}", error_code(&error)));
            shared.finish(&mut state);
            drop(state);
            return Ok(CommandHandle(shared));
        }
    };
    let streams: Vec<Box<dyn Read + Send>> = [
        child
            .stdout
            .take()
            .map(|stream| Box::new(stream) as Box<dyn Read + Send>),
        child
            .stderr
            .take()
            .map(|stream| Box::new(stream) as Box<dyn Read + Send>),
    ]
    .into_iter()
    .flatten()
    .collect();
    shared.lock().open_streams = streams.len();
    for mut stream in streams {
        let shared = shared.clone();
        thread::spawn(move || {
            let mut decoder = Utf8Decoder::default();
            let mut buffer = [0u8; 16 * 1024];
            loop {
                match stream.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => shared.append(decoder.write(&buffer[..read]).as_bytes()),
                }
            }
            shared.append(decoder.end().as_bytes());
            let mut state = shared.lock();
            state.open_streams -= 1;
            drop(state);
            shared.changed.notify_all();
        });
    }
    {
        let shared = shared.clone();
        thread::spawn(move || {
            let status = child.wait();
            let mut state = shared.lock();
            state.exited = true;
            if let Ok(status) = status {
                state.exit_code = status.code();
                #[cfg(unix)]
                if let Some(signal) = std::os::unix::process::ExitStatusExt::signal(&status) {
                    state.error.get_or_insert_with(|| {
                        format!("Command terminated by {}.", signal_name(signal))
                    });
                }
            }
            state.drain_at.get_or_insert(Instant::now() + DRAIN);
            drop(state);
            shared.changed.notify_all();
        });
    }
    {
        let shared = shared.clone();
        let signal = options.signal.clone();
        let deadline = Instant::now() + Duration::from_millis(options.timeout_ms);
        thread::spawn(move || {
            loop {
                let mut state = shared.lock();
                if state.finished {
                    break;
                }
                let now = Instant::now();
                if state.exited && state.open_streams == 0
                    || state.drain_at.is_some_and(|at| now >= at)
                {
                    shared.finish(&mut state);
                    drop(state);
                    shared.changed.notify_all();
                    break;
                }
                let interrupted = state.interruption.is_some();
                drop(state);
                if !interrupted && signal.aborted() {
                    shared.interrupt("cancelled");
                    continue;
                }
                if !interrupted && now >= deadline {
                    shared.interrupt("timed_out");
                    continue;
                }
                let state = shared.lock();
                let _ = shared.changed.wait_timeout(state, POLL);
            }
        });
    }
    Ok(CommandHandle(shared))
}

fn configured<'a>(command: &'a mut Command, options: &CommandOptions) -> &'a mut Command {
    command
        .current_dir(&options.cwd)
        .env_clear()
        .envs(
            options
                .environment
                .iter()
                .map(|(name, value)| (name, value)),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Its own process group, so termination reaches the command's children.
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(command, 0);
    hidden(command)
}

#[cfg(unix)]
pub(crate) const ENOEXEC: i32 = 8;

/// What glibc's `execvp` and a shell do with a file the kernel refuses to
/// run (ENOEXEC): run it as an `sh` script. Rust's spawn does not, so pnpm
/// 12's shebang-less `bin/pnpm`, left in place when its native binary was
/// not installed, failed every project task in the runtime VM (US-103).
/// `executable` is looked up in `path` as the spawn would; `None` when it
/// is not found there.
#[cfg(unix)]
pub(crate) fn sh_command(
    executable: &str,
    args: &[String],
    path: Option<&str>,
    cwd: &str,
) -> Option<Command> {
    let file = if executable.contains('/') {
        std::path::PathBuf::from(executable)
    } else {
        path?
            .split(':')
            .filter(|entry| !entry.is_empty())
            .map(|entry| std::path::Path::new(cwd).join(entry).join(executable))
            .find(|candidate| candidate.is_file())?
    };
    let mut command = Command::new("/bin/sh");
    command.arg(file).args(args);
    Some(command)
}

/// Node's error code for a failed spawn.
fn error_code(error: &std::io::Error) -> String {
    match error.raw_os_error() {
        Some(2) => "ENOENT".into(),
        Some(13) => "EACCES".into(),
        Some(20) => "ENOTDIR".into(),
        Some(8) => "ENOEXEC".into(),
        Some(code) => format!("E{code}"),
        None => error.to_string(),
    }
}

/// No console window for a command (Node's `windowsHide`).
fn hidden(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// The command as the TypeScript harness spawns it: the executable with its
/// arguments.
#[cfg(not(windows))]
pub(crate) fn platform_command(
    executable: &str,
    args: &[String],
    _environment: &[(String, String)],
) -> Command {
    let mut command = Command::new(executable);
    command.args(args);
    command
}

/// The command as the TypeScript harness spawns it. cmd.exe takes its
/// command line verbatim (`windowsVerbatimArguments`), and any other
/// executable is resolved through PATH and PATHEXT as execa's cross-spawn
/// does.
#[cfg(windows)]
pub(crate) fn platform_command(
    executable: &str,
    args: &[String],
    environment: &[(String, String)],
) -> Command {
    use std::os::windows::process::CommandExt;
    let lowered = executable.to_lowercase();
    let name = lowered.rsplit(['\\', '/']).next().unwrap_or("");
    if name == "cmd" || name == "cmd.exe" {
        let mut command = Command::new(executable);
        for arg in args {
            command.raw_arg(arg);
        }
        return command;
    }
    // cross-spawn's rule: only a `.exe` or `.com` file starts directly.
    // Anything else goes through cmd.exe: a `.cmd` or `.bat` shim, and also a
    // name PATH does not hold, so the command fails as it does in a shell
    // (exit code 1, "is not recognized as an internal or external command").
    let resolved = windows_resolution(executable, environment);
    let file = resolved.as_deref().unwrap_or(executable);
    let direct = std::path::Path::new(file)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("exe") || extension.eq_ignore_ascii_case("com")
        });
    if direct {
        let mut command = Command::new(file);
        command.args(args);
        return command;
    }
    let line = std::iter::once(file)
        .chain(args.iter().map(String::as_str))
        .map(windows_quote)
        .collect::<Vec<_>>()
        .join(" ");
    let mut command = Command::new("cmd.exe");
    command
        .raw_arg("/d")
        .raw_arg("/s")
        .raw_arg("/c")
        .raw_arg(format!("\"{line}\""));
    command
}

/// The file PATH and PATHEXT name for a bare Windows executable.
#[cfg(windows)]
fn windows_resolution(executable: &str, environment: &[(String, String)]) -> Option<String> {
    let variable = |name: &str| {
        environment
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.clone())
    };
    let extensions: Vec<String> = variable("PATHEXT")
        .unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".into())
        .split(';')
        .filter(|item| !item.is_empty())
        .map(str::to_string)
        .collect();
    let has_extension = std::path::Path::new(executable).extension().is_some();
    let candidates = |base: std::path::PathBuf| -> Option<String> {
        if has_extension && base.is_file() {
            return Some(base.to_string_lossy().into_owned());
        }
        extensions
            .iter()
            .map(|extension| {
                std::path::PathBuf::from(format!("{}{extension}", base.to_string_lossy()))
            })
            .find(|path| path.is_file())
            .map(|path| path.to_string_lossy().into_owned())
    };
    if executable.contains(['\\', '/']) {
        return candidates(std::path::PathBuf::from(executable));
    }
    variable("PATH")?
        .split(';')
        .filter(|entry| !entry.is_empty())
        .find_map(|entry| candidates(std::path::Path::new(entry).join(executable)))
}

/// cmd.exe quoting of one word of a shim's command line.
#[cfg(windows)]
fn windows_quote(word: &str) -> String {
    if !word.is_empty()
        && !word.contains([' ', '\t', '"', '&', '|', '<', '>', '^', '(', ')', '%', '!'])
    {
        return word.to_string();
    }
    format!("\"{}\"", word.replace('"', "\"\""))
}

#[cfg(unix)]
fn signal_name(signal: i32) -> String {
    let name = match signal {
        1 => "SIGHUP",
        2 => "SIGINT",
        3 => "SIGQUIT",
        4 => "SIGILL",
        5 => "SIGTRAP",
        6 => "SIGABRT",
        8 => "SIGFPE",
        9 => "SIGKILL",
        11 => "SIGSEGV",
        13 => "SIGPIPE",
        14 => "SIGALRM",
        15 => "SIGTERM",
        #[cfg(target_os = "macos")]
        10 => "SIGBUS",
        #[cfg(target_os = "macos")]
        30 => "SIGUSR1",
        #[cfg(target_os = "macos")]
        31 => "SIGUSR2",
        #[cfg(not(target_os = "macos"))]
        7 => "SIGBUS",
        #[cfg(not(target_os = "macos"))]
        10 => "SIGUSR1",
        #[cfg(not(target_os = "macos"))]
        12 => "SIGUSR2",
        _ => return format!("signal {signal}"),
    };
    name.to_string()
}

/// `Number(cursor)` as a byte offset.
fn cursor_offset(cursor: &str) -> Option<usize> {
    let trimmed = crate::text::js_trim(cursor);
    if trimmed.is_empty() {
        return Some(0);
    }
    let value: f64 = trimmed.parse().ok()?;
    (value.fract() == 0.0 && (0.0..=9_007_199_254_740_991.0).contains(&value))
        .then_some(value as usize)
}

impl CommandHandle {
    fn process(state: &State) -> &'static str {
        match state.interruption {
            Some("cancelled") => "cancelled",
            Some("timed_out") => "timed_out",
            _ if state.finished => "exited",
            _ => "running",
        }
    }

    /// Output from the cursor; with a limit, one page of at most that many
    /// bytes ending on a character boundary (the latest output without a
    /// cursor), so paging skips nothing.
    pub fn inspect(&self, cursor: Option<&str>, limit: Option<usize>) -> Outcome<Snapshot> {
        let state = self.0.lock();
        let offset = match cursor {
            None => 0,
            Some(cursor) => cursor_offset(cursor)
                .filter(|offset| *offset <= state.bytes.len())
                .ok_or_else(|| Failure::new(format!("Invalid run cursor {cursor}.")))?,
        };
        let content = &state.bytes;
        let (mut start, mut end) = (offset, content.len());
        if let Some(limit) = limit {
            if cursor.is_none() {
                start = character_start(content, end.saturating_sub(limit));
            } else {
                end = character_end(content, end.min(start + limit));
            }
        }
        Ok(Snapshot {
            cursor: end.to_string(),
            output: String::from_utf8_lossy(&content[start..end]).into_owned(),
            process: Self::process(&state),
            start: limit.map(|_| start),
            total_bytes: limit.map(|_| content.len()),
        })
    }

    /// Returns once output passed the cursor, the process ended, or after the timeout.
    pub fn wait_for_update(
        &self,
        cursor: Option<&str>,
        timeout: Duration,
        signal: &Signal,
    ) -> Outcome<Snapshot> {
        signal.check()?;
        let first = self.inspect(cursor, None)?;
        let from = cursor.and_then(cursor_offset).unwrap_or(0);
        if first.process != "running"
            || cursor_offset(&first.cursor).unwrap_or(0) > from
            || timeout.is_zero()
        {
            return Ok(first);
        }
        let deadline = Instant::now() + timeout;
        let mut state = self.0.lock();
        loop {
            if signal.aborted() {
                return Err(Failure::new("Inspection cancelled."));
            }
            let now = Instant::now();
            if state.finished
                || state.interruption.is_some()
                || state.bytes.len() > from
                || now >= deadline
            {
                break;
            }
            state = self
                .0
                .changed
                .wait_timeout(state, POLL.min(deadline - now))
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .0;
        }
        drop(state);
        self.inspect(cursor, None)
    }

    /// Returns once the process ended, or after the timeout.
    pub fn wait_for_exit(&self, timeout: Duration, signal: &Signal) -> Outcome<()> {
        signal.check()?;
        let deadline = Instant::now() + timeout;
        let mut state = self.0.lock();
        while !state.finished {
            if signal.aborted() {
                return Err(Failure::new("Inspection cancelled."));
            }
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            state = self
                .0
                .changed
                .wait_timeout(state, POLL.min(deadline - now))
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .0;
        }
        Ok(())
    }

    pub fn finished(&self) -> bool {
        self.0.lock().finished
    }

    /// Waits for the command's end.
    pub fn completion(&self) -> CommandOutcome {
        let mut state = self.0.lock();
        loop {
            if let Some(outcome) = &state.outcome {
                return outcome.clone();
            }
            state = self
                .0
                .changed
                .wait(state)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }
}

/// The first byte at or after index that starts a UTF-8 character.
fn character_start(content: &[u8], mut index: usize) -> usize {
    while index < content.len() && content[index] & 0xc0 == 0x80 {
        index += 1;
    }
    index
}

/// The last character boundary at or before index.
fn character_end(content: &[u8], mut index: usize) -> usize {
    while index > 0 && index < content.len() && content[index] & 0xc0 == 0x80 {
        index -= 1;
    }
    index
}

/// Node's `StringDecoder("utf8")`: complete characters out, an incomplete
/// tail kept for the next chunk, invalid bytes as U+FFFD.
#[derive(Default)]
pub struct Utf8Decoder {
    pending: Vec<u8>,
}

impl Utf8Decoder {
    pub fn write(&mut self, chunk: &[u8]) -> String {
        self.pending.extend_from_slice(chunk);
        let keep = incomplete_tail(&self.pending);
        let complete = self.pending.len() - keep;
        let text = String::from_utf8_lossy(&self.pending[..complete]).into_owned();
        self.pending.drain(..complete);
        text
    }

    pub fn end(&mut self) -> String {
        let text = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        text
    }
}

/// The length of a trailing sequence that may still become a character.
fn incomplete_tail(bytes: &[u8]) -> usize {
    for back in 1..=3.min(bytes.len()) {
        let byte = bytes[bytes.len() - back];
        if byte & 0xc0 == 0x80 {
            continue;
        }
        let needed = match byte {
            0xc2..=0xdf => 2,
            0xe0..=0xef => 3,
            0xf0..=0xf4 => 4,
            _ => return 0,
        };
        return if needed > back { back } else { 0 };
    }
    0
}

/// Runs a command to its end.
pub fn execute(
    executable: &str,
    args: &[String],
    options: CommandOptions,
) -> Outcome<CommandOutcome> {
    Ok(start(executable, args, options)?.completion())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn options(timeout_ms: u64) -> CommandOptions {
        CommandOptions {
            cwd: ".".into(),
            environment: std::env::vars().collect(),
            signal: Signal::default(),
            timeout_ms,
            maximum_output_bytes: DEFAULT_OUTPUT_LIMIT,
        }
    }

    #[test]
    fn runs_and_times_out() {
        let done = execute(
            "/bin/sh",
            &["-c".into(), "printf 'a\\n'; echo b >&2; exit 3".into()],
            options(5_000),
        )
        .unwrap();
        assert_eq!(done.exit_code, Some(3));
        assert!(done.failed && done.all.contains('a') && done.all.contains('b'));
        let slow = execute("/bin/sh", &["-c".into(), "sleep 5".into()], options(200)).unwrap();
        assert_eq!(slow.interruption, Some("timed_out"));
        assert!(slow.all.ends_with("Command timed out after 200 ms."));
        let missing = execute("/nonexistent/tool", &[], options(1_000)).unwrap();
        assert_eq!(missing.all, "spawn /nonexistent/tool ENOENT");
    }

    #[test]
    fn runs_a_shebang_less_script_through_sh() {
        let directory = std::env::temp_dir().join(format!("blame-enoexec-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let script = directory.join("tool");
        std::fs::write(&script, "echo \"ran $1\"\n").unwrap();
        std::fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .unwrap();
        let mut by_name = options(5_000);
        by_name.environment.retain(|(name, _)| name != "PATH");
        by_name.environment.push((
            "PATH".into(),
            format!("{}:/usr/bin:/bin", directory.display()),
        ));
        let done = execute("tool", &["typecheck".into()], by_name).unwrap();
        assert_eq!(
            (done.exit_code, done.all.trim()),
            (Some(0), "ran typecheck")
        );
        let by_path = execute(&script.to_string_lossy(), &["lint".into()], options(5_000)).unwrap();
        assert_eq!(by_path.all.trim(), "ran lint");
        std::fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn decodes_split_characters() {
        let mut decoder = Utf8Decoder::default();
        let bytes = "é".as_bytes();
        assert_eq!(decoder.write(&bytes[..1]), "");
        assert_eq!(decoder.write(&bytes[1..]), "é");
        assert_eq!(decoder.write(&[0xff]), "\u{fffd}");
    }
}
