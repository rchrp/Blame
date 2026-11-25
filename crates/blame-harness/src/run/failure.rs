//! How a failed command is presented: who must act and what to try next
//! (`command-failure.ts`).

use super::catalog::is_validation_kind;
use super::output::diagnostic;
use super::shell_words::literal_shell_statements;
use crate::json::Json;
use crate::obj;
use crate::text::js_trim;
use regex::Regex;
use std::sync::LazyLock;

/// The category and recovery text of a failed command.
#[derive(Clone, Debug, PartialEq)]
pub struct Assessment {
    pub category: &'static str,
    pub recovery: String,
}

pub const DEPENDENCY_SECTIONS: [&str; 4] = [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
];

pub fn failed_command_result(
    exit_code: Option<i32>,
    output: &str,
    failure: &Assessment,
    command: Option<&str>,
) -> Json {
    let filter = if exit_code == Some(1) {
        command.and_then(final_filter)
    } else {
        None
    };
    if let Some(filter) = filter {
        let message = if !js_trim(output).is_empty() {
            format!(
                "Command exited with code 1 because its last command, `{filter}`, selected no line; that exit code is {filter}'s. Output of the commands before it:\n{}",
                diagnostic(output)
            )
        } else {
            format!(
                "Command exited with code 1: its last stage, `{filter}`, selected no line, so nothing was printed. That exit code is {filter}'s, not the earlier commands'."
            )
        };
        return obj! {
            "status" => "blocked",
            "category" => "command",
            "message" => message,
            "recovery" => "Rerun without the final filter or with a broader pattern, or write the output to a file and search that file.",
        };
    }
    let (head, output) = match exit_code {
        Some(code) => (format!("Command exited with code {code}."), output),
        // Stopped by the harness: its reason, which ends the output, comes first.
        None => match output.rsplit_once('\n') {
            Some((rest, last)) if STOP_REASONS.iter().any(|reason| last.starts_with(reason)) => {
                (last.to_string(), rest)
            }
            _ if STOP_REASONS.iter().any(|reason| output.starts_with(reason)) => {
                (output.to_string(), "")
            }
            _ => ("Command ended without an exit code.".to_string(), output),
        },
    };
    let shown = diagnostic(output);
    let shown = if shown.is_empty() {
        "No diagnostic output was produced.".to_string()
    } else {
        shown
    };
    obj! {
        "status" => "blocked",
        "category" => failure.category,
        "message" => format!("{head}\n{shown}"),
        "recovery" => failure.recovery.as_str(),
    }
}

/// The lines the process layer adds when it stops a command (`process.rs`).
const STOP_REASONS: [&str; 3] = [
    "Command cancelled before completion.",
    "Command timed out after ",
    "Command stopped: its output passed the captured output limit.",
];

const FILTERS: [&str; 4] = ["egrep", "fgrep", "grep", "rg"];
/// Stages that pass a filter's lines on: with pipefail, `grep x | head` exits
/// with grep's status.
const PASS_THROUGH: [&str; 8] = ["head", "tail", "sort", "uniq", "wc", "cut", "tr", "cat"];
static QUOTED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"'[^']*'|"(?:[^"\\]|\\.)*""#).expect("pattern"));
static TRAILING_FILTER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:\||;|&&)\s*(e?grep|fgrep|rg)(?-u:\b)[^|;&]*(?:\|\s*(?:head|tail|sort|uniq|wc|cut|tr|cat)(?-u:\b)[^|;&]*)*$")
        .expect("pattern")
});

/// The grep or rg that ends the command line, after other statements or
/// commands and before pass-through stages: its "no line matched" status
/// becomes the whole command's.
fn final_filter(command: &str) -> Option<String> {
    if let Some(statements) = literal_shell_statements(command) {
        let last = &statements.last()?.pipeline;
        let name = last
            .iter()
            .rev()
            .map(|stage| stage.words.first().map(|word| word.value.as_str()))
            .find(|name| !name.is_some_and(|name| PASS_THROUGH.contains(&name)))??
            .to_string();
        return ((last.len() > 1 || statements.len() > 1) && FILTERS.contains(&name.as_str()))
            .then_some(name);
    }
    // Not a literal command line (variables, assignments): read it without its quoted words.
    let unquoted = QUOTED.replace_all(command, "''");
    TRAILING_FILTER
        .captures(&unquoted)
        .map(|captures| captures[1].to_string())
}
/// Exit status 1 of a read-only search is not the filter's "no line
/// selected" when lines were printed through a last pipeline with a stage
/// that is neither a filter nor a pass-through (`find`, `ls`): pipefail
/// reports that stage, and the filter did select lines.
pub fn exit_from_other_stage(command: &str, output: &str) -> bool {
    if js_trim(output).is_empty() {
        return false;
    }
    let Some(statements) = literal_shell_statements(command) else {
        return false;
    };
    let Some(last) = statements.last() else {
        return false;
    };
    last.pipeline.len() > 1
        && last.pipeline.iter().any(|stage| {
            !stage.words.first().is_some_and(|word| {
                FILTERS.contains(&word.value.as_str())
                    || PASS_THROUGH.contains(&word.value.as_str())
            })
        })
}

