//! Symbol actions as byte replacements (`light-symbol-replacement.ts`,
//! `python-body.ts`, `patch-symbol-attribution.ts`).

use crate::aliases::ResolvedSymbol;
use crate::coverage::Interval;
use crate::failure::{Failure, Outcome};
use crate::languages::capability_for_path;
use crate::patch::Replacement;
use crate::syntax::{ParsedSymbol, parse_code, symbol_edit_range, syntax_boundary_range};
use crate::text::js_trim;
use regex::Regex;
use std::sync::LazyLock;

/// A planned replacement and the operation it comes from, for overlap errors.
#[derive(Clone, Debug)]
pub struct SourcedReplacement {
    pub start: usize,
    pub end: usize,
    pub replacement: String,
    pub source: String,
}

pub fn symbol_replacement(
    resolved: &ResolvedSymbol,
    action: &str,
    target: &str,
    content: Option<&str>,
) -> Outcome<SourcedReplacement> {
    if action == "rename" {
        return Err(Failure::new(
            "Semantic rename requires the compiler planner.",
        ));
    }
    let replacement = content.unwrap_or("");
    let source = format!("{action} {target}");
    if action == "replace_body" {
        return Ok(body_replacement(resolved, replacement, source));
    }
    let range = syntax_boundary_range(&resolved.path, &resolved.content, resolved.symbol.range);
    Ok(match action {
        "insert_before" => SourcedReplacement {
            start: range.0,
            end: range.0,
            replacement: replacement.into(),
            source,
        },
        "insert_after" => SourcedReplacement {
            start: range.1,
            end: range.1,
            replacement: replacement.into(),
            source,
        },
        _ => SourcedReplacement {
            start: range.0,
            end: range.1,
            replacement: if action == "delete" {
                String::new()
            } else {
                without_repeated_first_line_indent(resolved, range.0, replacement)
            },
            source,
        },
    })
}

fn body_replacement(
    resolved: &ResolvedSymbol,
    replacement: &str,
    source: String,
) -> SourcedReplacement {
    let range = symbol_edit_range(&resolved.symbol, "body");
    if capability_for_path(&resolved.path).is_some_and(|capability| capability.language == "python")
    {
        let (start, end) = python_body_range(&resolved.content, range);
        return SourcedReplacement {
            start,
            end,
            replacement: python_body_replacement(&resolved.content, (start, end), replacement),
            source,
        };
    }
    let current = String::from_utf8_lossy(&resolved.content[range.0..range.1]).into_owned();
    let base_indent = line_indent_before(&resolved.content, range.0);
    SourcedReplacement {
        start: range.0,
        end: range.1,
        replacement: normalized_symbol_body(&current, replacement, &base_indent),
        source,
    }
}

fn delimited(value: &str) -> bool {
    value.starts_with('{') && value.ends_with('}')
}

fn normalized_symbol_body(current: &str, replacement: &str, base_indent: &str) -> String {
    let current_body = js_trim(current);
    let proposed = js_trim(replacement);
    if !delimited(current_body) || delimited(proposed) {
        return replacement.to_string();
    }
    if !proposed.contains('\n') {
        return format!("{{ {proposed} }}");
    }
    let indent = existing_body_indent(current).unwrap_or_else(|| format!("{base_indent}  "));
    format!(
        "{{\n{}\n{base_indent}}}",
        indented_statements(replacement, &indent)
    )
}

/// `prefix.match(/(?:^|\n)([\t ]*)[^\n]*$/u)?.[1]`: the indent of the line holding `offset`.
fn line_indent_before(content: &[u8], offset: usize) -> String {
    let prefix = String::from_utf8_lossy(&content[..offset]).into_owned();
    let line = prefix.rsplit('\n').next().unwrap_or("");
    line.chars()
        .take_while(|character| *character == ' ' || *character == '\t')
        .collect()
}

static BODY_INDENT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\n([\t ]+)\S").expect("pattern"));

fn existing_body_indent(body: &str) -> Option<String> {
    BODY_INDENT
        .captures(body)
        .and_then(|captures| captures.get(1))
        .map(|indent| indent.as_str().to_string())
}

fn leading_width(line: &str) -> usize {
    line.chars()
        .take_while(|character| *character == ' ' || *character == '\t')
        .count()
}

