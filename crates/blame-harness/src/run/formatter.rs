//! Prettier invocations applied as one atomic journaled edit
//! (`deterministic-formatter.ts`): each named file is formatted through
//! stdin, and the results are committed together by the edit service.

use super::environment::{process_environment, workspace_command_environment};
use super::output::diagnostic;
use crate::failure::{Failure, Signal};
use crate::files::WorkspaceFiles;
use crate::present::redact_secrets;
use crate::text::js_trim;
use regex::Regex;
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::LazyLock;
use std::thread;
use std::time::{Duration, Instant};

const MAXIMUM_FILE: u64 = 2_097_152;
const MAXIMUM_OUTPUT: usize = 4 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct FormatterCommand {
    pub executable: String,
    pub args: Vec<String>,
    /// The directory of a leading `cd <dir> &&`, relative to the command's cwd.
    pub cwd: Option<String>,
    pub paths: Vec<String>,
}

/// A formatter failure: its category and message.
pub struct FormatterError {
    pub category: &'static str,
    pub message: String,
}

impl From<Failure> for FormatterError {
    fn from(failure: Failure) -> Self {
        FormatterError {
            category: "environment",
            message: failure.message,
        }
    }
}

/// `(path, before, formatted)` for each file.
pub type Replacements = Vec<(String, Vec<u8>, Vec<u8>)>;

static RECOVERY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?-u:\b)prettier(?-u:\b)[^\n]*\s--write(?:\s|$)").expect("pattern")
});

/// A Prettier write this harness cannot apply atomically: how to submit it.
pub fn recovery(command: &str) -> Option<&'static str> {
    RECOVERY.is_match(command).then_some(
        "This request combines or ambiguously scopes Prettier. Submit `pnpm exec prettier --write <explicit existing files>` alone; for npm projects use `npx --no-install prettier --write <explicit existing files>` or `npm exec --no -- prettier --write <explicit existing files>`. It will be applied as one atomic journaled edit.",
    )
}

// `cd packages/app && pnpm exec prettier --write …` runs a package's own
// formatter: the directory becomes the command's cwd.
static CD_PREFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"^\s*cd\s+([^\s;&|<>'"`$\\]+)\s*&&\s*"#).expect("pattern"));
// A trailing `2>&1 | tail -15` only trims what the agent would read; the
// harness reports the formatted files itself.
static DISPLAY_FILTER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:\s+2>&1)?(?:\s*\|\s*(?:tail|head)(?:\s+-n)?(?:\s+-?\d+)?)?\s*$")
        .expect("pattern")
});
static SHELL_SYNTAX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"[;&|<>\n\r'"`]"#).expect("pattern"));
static GLOB: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[*?{}\[\]]").expect("pattern"));

const PREFIXES: [&[&str]; 9] = [
    &["npx", "--no-install", "prettier"],
    &["npx", "prettier"],
    &["npm", "exec", "--no", "--", "prettier"],
    &["pnpm", "exec", "prettier"],
    &["pnpm", "prettier"],
    &["yarn", "prettier"],
    &["node_modules/.bin/prettier"],
    &["./node_modules/.bin/prettier"],
    &["prettier"],
];

pub fn request(command: &str) -> Option<FormatterCommand> {
    let cd = CD_PREFIX.captures(command);
    let rest = match &cd {
        Some(captures) => &command[captures.get(0).expect("match").end()..],
        None => command,
    };
    let rest = DISPLAY_FILTER.replace(rest, "");
    if SHELL_SYNTAX.is_match(&rest) {
        return None;
    }
    let tokens: Vec<&str> = js_trim(&rest).split_whitespace().collect();
    let prefix = PREFIXES.iter().find(|prefix| {
        tokens.len() > prefix.len()
            && prefix
                .iter()
                .enumerate()
                .all(|(index, value)| tokens[index] == *value)
    })?;
    // The installed Prettier only: a formatter edit never downloads a package.
    let run: Vec<&str> = if prefix.join(" ") == "npx prettier" {
        vec!["npx", "--no-install", "prettier"]
    } else {
        prefix.to_vec()
    };
    let values = &tokens[prefix.len()..];
    if values.iter().filter(|value| **value == "--write").count() != 1 {
        return None;
    }
    let paths: Vec<String> = values
        .iter()
        .filter(|value| **value != "--write")
        .map(|value| value.to_string())
        .collect();
    if paths.is_empty()
        || paths.len() > 50
        || paths
            .iter()
            .any(|path| path.starts_with('-') || GLOB.is_match(path))
    {
        return None;
    }
    Some(FormatterCommand {
        executable: run[0].to_string(),
        args: run[1..].iter().map(|arg| arg.to_string()).collect(),
        cwd: cd.map(|captures| captures[1].to_string()),
        paths,
    })
}