static EXIT_127: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?m)^(?:/[^\s:]+/)?(?:sh|dash):\s*(?:line\s+)?(?:\d+:\s*)?[^:\r\n]+:\s*not found\s*$",
    )
    .expect("pattern")
});
static ENVIRONMENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:(?-u:\b)EAI_AGAIN(?-u:\b)|(?-u:\b)EACCES(?-u:\b)|(?-u:\b)ECONN(?:REFUSED|RESET)?(?-u:\b)|(?-u:\b)ENETUNREACH(?-u:\b)|(?-u:\b)ENOSPC(?-u:\b)|(?-u:\b)ENOENT(?-u:\b)|(?-u:\b)ENOTFOUND(?-u:\b)|(?-u:\b)EPERM(?-u:\b)|(?-u:\b)ETIMEDOUT(?-u:\b)|(?-u:\b)ELOOP(?-u:\b)|(?-u:\b)P1001(?-u:\b)|broken (?:symbolic )?link|can't reach database server|command not found|connection refused|could not connect to server|dangling symlink|failed to connect|managed preview.*(?:failed|unavailable)|no space left on device|no such file or directory|not recognized as an internal or external command|PACKAGE_MANAGER_UNAVAILABLE|permission denied|preview (?:container|runtime).*(?:failed|unavailable)|\.prisma/client)").expect("pattern")
});
static TRACEBACK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"Traceback \(most recent call last\):").expect("pattern"));
static PYTHON_MODULE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?:^|\n)[^\r\n]*(?-u:\b)python(?:\d+(?:\.\d+)*)?(?:\.exe)?: No module named ([\w.]+)\s*$",
    )
    .expect("pattern")
});
static ENVIRONMENT_VARIABLES: LazyLock<[Regex; 3]> = LazyLock::new(|| {
    [
        r"(?i)Cannot resolve environment variable:\s*([A-Z][A-Z0-9_]*)",
        r"(?i)Environment variable not found:\s*([A-Z][A-Z0-9_]*)",
        r"(?i)Missing environment variable:\s*([A-Z][A-Z0-9_]*)",
    ]
    .map(|pattern| Regex::new(pattern).expect("pattern"))
});
static MISSING_DEPENDENCIES: LazyLock<[Regex; 2]> = LazyLock::new(|| {
    [
        r#"(?i)Cannot find (?:module|package)\s+['"`]([^'"`]+)['"`]"#,
        r#"(?i)Module not found:\s*(?:Error:\s*)?Can't resolve\s+['"`]([^'"`]+)['"`]"#,
    ]
    .map(|pattern| Regex::new(pattern).expect("pattern"))
});

