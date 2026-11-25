//! Patch planning for edit_code (`light-patch.ts`): Cline patches with exact
//! context, resolved against the current source, as byte replacements.
//! String positions are byte offsets here where TypeScript used UTF-16
//! offsets; both are converted to the same byte ranges in the end.

use crate::cline_patch::{ChangeKind, compute_patch_changes};
use crate::diff::diff_lines;
use crate::failure::{Failure, Outcome};
use crate::text::{is_js_space, js_trim, js_trim_end, utf16_len, utf16_prefix};
use regex::Regex;
use std::sync::LazyLock;

#[derive(Clone, Debug, PartialEq)]
pub struct Replacement {
    pub start: usize,
    pub end: usize,
    pub replacement: String,
}

#[derive(Clone, Debug)]
pub enum PatchPlan {
    Add(String),
    Delete,
    Update(Vec<Replacement>),
}

#[derive(Clone, Debug, Default)]
struct Hunk {
    anchor: Option<String>,
    lines: Vec<String>,
    eof: bool,
}

#[derive(Clone, Debug)]
struct ParsedPatch {
    header_index: usize,
    hunks: Vec<Hunk>,
    mode: &'static str,
    lines: Vec<String>,
}

fn error(message: impl Into<String>) -> Failure {
    Failure::new(message)
}

/// `patch.trimEnd().split(/\r?\n/u)`.
fn patch_text_lines(patch: &str) -> Vec<String> {
    js_trim_end(patch)
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line).to_string())
        .collect()
}

static FILE_HEADER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\*\*\* (?:Add|Delete|Update) File:\s*(.+)$").expect("pattern"));
static FILE_ACTION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\*\*\* (Add|Delete|Update) File:").expect("pattern"));

fn patch_headers(lines: &[String]) -> Vec<(usize, String)> {
    lines
        .iter()
        .enumerate()
        .filter_map(|(index, line)| {
            let path = js_trim(FILE_HEADER.captures(line)?.get(1)?.as_str()).to_string();
            (!path.is_empty()).then_some((index, path))
        })
        .collect()
}

fn assert_patch_envelope(lines: &[String]) -> Outcome<()> {
    if lines.first().map(String::as_str) != Some("*** Begin Patch")
        || lines.last().map(String::as_str) != Some("*** End Patch")
    {
        return Err(error("Patch must use the Cline Apply Patch format."));
    }
    Ok(())
}

pub fn split_light_patch(
    patch: &str,
    requested_path: Option<&str>,
) -> Outcome<Vec<(String, String)>> {
    let lines = normalized_patch_lines(patch, requested_path)?;
    assert_patch_envelope(&lines)?;
    let headers = patch_headers(&lines);
    if headers.is_empty() {
        return Err(error("Patch contains no file operation."));
    }
    if headers.len() > 50 {
        return Err(error("Patch contains too many files."));
    }
    if lines[1..headers[0].0]
        .iter()
        .any(|line| !js_trim(line).is_empty())
    {
        return Err(error(
            "Patch contains content before its first file operation.",
        ));
    }
    Ok(headers
        .iter()
        .enumerate()
        .map(|(index, (start, path))| {
            let end = headers
                .get(index + 1)
                .map_or(lines.len() - 1, |next| next.0);
            let mut section = vec!["*** Begin Patch".to_string()];
            section.extend(lines[*start..end].iter().cloned());
            section.push("*** End Patch".into());
            (path.clone(), section.join("\n"))
        })
        .collect())
}

fn normalized_patch_lines(patch: &str, requested_path: Option<&str>) -> Outcome<Vec<String>> {
    let mut lines = patch_text_lines(patch);
    let bare = lines.first().is_some_and(|line| BARE_HEADER.is_match(line))
        && lines.last().map(String::as_str) == Some("*** End Patch");
    if bare {
        lines.insert(0, "*** Begin Patch".into());
    }
    if let Some(path) = requested_path {
        if leading_update_hunk(&lines) {
            single_line_path(path)?;
            lines.insert(1, format!("*** Update File: {path}"));
        } else if leading_add_body(&lines) {
            single_line_path(path)?;
            lines.insert(1, format!("*** Add File: {path}"));
        }
    }
    Ok(lines)
}

static BARE_HEADER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\*\*\* (?:Add|Delete|Update) File:\s*.+$").expect("pattern"));

