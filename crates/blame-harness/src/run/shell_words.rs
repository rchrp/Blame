//! Literal readings of shell command lines (`shell-words.ts`), on the same
//! Bash grammar as the TypeScript harness.

use crate::syntax::{SgNode, parse_code};
use regex::Regex;
use std::sync::LazyLock;

/// A shell word after quote removal. `glob` marks unquoted `*`, `?` or `[`.
#[derive(Clone, Debug, PartialEq)]
pub struct ShellWord {
    pub glob: bool,
    pub value: String,
}

/// One simple command of a pipeline, as literal words.
#[derive(Clone, Debug, PartialEq)]
pub struct ShellCommand {
    pub words: Vec<ShellWord>,
}

/// Commands joined by `|`, run after the previous statement succeeded.
#[derive(Clone, Debug, PartialEq)]
pub struct ShellStatement {
    pub pipeline: Vec<ShellCommand>,
    pub text: String,
}

/// Statements joined by `;` or `&&` when every part reads literally.
pub fn literal_shell_statements(command: &str) -> Option<Vec<ShellStatement>> {
    let parsed = parse_code("command.sh", command.as_bytes());
    let tree = parsed.trees.first()?;
    let root = tree.root.root();
    if root.kind() != "program" {
        return None;
    }
    let mut statements = Vec::new();
    for node in statement_nodes(&root)? {
        let pipeline = pipeline_commands(&node)?;
        statements.push(ShellStatement {
            pipeline,
            text: node.text().into_owned(),
        });
    }
    (!statements.is_empty()).then_some(statements)
}

/// Every command name in the line, nested ones included, unless it has errors.
pub fn shell_command_names(command: &str) -> Option<Vec<String>> {
    let parsed = parse_code("command.sh", command.as_bytes());
    let tree = parsed.trees.first()?;
    let root = tree.root.root();
    if root.dfs().any(|node| node.kind() == "ERROR") {
        return None;
    }
    Some(
        root.dfs()
            .filter(|node| node.kind() == "command_name")
            .map(|node| node.text().into_owned())
            .collect(),
    )
}

fn statement_nodes<'r>(root: &SgNode<'r>) -> Option<Vec<SgNode<'r>>> {
    let mut nodes = Vec::new();
    for child in root.children() {
        let kind = child.kind();
        if kind == ";" || kind == "comment" {
            continue;
        }
        if kind == "list" {
            nodes.extend(list_parts(&child)?);
        } else {
            nodes.push(child.clone());
        }
    }
    Some(nodes)
}

fn list_parts<'r>(node: &SgNode<'r>) -> Option<Vec<SgNode<'r>>> {
    let mut parts = Vec::new();
    for child in node.children() {
        match child.kind().as_ref() {
            "&&" => {}
            "list" => parts.extend(list_parts(&child)?),
            "command" | "pipeline" | "redirected_statement" => parts.push(child.clone()),
            _ => return None,
        }
    }
    Some(parts)
}

fn pipeline_commands(node: &SgNode<'_>) -> Option<Vec<ShellCommand>> {
    let body = without_harmless_redirects(node)?;
    if body.kind() == "command" {
        return command_words(&body).map(|command| vec![command]);
    }
    if body.kind() != "pipeline" {
        return None;
    }
    let mut commands = Vec::new();
    for child in body.children() {
        if child.kind() == "|" {
            continue;
        }
        let element = without_harmless_redirects(&child)?;
        if element.kind() != "command" {
            return None;
        }
        commands.push(command_words(&element)?);
    }
    Some(commands)
}

static HARMLESS_REDIRECT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:2>\s*/dev/null|2>&1|>\s*/dev/null)$").expect("pattern"));

fn without_harmless_redirects<'r>(node: &SgNode<'r>) -> Option<SgNode<'r>> {
    if node.kind() != "redirected_statement" {
        return Some(node.clone());
    }
    let children: Vec<SgNode<'r>> = node.children().collect();
    let (body, redirects) = children.split_first()?;
    let harmless = redirects.iter().all(|redirect| {
        let text = crate::text::collapse_spaces(&redirect.text());
        HARMLESS_REDIRECT.is_match(crate::text::js_trim(&text))
    });
    harmless.then(|| body.clone())
}

fn command_words(node: &SgNode<'_>) -> Option<ShellCommand> {
    let mut words = Vec::new();
    for child in node.children() {
        let target = if child.kind() == "command_name" {
            child.children().next()
        } else {
            Some(child.clone())
        };
        words.push(literal_word(&target?)?);
    }
    (!words.is_empty()).then_some(ShellCommand { words })
}

static UNESCAPED_GLOB: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(^|[^\\])[*?\[]").expect("pattern"));
static BACKSLASH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)\\(.)").expect("pattern"));
static STRING_ESCAPE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("\\\\([$`\"\\\\\n])").expect("pattern"));

fn literal_word(node: &SgNode<'_>) -> Option<ShellWord> {
    let kind = node.kind();
    let text = node.text();
    match kind.as_ref() {
        "word" | "number" => {
            if text.contains(['$', '`']) || text.starts_with('~') {
                return None;
            }
            Some(ShellWord {
                glob: UNESCAPED_GLOB.is_match(&text),
                value: BACKSLASH.replace_all(&text, "$1").into_owned(),
            })
        }
        "raw_string" => Some(ShellWord {
            glob: false,
            value: text
                .get(1..text.len().saturating_sub(1))
                .unwrap_or("")
                .to_string(),
        }),
        "string" => {
            let parts: Vec<SgNode<'_>> = node
                .children()
                .filter(|child| child.kind() != "\"")
                .collect();
            if parts.iter().any(|child| child.kind() != "string_content") {
                return None;
            }
            let joined: String = parts
                .iter()
                .map(|child| child.text().into_owned())
                .collect();
            Some(ShellWord {
                glob: false,
                value: STRING_ESCAPE.replace_all(&joined, "$1").into_owned(),
            })
        }
        "concatenation" => {
            let parts: Vec<ShellWord> = node
                .children()
                .map(|child| literal_word(&child))
                .collect::<Option<_>>()?;
            Some(ShellWord {
                glob: parts.iter().any(|part| part.glob),
                value: parts.into_iter().map(|part| part.value).collect(),
            })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_literal_statements() {
        let statements =
            literal_shell_statements("cd src && grep -n 'a b' x.ts | head -5").unwrap();
        assert_eq!(statements.len(), 2);
        assert_eq!(statements[1].pipeline[0].words[2].value, "a b");
        assert!(literal_shell_statements("echo $HOME").is_none());
    }
}