/// `declared`: the dependency names the workspace's manifests declare,
/// asked only when the output names a missing module.
pub fn command_failure_assessment(
    output: &str,
    declared: impl FnOnce() -> Vec<String>,
    task_kind: Option<&str>,
    exit_code: Option<i32>,
) -> Assessment {
    let mut variables: Vec<String> = Vec::new();
    for expression in ENVIRONMENT_VARIABLES.iter() {
        for captures in expression.captures_iter(output) {
            let name = captures[1].to_string();
            if !variables.contains(&name) {
                variables.push(name);
            }
        }
    }
    if !variables.is_empty() {
        let plural = variables.len() > 1;
        return Assessment {
            category: "environment",
            recovery: format!(
                "Required runtime variable{} {} {} unavailable. Keep configuration environment-based; do not add credentials, localhost URLs, or source fallbacks. Continue with validations that do not require these values and report this validation unavailable.",
                if plural { "s" } else { "" },
                variables.join(", "),
                if plural { "are" } else { "is" }
            ),
        };
    }
    if !TRACEBACK.is_match(output)
        && let Some(captures) = PYTHON_MODULE.captures(output)
    {
        return Assessment {
            category: "environment",
            recovery: format!(
                "Python cannot start module {} in this interpreter. Check the project environment and module name; install the required tool with the project's package manager if needed, then rerun the command.",
                &captures[1]
            ),
        };
    }
    let missing: Vec<String> = MISSING_DEPENDENCIES
        .iter()
        .flat_map(|expression| {
            expression
                .captures_iter(output)
                .filter_map(|captures| dependency_name(&captures[1]))
                .collect::<Vec<_>>()
        })
        .collect();
    if !missing.is_empty() {
        let declared = declared();
        return if missing.iter().any(|name| declared.contains(name)) {
            Assessment {
                category: "environment",
                recovery: "Use the dependency operation once if the declared installation is incomplete; do not edit manifests or copy files through the shell.".into(),
            }
        } else {
            code_failure()
        };
    }
    // POSIX sh/dash omits "command" in its missing-executable diagnostic:
    // its shell-prefixed line and exit 127, not any "not found" text.
    if (exit_code == Some(127) && EXIT_127.is_match(output)) || ENVIRONMENT.is_match(output) {
        return environment_failure();
    }
    if is_validation_kind(task_kind) {
        code_failure()
    } else {
        command_failure()
    }
}

fn dependency_name(value: &str) -> Option<String> {
    let portable = value.replace('\\', "/");
    if let Some(installed) = portable
        .rsplit("/node_modules/")
        .next()
        .filter(|installed| *installed != portable && !installed.is_empty())
    {
        let segments: Vec<&str> = installed.split('/').collect();
        return Some(if installed.starts_with('@') {
            segments[..segments.len().min(2)].join("/")
        } else {
            segments[0].to_string()
        });
    }
    if value.is_empty() || value.starts_with('.') || value.starts_with('/') || value.contains('\\')
    {
        return None;
    }
    let segments: Vec<&str> = value.split('/').collect();
    Some(if value.starts_with('@') {
        segments[..segments.len().min(2)].join("/")
    } else {
        segments[0].to_string()
    })
}

/// The names the workspace's manifests (`package.json`, the first 200)
/// declare in their dependency sections.
pub fn declared_dependencies(
    files: &crate::files::WorkspaceFiles,
    snapshot_files: &[String],
) -> Vec<String> {
    let mut names = Vec::new();
    for path in snapshot_files
        .iter()
        .filter(|path| path.ends_with("package.json"))
        .take(200)
    {
        let Ok(file) = files.read(path) else { continue };
        let Ok(manifest) = Json::parse(&String::from_utf8_lossy(&file.content)) else {
            continue;
        };
        for section in DEPENDENCY_SECTIONS {
            if let Some(Json::Obj(entries)) = manifest.get(section) {
                for (name, _) in entries {
                    if !names.contains(name) {
                        names.push(name.clone());
                    }
                }
            }
        }
    }
    names
}

fn code_failure() -> Assessment {
    Assessment {
        category: "code",
        recovery: "Fix the reported project error before running the relevant validation again."
            .into(),
    }
}

fn environment_failure() -> Assessment {
    Assessment {
        category: "environment",
        recovery: "Inspect the reported environment problem and recover the required tool, path, or service through the available project operations before retrying.".into(),
    }
}

pub fn command_failure() -> Assessment {
    Assessment { category: "command", recovery: "Inspect the command output and adjust the command or its prerequisites before retrying.".into() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assesses_failures() {
        let none = Vec::new;
        assert_eq!(
            command_failure_assessment(
                "Missing environment variable: DATABASE_URL",
                none,
                None,
                Some(1)
            )
            .category,
            "environment"
        );
        assert_eq!(
            command_failure_assessment("sh: 1: foo: not found", none, None, Some(127)).category,
            "environment"
        );
        assert_eq!(
            command_failure_assessment(
                "Cannot find module 'left-pad'",
                || vec!["left-pad".into()],
                Some("test"),
                Some(1)
            )
            .category,
            "environment"
        );
        assert_eq!(
            command_failure_assessment("boom", none, Some("test"), Some(1)).category,
            "code"
        );
        assert_eq!(final_filter("cat a | grep x"), Some("grep".into()));
        assert_eq!(final_filter("grep x a"), None);
        assert_eq!(
            dependency_name("/a/node_modules/@scope/pkg/index.js"),
            Some("@scope/pkg".into())
        );
    }
}