fn enveloped(lines: &[String]) -> bool {
    lines.first().map(String::as_str) == Some("*** Begin Patch")
        && lines.last().map(String::as_str) == Some("*** End Patch")
}

fn leading_update_hunk(lines: &[String]) -> bool {
    if !enveloped(lines) {
        return false;
    }
    let first_content = lines
        .iter()
        .enumerate()
        .position(|(index, line)| index > 0 && !js_trim(line).is_empty());
    let first_header = patch_headers(lines)
        .first()
        .map_or(lines.len() - 1, |header| header.0);
    first_content
        .is_some_and(|index| index > 0 && index < first_header && lines[index].starts_with("@@"))
}

fn leading_add_body(lines: &[String]) -> bool {
    if !enveloped(lines) {
        return false;
    }
    let first_header = patch_headers(lines)
        .first()
        .map_or(lines.len() - 1, |header| header.0);
    let body = &lines[1..first_header.max(1)];
    !body.is_empty() && body.iter().all(|line| line.starts_with('+'))
}

fn single_line_path(path: &str) -> Outcome<()> {
    if path.contains(['\r', '\n']) {
        return Err(error("Patch path must be one line."));
    }
    Ok(())
}

fn parse_shape(patch: &str) -> Outcome<ParsedPatch> {
    let lines = patch_text_lines(patch);
    assert_patch_envelope(&lines)?;
    let headers: Vec<usize> = patch_headers(&lines)
        .into_iter()
        .map(|(index, _)| index)
        .collect();
    if headers.len() != 1 {
        return Err(error("Each patch operation must contain exactly one file."));
    }
    let header_index = headers[0];
    let mode = match FILE_ACTION
        .captures(&lines[header_index])
        .and_then(|captures| captures.get(1))
        .map(|action| action.as_str())
    {
        Some("Add") => "add",
        Some("Delete") => "delete",
        Some("Update") => "update",
        _ => return Err(error("Patch file operation is invalid.")),
    };
    let hunks = patch_hunks(&lines[header_index + 1..lines.len() - 1])?;
    if mode == "update"
        && !hunks
            .iter()
            .flat_map(|hunk| &hunk.lines)
            .any(|line| line.starts_with(['+', '-']))
    {
        let path = lines[header_index]
            .split_once(':')
            .map_or("", |(_, path)| js_trim(path));
        return Err(error(format!(
            "The patch for {path} has no + or - line: it would change nothing. Prefix each added line with + and each removed line with -."
        )));
    }
    Ok(ParsedPatch {
        header_index,
        hunks,
        mode,
        lines,
    })
}

fn patch_hunks(lines: &[String]) -> Outcome<Vec<Hunk>> {
    let mut hunks: Vec<Hunk> = Vec::new();
    for line in lines {
        if let Some(anchor) = line.strip_prefix("@@") {
            let anchor = js_trim(anchor);
            hunks.push(Hunk {
                anchor: (!anchor.is_empty()).then(|| anchor.to_string()),
                ..Hunk::default()
            });
        } else if line == "*** End of File" && !hunks.is_empty() {
            hunks.last_mut().expect("hunk").eof = true;
        } else {
            if hunks.is_empty() {
                hunks.push(Hunk::default());
            }
            let body = if line.is_empty() {
                " ".to_string()
            } else if line.starts_with([' ', '+', '-']) {
                line.clone()
            } else {
                return Err(error("Patch hunk lines must start with a space, +, or -."));
            };
            hunks.last_mut().expect("hunk").lines.push(body);
        }
    }
    Ok(hunks)
}

/// Lines with one of `prefixes`, without it, joined.
fn selected_lines(lines: &[String], prefixes: &[char]) -> String {
    lines
        .iter()
        .filter(|line| {
            line.chars()
                .next()
                .is_some_and(|first| prefixes.contains(&first))
        })
        .map(|line| line[1..].to_string())
        .collect::<Vec<_>>()
        .join("\n")
}

fn line_boundary(source: &str, start: usize, end: usize) -> bool {
    (start == 0 || source.as_bytes()[start - 1] == b'\n')
        && (end == source.len() || source.as_bytes()[end] == b'\n')
}

fn next_boundary(source: &str, mut offset: usize) -> usize {
    while offset < source.len() && !source.is_char_boundary(offset) {
        offset += 1;
    }
    offset
}

