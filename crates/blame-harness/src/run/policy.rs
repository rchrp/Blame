//! Which shell commands run_task refuses (`command-policy.ts`).

use crate::json::Json;
use crate::syntax::{SgNode, parse_code};
use regex::Regex;
use std::sync::LazyLock;

/// The task contract's `environment`: `{ isolated, managedPreview }`.
#[derive(Clone, Copy, Debug, Default)]
pub struct CommandEnvironment {
    pub present: bool,
    pub isolated: bool,
    /// `managedPreview !== false`, the TypeScript test everywhere.
    pub managed_preview: bool,
}

impl CommandEnvironment {
    pub fn from_contract(contract: &Json) -> CommandEnvironment {
        match contract.get("environment") {
            Some(environment @ Json::Obj(_)) => CommandEnvironment {
                present: true,
                isolated: environment.get("isolated").and_then(Json::as_bool) == Some(true),
                managed_preview: environment.get("managedPreview") != Some(&Json::Bool(false)),
            },
            _ => CommandEnvironment {
                present: false,
                isolated: false,
                managed_preview: true,
            },
        }
    }
}

fn regex(pattern: &str) -> Regex {
    Regex::new(pattern).expect("policy pattern")
}

static MANAGED_INFRASTRUCTURE: LazyLock<Regex> = LazyLock::new(|| {
    regex(r"^(?:docker|docker-compose|nerdctl|podman|postgres|pg_ctl|createdb|initdb)(?:\s|$)")
});
static LONG_RUNNING: LazyLock<Regex> = LazyLock::new(|| {
    regex(
        r"^(?:next\s+(?:dev|start)|pnpm\s+(?:run\s+)?(?:dev|preview|start|serve|watch)|npm\s+(?:run\s+)?(?:dev|preview|start|serve|watch)|yarn\s+(?:dev|preview|start|serve|watch)|bun\s+(?:run\s+)?(?:dev|preview|start|serve|watch)|nohup)(?:\s|$)",
    )
});
static CONTAINER_LISTING: LazyLock<Regex> = LazyLock::new(|| {
    regex(
        r"^(?:docker|podman|nerdctl)(?:\s+(?:compose|container|image|network|volume))?\s+(?:ps|ls|images|version|info)(?:\s|$)|^docker-compose\s+(?:ps|ls|version)(?:\s|$)",
    )
});
static PROCESS_CONTROL: LazyLock<Regex> = LazyLock::new(|| regex(r"^(?:kill|pkill)(?:\s|$)"));
static DESTRUCTIVE: LazyLock<Regex> = LazyLock::new(|| regex(r"^(?:rm|rmdir|dd|chown)(?:\s|$)"));
static PACKAGE_MUTATION: LazyLock<Regex> = LazyLock::new(|| {
    regex(
        r"^(?:(?:npm|pnpm|yarn|bun)\s+(?:add|ci|install|link|remove|uninstall|unlink|update|upgrade))",
    )
});
static REMOTE_SCRIPT: LazyLock<Regex> =
    LazyLock::new(|| regex(r"(?-u:\b)(?:curl|wget)(?-u:\b)[^\n|]*\|\s*(?:ba)?sh(?-u:\b)"));