fn indented_statements(value: &str, indent: &str) -> String {
    let all: Vec<&str> = value
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect();
    let start = all
        .iter()
        .position(|line| !js_trim(line).is_empty())
        .unwrap_or(0);
    let trailing = all
        .iter()
        .rev()
        .position(|line| !js_trim(line).is_empty())
        .unwrap_or(0);
    let end = all.len() - trailing - 1;
    let lines = &all[start..=end.max(start).min(all.len() - 1)];
    let width = lines
        .iter()
        .filter(|line| !js_trim(line).is_empty())
        .map(|line| leading_width(line))
        .min()
        .unwrap_or(0);
    lines
        .iter()
        .map(|line| {
            if js_trim(line).is_empty() {
                String::new()
            } else {
                format!("{indent}{}", line.get(width..).unwrap_or(""))
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn without_repeated_first_line_indent(
    resolved: &ResolvedSymbol,
    start: usize,
    replacement: &str,
) -> String {
    let language = capability_for_path(&resolved.path).map(|capability| capability.language);
    if !matches!(language, Some("javascript" | "typescript" | "jsx" | "tsx")) || start == 0 {
        return replacement.to_string();
    }
    let line_start = resolved.content[..start]
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map_or(0, |index| index + 1);
    let prefix = String::from_utf8_lossy(&resolved.content[line_start..start]).into_owned();
    // The syntax span starts after this white space, which stays in the file:
    // accept the same absolute first-line indent once, never reindent later lines.
    if !prefix.is_empty()
        && prefix
            .chars()
            .all(|character| character == ' ' || character == '\t')
        && replacement.starts_with(&prefix)
    {
        replacement[prefix.len()..].to_string()
    } else {
        replacement.to_string()
    }
}

/// A Python body starts at its line when only indentation precedes it.
pub fn python_body_range(content: &[u8], range: Interval) -> Interval {
    let start = line_start(content, range.0);
    if content[start..range.0]
        .iter()
        .all(|byte| *byte == b' ' || *byte == b'\t')
    {
        (start, range.1)
    } else {
        range
    }
}

fn line_start(content: &[u8], offset: usize) -> usize {
    if offset == 0 {
        0
    } else {
        content[..offset]
            .iter()
            .rposition(|byte| *byte == b'\n')
            .map_or(0, |index| index + 1)
    }
}

pub fn python_body_replacement(content: &[u8], range: Interval, body: &str) -> String {
    let prefix =
        String::from_utf8_lossy(&content[line_start(content, range.0)..range.0]).into_owned();
    let inline = !js_trim(&prefix).is_empty();
    if inline && !js_trim(body).contains('\n') {
        return js_trim(body).to_string();
    }
    let current = String::from_utf8_lossy(&content[range.0..range.1]).into_owned();
    let base: String = (if inline { &prefix } else { &current })
        .chars()
        .take_while(|character| *character == ' ' || *character == '\t')
        .collect();
    let indent = if inline {
        format!("{base}{}", if base.contains('\t') { "\t" } else { "    " })
    } else {
        base
    };
    let newline = if content.windows(2).any(|pair| pair == b"\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let normalized = reindent_python_body(body, &indent, newline);
    if inline {
        format!("{newline}{normalized}")
    } else {
        normalized
    }
}

fn reindent_python_body(body: &str, indent: &str, newline: &str) -> String {
    let input: Vec<&str> = body
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect();
    let first = input.iter().position(|line| !js_trim(line).is_empty());
    let mut lines: Vec<&str> = first.map_or(Vec::new(), |first| input[first..].to_vec());
    while lines.last().is_some_and(|line| js_trim(line).is_empty()) {
        lines.pop();
    }
    let protected = multiline_string_lines(&lines.join("\n"));
    let width = lines
        .iter()
        .enumerate()
        .filter(|(index, line)| !js_trim(line).is_empty() && !protected.contains(index))
        .map(|(_, line)| leading_width(line))
        .min();
    lines
        .iter()
        .enumerate()
        .map(|(index, line)| {
            if protected.contains(&index) {
                line.to_string()
            } else if js_trim(line).is_empty() {
                String::new()
            } else {
                // `line.slice(Infinity)` when no line sets a width.
                format!(
                    "{indent}{}",
                    width.map_or("", |width| line.get(width..).unwrap_or(""))
                )
            }
        })
        .collect::<Vec<_>>()
        .join(newline)
}

/// 0-based lines inside multi-line Python strings after their first line.
fn multiline_string_lines(source: &str) -> Vec<usize> {
    let parsed = parse_code("body.py", source.as_bytes());
    let mut lines = Vec::new();
    if let Some(tree) = parsed.trees.first() {
        let root = tree.root.root();
        for node in root.dfs() {
            if node.kind() == "string" {
                let (start, end) = (node.start_pos().line(), node.end_pos().line());
                lines.extend((0..end - start).map(|index| start + index + 1));
            }
        }
    }
    lines
}

/// Qualified names of the symbols a patch's replacements fall in.
pub fn symbols_touched(
    path: &str,
    content: Option<&[u8]>,
    replacements: &[Replacement],
) -> Vec<String> {
    let Some(content) = content else {
        return Vec::new();
    };
    let parsed = parse_code(path, content);
    if !parsed.supported {
        return Vec::new();
    }
    let mut names: Vec<String> = Vec::new();
    for replacement in replacements {
        if let Some(symbol) = smallest_containing(&parsed.symbols, replacement)
            && !names.contains(&symbol.qualified_name)
        {
            names.push(symbol.qualified_name.clone());
        }
    }
    names
}

fn smallest_containing<'s>(
    symbols: &'s [ParsedSymbol],
    replacement: &Replacement,
) -> Option<&'s ParsedSymbol> {
    let contains = |range: Interval| {
        if replacement.start == replacement.end {
            range.0 < replacement.start && replacement.start < range.1
        } else {
            range.0 <= replacement.start && replacement.end <= range.1
        }
    };
    let mut found: Vec<&ParsedSymbol> = symbols
        .iter()
        .filter(|symbol| contains(symbol.range))
        .collect();
    found.sort_by_key(|symbol| symbol.range.1 - symbol.range.0);
    found.first().copied()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wraps_unbraced_bodies() {
        assert_eq!(
            normalized_symbol_body("{ return 1; }", "return 2;", ""),
            "{ return 2; }"
        );
        assert_eq!(
            normalized_symbol_body("{\n    return 1;\n  }", "a();\nb();", "  "),
            "{\n    a();\n    b();\n  }"
        );
        assert_eq!(normalized_symbol_body("{ x }", "{ y }", ""), "{ y }");
    }

    #[test]
    fn reindents_python_bodies() {
        assert_eq!(
            reindent_python_body("\n  a = 1\n  b = 2\n\n", "    ", "\n"),
            "    a = 1\n    b = 2"
        );
    }
}