/// At most two line-bounded occurrences of `value` from `start`.
fn line_bounded_matches(source: &str, value: &str, start: usize) -> Vec<usize> {
    let mut matches = Vec::new();
    let mut offset = next_boundary(source, start);
    while offset <= source.len() {
        let Some(found) = source[offset..].find(value).map(|index| index + offset) else {
            break;
        };
        if line_boundary(source, found, found + value.len()) {
            matches.push(found);
        }
        if matches.len() > 1 {
            break;
        }
        offset = next_boundary(source, found + 1);
        if found + 1 > source.len() {
            break;
        }
    }
    matches
}

fn last_line_bounded_match(source: &str, value: &str, end: usize) -> Option<usize> {
    let mut cursor = end as i64 - value.len() as i64;
    while cursor >= 0 {
        let limit = (cursor as usize + value.len()).min(source.len());
        let index = source[..limit].rfind(value)?;
        if line_boundary(source, index, index + value.len()) {
            return Some(index);
        }
        cursor = index as i64 - 1;
    }
    None
}

fn line_number_at(source: &str, offset: usize) -> usize {
    source[..offset]
        .bytes()
        .filter(|byte| *byte == b'\n')
        .count()
        + 1
}

/// Rewrites each update hunk with all the lines before it, so the patch only
/// applies at the exact place the harness resolved.
fn exact_context_patch(
    source: Option<&str>,
    parsed: &ParsedPatch,
    path: &str,
) -> Outcome<ParsedPatch> {
    if parsed.mode != "update" {
        return Ok(parsed.clone());
    }
    let Some(source) = source else {
        return Err(error("Patch update target does not exist."));
    };
    let source = source.replace("\r\n", "\n");
    let mut lines: Vec<String> = parsed.lines[..=parsed.header_index].to_vec();
    let ordered = ordered_hunk_ranges(&source, &parsed.hunks, path)?;
    let repeated = single_repeated_line_range(&source, &parsed.hunks);
    let mut cursor = 0;
    for (index, hunk) in parsed.hunks.iter().enumerate() {
        let range = match (&ordered, repeated) {
            (Some(ordered), _) => ordered[index],
            (None, Some(range)) => range,
            _ => exact_hunk_range(&source, hunk, cursor, path)?,
        };
        let between = &source[cursor.min(source.len())..range.0.max(cursor.min(source.len()))];
        let mut prefix: Vec<&str> = between.split('\n').collect();
        prefix.pop();
        lines.push("@@".into());
        lines.extend(prefix.iter().map(|line| format!(" {line}")));
        lines.extend(hunk.lines.iter().cloned());
        cursor = range.1 + 1;
    }
    lines.push("*** End Patch".into());
    Ok(ParsedPatch {
        lines,
        ..parsed.clone()
    })
}

fn ordered_hunk_ranges(
    source: &str,
    hunks: &[Hunk],
    path: &str,
) -> Outcome<Option<Vec<(usize, usize)>>> {
    if hunks.len() < 2 || hunks.iter().any(|hunk| hunk.anchor.is_some() || hunk.eof) {
        return Ok(None);
    }
    let contexts: Vec<String> = hunks
        .iter()
        .map(|hunk| selected_lines(&hunk.lines, &[' ', '-']))
        .collect();
    if contexts.iter().any(String::is_empty) {
        return Err(error("Update hunks require exact context."));
    }
    let earliest = directional_ranges(source, &contexts, path, false)?;
    let latest = directional_ranges(source, &contexts, path, true)?;
    let ambiguous = earliest.iter().enumerate().position(|(index, range)| {
        range.0 != latest[index].0
            && contexts[index] != selected_lines(&hunks[index].lines, &[' ', '+'])
    });
    if let Some(index) = ambiguous {
        let matches = line_bounded_matches(source, &contexts[index], earliest[index].0);
        return Err(error(context_failure(
            path,
            source,
            &contexts[index],
            &matches,
        )));
    }
    Ok(Some(earliest))
}