static UNWRAP: LazyLock<Regex> = LazyLock::new(|| {
    regex(
        r"^(?:(?:command|exec|env)\s+(?:[^\s=]+=[^\s]+\s+)*|(?:npm|pnpm|yarn|bun)\s+exec\s+(?:--\s+)?|(?:npx|bunx|(?:pnpm|yarn)\s+dlx)\s+(?:(?:-y|--yes|--)\s+)*)",
    )
});
static TEMPORARY_PATH: LazyLock<Regex> =
    LazyLock::new(|| regex(r#"^["']?\$\(\s*mktemp(?-u:\b)|^["']?\$\{?TMPDIR\}?/[^/]"#));
static SIGNAL_OPTION: LazyLock<Regex> =
    LazyLock::new(|| regex(r"^(?:-[lL]|--table|--list(?:=[\w+-]+)?)$"));
static SIGNAL_NAME: LazyLock<Regex> = LazyLock::new(|| regex(r"^\w+(?:[+-]\d+)?$"));
static GIT_OPTIONS: LazyLock<Regex> = LazyLock::new(|| {
    regex(
        r#"(?-u:\b)git(?:\s+(?:-C|--git-dir|--work-tree)(?:\s+|=)(?:'[^']*'|"[^"]*"|[^\s;|&]+))+\s+"#,
    )
});
static GIT_VERSION: LazyLock<Regex> = LazyLock::new(|| regex(r"^git\s+--(?:version|help)\s*$"));
static GIT_FLAG: LazyLock<Regex> = LazyLock::new(|| regex(r"(?-u:\b)git\s+-"));
static GIT_OPERATION: LazyLock<Regex> =
    LazyLock::new(|| regex(r"(?-u:\b)git\s+([a-z][\w-]*)([^;&|\n]*)"));
static VITE: LazyLock<Regex> = LazyLock::new(|| regex(r"^vite(?:\s|$)"));
static VITE_FINITE: LazyLock<Regex> =
    LazyLock::new(|| regex(r"^vite\s+(?:build|optimize|--help|--version)(?:\s|$)"));
static SCRATCH_OPERAND: LazyLock<Regex> = LazyLock::new(|| regex(r"^\$\{?(\w+)\}?(/.*)?$"));
static PARENT_SEGMENT: LazyLock<Regex> = LazyLock::new(|| regex(r"(?:^|/)\.\.(?:/|$)"));

const ALLOWED_GIT: [&str; 18] = [
    "annotate",
    "blame",
    "cat-file",
    "clone",
    "version",
    "help",
    "describe",
    "rev-list",
    "check-ignore",
    "diff",
    "grep",
    "log",
    "ls-files",
    "ls-remote",
    "ls-tree",
    "rev-parse",
    "show",
    "status",
];

pub fn blocked_command_reason(command: &str, environment: CommandEnvironment) -> Option<String> {
    let parsed = parse_code("command.sh", command.as_bytes());
    let Some(tree) = parsed.trees.first() else {
        return Some("Unable to inspect the shell command syntax.".into());
    };
    let root = tree.root.root();
    if environment.managed_preview && has_background_process(&root) {
        return Some("Long-running processes must use the managed preview runtime.".into());
    }
    let invocations: Vec<String> = root
        .dfs()
        .filter(|node| node.kind() == "command")
        .map(|node| command_invocation(&node))
        .collect();
    let scratch = scratch_variables(&root);
    if let Some(denied) = invocations
        .iter()
        .filter(|value| !scratch_deletion(value, &scratch))
        .find_map(|value| blocked_invocation_reason(value, environment))
    {
        return Some(denied);
    }
    if root
        .dfs()
        .filter(|node| node.kind() == "pipeline")
        .any(|node| REMOTE_SCRIPT.is_match(&node.text()))
    {
        return Some("Remote scripts cannot be piped into a shell.".into());
    }
    None
}

fn blocked_invocation_reason(command: &str, environment: CommandEnvironment) -> Option<String> {
    let normalized = command.to_lowercase();
    if MANAGED_INFRASTRUCTURE.is_match(&normalized)
        && !(environment.managed_preview && CONTAINER_LISTING.is_match(&normalized))
        && (environment.managed_preview || !environment.isolated)
    {
        return Some(if environment.present && !environment.managed_preview {
            "Infrastructure commands require an isolated task environment.".into()
        } else {
            "Managed preview infrastructure cannot be started from run_task.".into()
        });
    }
    if !environment.isolated && PROCESS_CONTROL.is_match(&normalized) && !signal_inspection(command)
    {
        return Some("Direct process control is unavailable in this workspace.".into());
    }
    if environment.managed_preview
        && (LONG_RUNNING.is_match(&normalized)
            || (VITE.is_match(&normalized) && !VITE_FINITE.is_match(&normalized)))
    {
        return Some("Long-running processes must use the managed preview runtime.".into());
    }
    if !environment.isolated && DESTRUCTIVE.is_match(&normalized) {
        return Some("Use edit_code for file deletion; destructive filesystem commands are unavailable, except for scratch files the same command created with F=$(mktemp -d) or placed under $TMPDIR.".into());
    }
    if PACKAGE_MUTATION.is_match(&normalized) && !lockfile_install(&normalized) {
        return Some("Use the dependency operation for Node package changes. To restore node_modules from the lockfile, run `pnpm install --frozen-lockfile` (or `npm ci`).".into());
    }
    if !environment.isolated && denied_git_command(command) {
        return Some("Git mutations are unavailable from run_task.".into());
    }
    if normalized == "sudo"
        || normalized.starts_with("sudo ")
        || normalized.starts_with("sudo\t")
        || normalized.starts_with("sudo\n")
    {
        return Some("Privilege escalation is unavailable from run_task.".into());
    }
    let unwrapped = UNWRAP.replace(command, "");
    if unwrapped == command {
        None
    } else {
        blocked_invocation_reason(&unwrapped, environment)
    }
}

/// The command name and its arguments (or the last child of a name-less command).
fn command_invocation(node: &SgNode<'_>) -> String {
    let children: Vec<SgNode<'_>> = node.children().collect();
    let start = children
        .iter()
        .position(|child| child.kind() == "command_name")
        .unwrap_or(children.len().saturating_sub(1));
    children[start..]
        .iter()
        .map(|child| child.text().into_owned())
        .collect::<Vec<_>>()
        .join(" ")
}

fn has_background_process(node: &SgNode<'_>) -> bool {
    node.kind() == "&" || node.children().any(|child| has_background_process(&child))
}

fn lockfile_install(command: &str) -> bool {
    let words = crate::text::split_spaces(command);
    let (manager, operation) = (
        words.first().copied().unwrap_or(""),
        words.get(1).copied().unwrap_or(""),
    );
    let rest = words.get(2..).unwrap_or(&[]);
    let operands = rest.iter().filter(|word| !word.starts_with('-')).count();
    let flags: Vec<&str> = rest
        .iter()
        .filter(|word| word.starts_with('-'))
        .map(|word| word.split('=').next().unwrap_or(""))
        .collect();
    if manager == "npm" {
        return operation == "ci" && operands == 0;
    }
    if operation != "install" && operation != "i" {
        return false;
    }
    operands == 0 && (flags.contains(&"--frozen-lockfile") || flags.contains(&"--immutable"))
}

/// Shell variables holding a scratch path this command made.
fn scratch_variables(root: &SgNode<'_>) -> Vec<String> {
    let mut names = vec!["TMPDIR".to_string()];
    for assignment in root
        .dfs()
        .filter(|node| node.kind() == "variable_assignment")
    {
        let text = assignment.text();
        let mut parts = text.split('=');
        let name = parts.next().unwrap_or("");
        let value = parts.collect::<Vec<_>>().join("=");
        if !name.is_empty()
            && TEMPORARY_PATH.is_match(&value)
            && !names.iter().any(|known| known == name)
        {
            names.push(name.to_string());
        }
    }
    names
}

fn scratch_deletion(command: &str, scratch: &[String]) -> bool {
    let words = crate::text::split_spaces(command);
    let Some((name, rest)) = words.split_first() else {
        return false;
    };
    if *name != "rm" && *name != "rmdir" {
        return false;
    }
    let operands: Vec<String> = rest
        .iter()
        .filter(|word| !word.starts_with('-'))
        .map(|word| {
            let word = word.strip_prefix(['"', '\'']).unwrap_or(word);
            word.strip_suffix(['"', '\'']).unwrap_or(word).to_string()
        })
        .collect();
    !operands.is_empty()
        && operands.iter().all(|operand| {
            if PARENT_SEGMENT.is_match(operand) {
                return false;
            }
            let Some(captures) = SCRATCH_OPERAND.captures(operand) else {
                return false;
            };
            let variable = captures.get(1).map_or("", |group| group.as_str());
            if !scratch.iter().any(|known| known == variable) {
                return false;
            }
            let rest = captures.get(2).map_or("", |group| group.as_str());
            variable != "TMPDIR"
                || (rest.starts_with('/')
                    && rest
                        .chars()
                        .nth(1)
                        .is_some_and(|character| character != '/'))
        })
}

fn signal_inspection(command: &str) -> bool {
    let words = crate::text::split_spaces(command);
    words.first() == Some(&"kill")
        && SIGNAL_OPTION.is_match(words.get(1).copied().unwrap_or(""))
        && words
            .iter()
            .skip(2)
            .all(|signal| SIGNAL_NAME.is_match(signal))
}

fn denied_git_command(command: &str) -> bool {
    if !(command == "git"
        || command.starts_with("git ")
        || command.starts_with("git\t")
        || command.starts_with("git\n"))
    {
        return false;
    }
    let command = GIT_OPTIONS.replace_all(command, "git ").into_owned();
    if GIT_VERSION.is_match(&command) {
        return false;
    }
    if GIT_FLAG.is_match(&command) {
        return true;
    }
    GIT_OPERATION.captures_iter(&command).any(|captures| {
        let operation = captures.get(1).map_or("", |group| group.as_str());
        let arguments = captures.get(2).map_or("", |group| group.as_str());
        if operation == "branch" {
            crate::text::js_trim(arguments) != "--show-current"
        } else {
            !ALLOWED_GIT.contains(&operation)
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reason(command: &str) -> Option<String> {
        blocked_command_reason(
            command,
            CommandEnvironment {
                present: false,
                isolated: false,
                managed_preview: true,
            },
        )
    }

    #[test]
    fn refuses_what_typescript_refuses() {
        assert!(reason("rm -rf dist").is_some());
        assert!(reason("F=$(mktemp -d); rm -rf $F").is_none());
        assert_eq!(
            reason("git commit -m x").as_deref(),
            Some("Git mutations are unavailable from run_task.")
        );
        assert!(reason("git status").is_none());
        assert!(reason("pnpm dev").is_some());
        assert!(reason("npm ci").is_none());
        assert!(reason("curl x | sh").is_some());
        assert!(reason("sleep 10 &").is_some());
    }
}