/// Formats each file; nothing is written here.
pub fn format(
    files: &WorkspaceFiles,
    request: &FormatterCommand,
    cwd: &str,
    signal: &Signal,
) -> Result<Replacements, FormatterError> {
    let local = crate::pathx::relative(&files.root, cwd);
    let mut unique: Vec<String> = Vec::new();
    for path in &request.paths {
        let normalized = files.normalize_path(&if local.is_empty() {
            path.clone()
        } else {
            format!("{local}/{path}")
        })?;
        if !unique.contains(&normalized) {
            unique.push(normalized);
        }
    }
    if unique.len() != request.paths.len() {
        return Err(FormatterError {
            category: "input",
            message: "Formatter file paths must be unique.".into(),
        });
    }
    for path in &unique {
        match files.path_profile(path) {
            Ok(profile) if !profile.directory => {
                if profile.size > MAXIMUM_FILE {
                    return Err(FormatterError {
                        category: "input",
                        message: format!(
                            "Formatter target {path} exceeds the 2 MiB atomic edit limit."
                        ),
                    });
                }
            }
            _ => {
                return Err(FormatterError {
                    category: "input",
                    message: format!("Formatter target {path} must be an existing regular file."),
                });
            }
        }
    }
    let mut replacements = Vec::new();
    for path in unique {
        let absolute = files.resolve_for_write(&path)?;
        let before = files.read(&path)?.content;
        let run = run_formatter(request, &absolute, &before, cwd, signal)?;
        if run.exit_code != Some(0) {
            let output = redact_secrets(&format!(
                "{}\n{}",
                String::from_utf8_lossy(&run.stdout),
                String::from_utf8_lossy(&run.stderr)
            ));
            let shown = js_trim(&diagnostic(&output)).to_string();
            let message = if shown.is_empty() {
                format!(
                    "Formatter exited with code {}.",
                    run.exit_code
                        .map_or("undefined".to_string(), |code| code.to_string())
                )
            } else {
                shown
            };
            return Err(FormatterError {
                category: "code",
                message,
            });
        }
        if run.stdout.len() as u64 > MAXIMUM_FILE {
            return Err(FormatterError {
                category: "code",
                message: format!(
                    "Formatted output for {path} exceeds the 2 MiB atomic edit limit."
                ),
            });
        }
        replacements.push((path, before, run.stdout));
    }
    Ok(replacements)
}

struct FormatterRun {
    exit_code: Option<i32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

fn run_formatter(
    request: &FormatterCommand,
    path: &str,
    input: &[u8],
    cwd: &str,
    signal: &Signal,
) -> Result<FormatterRun, FormatterError> {
    // stdout becomes source text: package-manager progress stays out of it.
    let mut args: Vec<String> = if request.executable == "pnpm" {
        std::iter::once("--reporter=silent".to_string())
            .chain(request.args.iter().cloned())
            .collect()
    } else {
        request.args.clone()
    };
    args.extend(["--stdin-filepath".to_string(), path.to_string()]);
    let environment = workspace_command_environment(process_environment(), None);
    let mut child = Command::new(&request.executable)
        .args(&args)
        .current_dir(cwd)
        .env_clear()
        .envs(environment)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| FormatterError {
            category: "environment",
            message: format!(
                "spawn {} {}",
                request.executable,
                error
                    .raw_os_error()
                    .map_or(error.to_string(), |code| if code == 2 {
                        "ENOENT".into()
                    } else {
                        format!("E{code}")
                    })
            ),
        })?;
    let mut stdin = child.stdin.take().expect("stdin");
    let input = input.to_vec();
    let writer = thread::spawn(move || {
        let _ = stdin.write_all(&input);
    });
    let reader = |stream: Option<Box<dyn Read + Send>>| {
        thread::spawn(move || {
            let mut bytes = Vec::new();
            if let Some(stream) = stream {
                let _ = stream
                    .take(MAXIMUM_OUTPUT as u64 + 1)
                    .read_to_end(&mut bytes);
            }
            bytes
        })
    };
    let stdout = reader(
        child
            .stdout
            .take()
            .map(|stream| Box::new(stream) as Box<dyn Read + Send>),
    );
    let stderr = reader(
        child
            .stderr
            .take()
            .map(|stream| Box::new(stream) as Box<dyn Read + Send>),
    );
    let deadline = Instant::now() + Duration::from_secs(30);
    let status = loop {
        if let Ok(Some(status)) = child.try_wait() {
            break Some(status);
        }
        if signal.aborted() || Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        thread::sleep(Duration::from_millis(10));
    };
    let _ = writer.join();
    let (stdout, stderr) = (
        stdout.join().unwrap_or_default(),
        stderr.join().unwrap_or_default(),
    );
    let exit_code = status
        .and_then(|status| status.code())
        .filter(|_| stdout.len() <= MAXIMUM_OUTPUT && stderr.len() <= MAXIMUM_OUTPUT);
    Ok(FormatterRun {
        exit_code,
        stdout,
        stderr,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_prettier_writes() {
        let request =
            request("cd packages/app && npx prettier --write a.ts b.ts 2>&1 | tail -5").unwrap();
        assert_eq!(request.args, vec!["--no-install", "prettier"]);
        assert_eq!(request.cwd.as_deref(), Some("packages/app"));
        assert_eq!(request.paths, vec!["a.ts", "b.ts"]);
        assert!(super::request("prettier --write 'a.ts'").is_none());
        assert!(recovery("prettier --write src/*.ts && echo").is_some());
    }
}