fn single_repeated_line_range(source: &str, hunks: &[Hunk]) -> Option<(usize, usize)> {
    let [hunk] = hunks else { return None };
    let value = hunk.lines.first().map(|line| line[1..].to_string())?;
    if hunk.anchor.is_some()
        || hunk.eof
        || value.is_empty()
        || hunk.lines.iter().any(|line| line[1..] != *value)
    {
        return None;
    }
    let context = selected_lines(&hunk.lines, &[' ', '-']);
    if context.is_empty() {
        return None;
    }
    let matches = line_bounded_matches(source, &context, 0);
    let first = *matches.first()?;
    let range = (first, first + context.len());
    if matches.len() == 1 {
        return Some(range);
    }
    let last = last_line_bounded_match(source, &context, source.len())?;
    let span = &source[first..last + context.len()];
    span.split('\n').all(|line| line == value).then_some(range)
}

fn directional_ranges(
    source: &str,
    contexts: &[String],
    path: &str,
    reverse: bool,
) -> Outcome<Vec<(usize, usize)>> {
    let mut cursor: i64 = if reverse { source.len() as i64 } else { 0 };
    let ordered: Vec<&String> = if reverse {
        contexts.iter().rev().collect()
    } else {
        contexts.iter().collect()
    };
    let mut ranges = Vec::new();
    for context in ordered {
        let start = if reverse {
            if cursor < 0 {
                None
            } else {
                last_line_bounded_match(source, context, cursor as usize)
            }
        } else {
            line_bounded_matches(source, context, cursor as usize)
                .first()
                .copied()
        };
        let Some(start) = start else {
            return Err(error(context_failure(path, source, context, &[])));
        };
        let end = start + context.len();
        cursor = if reverse {
            start as i64 - 1
        } else {
            end as i64 + 1
        };
        ranges.push((start, end));
    }
    if reverse {
        ranges.reverse();
    }
    Ok(ranges)
}

fn exact_hunk_range(
    source: &str,
    hunk: &Hunk,
    cursor: usize,
    path: &str,
) -> Outcome<(usize, usize)> {
    let mut cursor = cursor;
    if let Some(anchor) = &hunk.anchor {
        let anchors = anchor_matches(source, anchor, cursor);
        if anchors.len() != 1 {
            return Err(error(context_failure(path, source, anchor, &anchors)));
        }
        cursor = source[anchors[0]..]
            .find('\n')
            .map_or(source.len(), |index| anchors[0] + index + 1);
    }
    let context = selected_lines(&hunk.lines, &[' ', '-']);
    if context.is_empty() {
        return Err(error("Update hunks require exact context."));
    }
    let start = if hunk.eof {
        let trimmed = source.strip_suffix('\n').unwrap_or(source).len() as i64;
        trimmed - context.len() as i64
    } else {
        cursor as i64
    };
    let from = (cursor as i64).max(start).max(0) as usize;
    let matches = line_bounded_matches(source, &context, from);
    if matches.is_empty() || (hunk.anchor.is_none() && !hunk.eof && matches.len() != 1) {
        return Err(error(context_failure(path, source, &context, &matches)));
    }
    Ok((matches[0], matches[0] + context.len()))
}

fn anchor_matches(source: &str, anchor: &str, start: usize) -> Vec<usize> {
    let mut matches = Vec::new();
    let mut cursor = 0;
    for line in source.split('\n') {
        if cursor >= start && js_trim(line) == anchor {
            matches.push(cursor);
        }
        if matches.len() > 1 {
            break;
        }
        cursor += line.len() + 1;
    }
    matches
}

fn context_failure(path: &str, source: &str, expected: &str, matches: &[usize]) -> String {
    if !matches.is_empty() {
        let lines: Vec<String> = matches
            .iter()
            .map(|offset| line_number_at(source, *offset).to_string())
            .collect();
        let mut parts = vec![format!(
            "Patch context is ambiguous in {path} at lines {}.",
            lines.join(", ")
        )];
        for (index, offset) in matches.iter().take(4).enumerate() {
            parts.push(candidate_context(
                source,
                *offset,
                index.checked_sub(1).map(|previous| matches[previous]),
            ));
        }
        parts.push(
            "Include the distinguishing context in the hunk or use a unique @@ anchor.".into(),
        );
        return parts.join("\n");
    }
    let (content, start_line, end_line) = closest_current_context(source, expected);
    [
        format!("Patch context does not match in {path}."),
        format!("Closest current lines {start_line}-{end_line}:"),
        content,
    ]
    .join("\n")
}

fn candidate_context(source: &str, offset: usize, previous: Option<usize>) -> String {
    let lines: Vec<&str> = source.split('\n').collect();
    let index = line_number_at(source, offset) - 1;
    let start = index.saturating_sub(3);
    let end = lines.len().min(index + 4);
    let content = lines[start..end].join("\n");
    let previous = previous.map_or(-1, |offset| line_number_at(source, offset) as i64 - 1);
    let mut text = format!(
        "Candidate at line {}, context {}-{end}:\n{}",
        index + 1,
        start + 1,
        utf16_prefix(&content, 1_200)
    );
    if let Some((line, anchor)) = preceding_unique_anchor(&lines, index, previous) {
        text.push_str(&format!(
            "\nUnique preceding anchor at line {line}:\n@@ {anchor}"
        ));
    }
    text
}

fn preceding_unique_anchor(lines: &[&str], index: usize, previous: i64) -> Option<(usize, String)> {
    let mut counts: Vec<(&str, usize)> = Vec::new();
    for line in lines {
        let text = js_trim(line);
        match counts.iter_mut().find(|(known, _)| *known == text) {
            Some(entry) => entry.1 += 1,
            None => counts.push((text, 1)),
        }
    }
    let mut candidate = index as i64 - 1;
    while candidate > previous {
        let text = js_trim(lines[candidate as usize]);
        if !text.is_empty()
            && utf16_len(text) <= 300
            && counts
                .iter()
                .find(|(known, _)| *known == text)
                .is_some_and(|entry| entry.1 == 1)
        {
            return Some((candidate as usize + 1, text.to_string()));
        }
        candidate -= 1;
    }
    None
}

fn closest_current_context(source: &str, expected: &str) -> (String, usize, usize) {
    let source_lines: Vec<&str> = source
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect();
    let mut expected_lines: Vec<&str> = expected
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .filter(|line| !js_trim(line).is_empty())
        .collect();
    expected_lines.sort_by_key(|line| std::cmp::Reverse(utf16_len(js_trim(line))));
    expected_lines.truncate(8);
    let mut best_index = 0;
    let mut best_score: i64 = -1;
    for (index, candidate) in source_lines.iter().enumerate() {
        let score = expected_lines
            .iter()
            .map(|line| line_similarity(candidate, line))
            .max()
            .unwrap_or(0)
            .max(0);
        if score <= best_score {
            continue;
        }
        best_index = index;
        best_score = score;
    }
    let start = best_index.saturating_sub(2);
    let end = source_lines.len().min(best_index + 3);
    (
        utf16_prefix(&source_lines[start..end].join("\n"), 2_000).to_string(),
        start + 1,
        end,
    )
}

static WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\p{L}\p{N}_$]+").expect("pattern"));

fn line_similarity(left: &str, right: &str) -> i64 {
    let candidate = utf16_prefix(js_trim(left), 500);
    let expected = utf16_prefix(js_trim(right), 500);
    if candidate.is_empty() || expected.is_empty() {
        return 0;
    }
    let containment = if utf16_len(candidate).min(utf16_len(expected)) >= 12
        && (candidate.contains(expected) || expected.contains(candidate))
    {
        1_000
    } else {
        0
    };
    let words: Vec<&str> = WORD.find_iter(expected).map(|word| word.as_str()).collect();
    let overlap = WORD
        .find_iter(candidate)
        .filter(|word| words.contains(&word.as_str()))
        .count() as i64;
    let prefix = candidate
        .encode_utf16()
        .zip(expected.encode_utf16())
        .take_while(|(left, right)| left == right)
        .count() as i64;
    containment + prefix * 4 + overlap * 20
}

/// The single-file update scoped to `source` (a symbol), as replacements of it.
pub fn plan_scoped_light_patch(source: &str, patch: &str, path: &str) -> Outcome<Vec<Replacement>> {
    let parsed = parse_shape(patch)?;
    if parsed.mode != "update" {
        return Err(error("A scoped patch requires one Update File."));
    }
    let normalized = source.replace("\r\n", "\n");
    let exact = exact_context_patch(Some(&normalized), &parsed, path)?;
    let hunks = patch_hunks(&exact.lines[exact.header_index + 1..exact.lines.len() - 1])?;
    let mut cursor = 0;
    let mut output = String::new();
    for hunk in &hunks {
        let before = selected_lines(&hunk.lines, &[' ', '-']);
        let after = selected_lines(&hunk.lines, &[' ', '+']);
        let start = normalized[next_boundary(&normalized, cursor.min(normalized.len()))..]
            .find(&before)
            .map(|index| index + cursor);
        if start != Some(cursor) {
            return Err(error("Scoped patch context does not match."));
        }
        output.push_str(&after);
        cursor += before.len();
        if normalized.as_bytes().get(cursor) == Some(&b'\n') {
            output.push('\n');
            cursor += 1;
        }
    }
    output.push_str(&normalized[cursor.min(normalized.len())..]);
    let original = source.as_bytes();
    let mut offsets: Vec<usize> = Vec::with_capacity(original.len() + 1);
    let mut index = 0;
    while index < original.len() {
        offsets.push(index);
        if original[index] == b'\r' && original.get(index + 1) == Some(&b'\n') {
            index += 1;
        }
        index += 1;
    }
    offsets.push(original.len());
    Ok(changed_ranges(&normalized, &output)
        .into_iter()
        .map(|replacement| {
            let start = offsets[replacement.start];
            let end = offsets[replacement.end];
            let line_end = original[start.min(original.len())..]
                .iter()
                .position(|byte| *byte == b'\n')
                .map(|position| position + start);
            let crlf =
                line_end.is_some_and(|line_end| line_end > 0 && original[line_end - 1] == b'\r');
            let text = if crlf {
                replacement.replacement.replace('\n', "\r\n")
            } else {
                replacement.replacement
            };
            Replacement {
                start,
                end,
                replacement: text,
            }
        })
        .collect())
}

/// A Missing target with only added lines is a new file.
fn missing_target_addition(parsed: ParsedPatch, source: Option<&str>) -> ParsedPatch {
    if source.is_some()
        || parsed.mode != "update"
        || parsed.hunks.is_empty()
        || parsed.hunks.iter().any(|hunk| {
            hunk.lines.is_empty() || hunk.lines.iter().any(|line| !line.starts_with('+'))
        })
    {
        return parsed;
    }
    ParsedPatch {
        lines: parsed
            .lines
            .iter()
            .filter(|line| !line.starts_with("@@"))
            .cloned()
            .collect(),
        mode: "add",
        ..parsed
    }
}

pub fn plan_light_patch(
    root: &str,
    path: &str,
    source: Option<&str>,
    patch: &str,
) -> Outcome<PatchPlan> {
    let parsed = missing_target_addition(parse_shape(patch)?, source);
    // Cline refuses to add over a file that exists on disk. The edit decides
    // from the planned state instead, so a file deleted earlier in the same
    // batch can be added again.
    let exact = exact_context_patch(source, &parsed, path)?;
    let mut lines = exact.lines.clone();
    let label = match exact.mode {
        "add" => "Add",
        "delete" => "Delete",
        _ => "Update",
    };
    lines[exact.header_index] = format!("*** {label} File: {path}");
    let normalized = lines.join("\n");
    // Add File content never depends on existing files: an empty root.
    let empty = std::env::temp_dir()
        .join("blame-patch-add-empty-root")
        .to_string_lossy()
        .into_owned();
    let patch_root = if exact.mode == "add" {
        empty.as_str()
    } else {
        root
    };
    let (changes, fuzz) = compute_patch_changes(&normalized, patch_root)?;
    if fuzz != 0.0 {
        return Err(error("Patch context is not exact."));
    }
    if changes.len() != 1 {
        return Err(error("Each patch operation must contain exactly one file."));
    }
    let change = &changes[0].1;
    if change.move_path.is_some() {
        return Err(error("Represent moves as add and delete operations."));
    }
    Ok(match change.kind {
        ChangeKind::Add => PatchPlan::Add(change.new_content.clone().unwrap_or_default()),
        ChangeKind::Delete => PatchPlan::Delete,
        ChangeKind::Update => {
            let Some(source) = source else {
                return Err(error("Patch update target does not exist."));
            };
            let content =
                preserve_line_endings(source, change.new_content.as_deref().unwrap_or(""));
            PatchPlan::Update(changed_ranges(source, &content))
        }
    })
}

fn preserve_line_endings(source: &str, content: &str) -> String {
    let bytes = source.as_bytes();
    let lone_newline = bytes
        .iter()
        .enumerate()
        .any(|(index, byte)| *byte == b'\n' && (index == 0 || bytes[index - 1] != b'\r'));
    if source.contains("\r\n") && !lone_newline {
        content.replace("\r\n", "\n").replace('\n', "\r\n")
    } else {
        content.to_string()
    }
}

/// The byte replacements turning `before` into `after`, line diff first.
pub fn changed_ranges(before: &str, after: &str) -> Vec<Replacement> {
    let mut replacements: Vec<Replacement> = Vec::new();
    let mut cursor = 0;
    let mut pending: Option<Replacement> = None;
    for part in diff_lines(before, after) {
        if !part.added && !part.removed {
            if let Some(replacement) = pending.take() {
                replacements.push(minimal_replacement(before, replacement));
            }
            cursor += part.value.len();
            continue;
        }
        let current = pending.get_or_insert(Replacement {
            start: cursor,
            end: cursor,
            replacement: String::new(),
        });
        if part.removed {
            cursor += part.value.len();
            current.end = cursor;
        } else {
            current.replacement.push_str(&part.value);
        }
    }
    if let Some(replacement) = pending {
        replacements.push(minimal_replacement(before, replacement));
    }
    merge_whitespace_separated(before, replacements)
}

fn minimal_replacement(source: &str, replacement: Replacement) -> Replacement {
    let Replacement {
        mut start,
        mut end,
        replacement: mut value,
    } = replacement;
    while start < end && !value.is_empty() {
        let (Some(source_character), Some(value_character)) =
            (source[start..].chars().next(), value.chars().next())
        else {
            break;
        };
        if source_character != value_character {
            break;
        }
        start += source_character.len_utf8();
        value = value[value_character.len_utf8()..].to_string();
    }
    while start < end && !value.is_empty() {
        let (Some(source_character), Some(value_character)) =
            (source[..end].chars().next_back(), value.chars().next_back())
        else {
            break;
        };
        if source_character != value_character {
            break;
        }
        end -= source_character.len_utf8();
        value.truncate(value.len() - value_character.len_utf8());
    }
    Replacement {
        start,
        end,
        replacement: value,
    }
}

fn merge_whitespace_separated(source: &str, replacements: Vec<Replacement>) -> Vec<Replacement> {
    let mut merged: Vec<Replacement> = Vec::new();
    for current in replacements {
        if let Some(previous) = merged.last_mut() {
            let gap = &source[previous.end..current.start];
            if !gap.is_empty() && gap.chars().all(is_js_space) {
                previous.end = current.end;
                previous.replacement.push_str(gap);
                previous.replacement.push_str(&current.replacement);
                continue;
            }
        }
        merged.push(current);
    }
    merged
}

/// `hasClinePatchEnvelope`.
pub fn has_cline_patch_envelope(patch: &str) -> bool {
    let trimmed = crate::text::js_trim_start(patch);
    [
        "*** Begin Patch",
        "*** Add File:",
        "*** Delete File:",
        "*** Update File:",
    ]
    .iter()
    .any(|prefix| trimmed.starts_with(prefix))
}

/// Complete raw content for a new path, as an Add File patch.
pub fn complete_new_file_patch(path: &str, content: &str) -> String {
    let mut lines = vec![
        "*** Begin Patch".to_string(),
        format!("*** Add File: {path}"),
    ];
    lines.extend(
        content
            .replace("\r\n", "\n")
            .split('\n')
            .map(|line| format!("+{line}")),
    );
    lines.push("*** End Patch".into());
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn computes_minimal_ranges() {
        assert_eq!(
            changed_ranges("a\nb\nc\n", "a\nB\nc\n"),
            [Replacement {
                start: 2,
                end: 3,
                replacement: "B".into()
            }]
        );
        assert_eq!(
            changed_ranges("x\n", "x\ny\n"),
            [Replacement {
                start: 2,
                end: 2,
                replacement: "y\n".into()
            }]
        );
    }

    #[test]
    fn splits_multi_file_patches() {
        let patch = "*** Begin Patch\n*** Update File: a.ts\n@@\n-a\n+b\n*** Add File: c.ts\n+c\n*** End Patch";
        let parts = split_light_patch(patch, None).unwrap();
        assert_eq!(parts.len(), 2);
        assert_eq!(
            parts[1],
            (
                "c.ts".to_string(),
                "*** Begin Patch\n*** Add File: c.ts\n+c\n*** End Patch".to_string()
            )
        );
    }
}
