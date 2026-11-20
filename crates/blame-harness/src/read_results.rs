//! The read_code result shapes (`light-read-results.ts`). Field order is the
//! TypeScript order: it is what the model reads.

use crate::coverage::Interval;
use crate::failure::{Failure, Outcome};
use crate::fold::{FoldPlan, RenderedFold};
use crate::json::Json;
use crate::languages::{light_capability_description, runtime_capability_registry, symbolic_path};
use crate::obj;
use crate::text::{locale_compare, split_keep_newline, split_newline_count, utf16_len};
use regex::Regex;
use std::sync::LazyLock;

pub type EditTarget = (String, String);

pub fn edit_targets_json(targets: &[EditTarget]) -> Json {
    Json::Arr(targets.iter().map(|(alias, name)| obj! { "alias" => alias.as_str(), "qualifiedName" => name.as_str() }).collect())
}

/// The files and directories directly under `path`, directories first.
pub fn directory_entries(path: &str, files: &[String]) -> Vec<(String, &'static str)> {
    let prefix = if path == "." {
        String::new()
    } else {
        format!("{path}/")
    };
    let mut entries: Vec<(String, &'static str)> = Vec::new();
    for file in files {
        let Some(rest) = file.strip_prefix(&prefix) else {
            continue;
        };
        let mut parts = rest.split('/');
        let name = parts.next().unwrap_or("");
        if name.is_empty() {
            continue;
        }
        let kind = if parts.next().is_some() {
            "directory"
        } else {
            "file"
        };
        let child = format!("{prefix}{name}");
        match entries.iter_mut().find(|(known, _)| *known == child) {
            Some(entry) => entry.1 = kind,
            None => entries.push((child, kind)),
        }
    }
    entries.sort_by(|left, right| {
        locale_compare(left.1, right.1).then_with(|| locale_compare(&left.0, &right.0))
    });
    entries
}

pub fn directory_entries_json(entries: &[(String, &'static str)]) -> Json {
    Json::Arr(
        entries
            .iter()
            .map(|(target, kind)| obj! { "kind" => *kind, "target" => target.as_str() })
            .collect(),
    )
}

pub fn covered_directory_result(path: &str, receipt: &str) -> Json {
    obj! {
        "status" => "ok",
        "data" => obj! { "status" => "already_in_context", "target" => path, "path" => path, "view" => "directory" },
        "receipt" => receipt,
    }
}

const FOLD_GUIDANCE: &str = "Folded view: every line is the file's own except the ⋯ lines, each standing for hidden lines (line range, size in characters, sN alias, imported names the hidden code uses). To see hidden code, read its sN alias or line range; range accepts up to 8 ranges in one call. Hidden lines are not observed edit coverage.";

pub fn folded_content_result(
    path: &str,
    content: &[u8],
    window: Interval,
    view: &RenderedFold,
    plan: &FoldPlan,
    receipt: &str,
    edit_targets: &[EditTarget],
) -> Json {
    let whole = window.0 == 0 && window.1 == content.len();
    let mut data = obj! { "path" => path, "view" => "folded", "complete" => false };
    if !whole {
        data.set("lines", interval_lines(content, window));
    }
    data.set(
        "folded",
        obj! {
            "shownCharacters" => utf16_len(&view.text),
            "ofCharacters" => utf16_len(&String::from_utf8_lossy(&content[window.0..window.1])),
            "hiddenParts" => view.markers.len(),
        },
    );
    if !plan.kept.is_empty() {
        let kept: Vec<Json> = plan
            .kept
            .iter()
            .take(4)
            .map(|(lines, reason)| {
                let reason = if *reason == "edited" {
                    "edited this session"
                } else {
                    "search or check hit"
                };
                Json::from(format!("L{}–{}: {reason}", lines.0 + 1, lines.1 + 1))
            })
            .collect();
        data.set("keptWhole", Json::Arr(kept));
    }
    data.set("content", view.text.as_str());
    if !edit_targets.is_empty() {
        data.set("editTargets", edit_targets_json(edit_targets));
    }
    data.set("guidance", FOLD_GUIDANCE);
    obj! { "status" => "ok", "receipt" => receipt, "data" => data }
}

#[allow(clippy::too_many_arguments)]
pub fn content_result(
    path: &str,
    content: &[u8],
    intervals: &[Interval],
    view: &str,
    receipt: &str,
    fallback_reason: Option<&str>,
    truncated: bool,
    edit_targets: &[EditTarget],
) -> Json {
    let complete = intervals.len() == 1 && intervals[0].0 == 0 && intervals[0].1 == content.len();
    let mut data = obj! { "path" => path, "view" => view, "complete" => complete };
    if let Some(reason) = fallback_reason {
        data.set("fallbackReason", reason);
    }
    if !edit_targets.is_empty() {
        data.set("editTargets", edit_targets_json(edit_targets));
    }
    let segment_text =
        |(start, end): Interval| String::from_utf8_lossy(&content[start..end]).into_owned();
    if intervals.len() == 1 {
        data.set("lines", interval_lines(content, intervals[0]));
        data.set("content", segment_text(intervals[0]));
    } else {
        let segments: Vec<Json> = intervals
            .iter()
            .map(|interval| {
                obj! {
                    "range" => Json::from(*interval),
                    "lines" => interval_lines(content, *interval),
                    "content" => segment_text(*interval),
                }
            })
            .collect();
        data.set("segments", Json::Arr(segments));
    }
    data.set("truncated", truncated);
    if truncated {
        data.extend(truncated_read_guidance(path, content, intervals));
    }
    obj! { "status" => "ok", "receipt" => receipt, "data" => data }
}

/// First and last line numbers covered by a byte interval.
pub fn interval_lines(content: &[u8], (start, end): Interval) -> Json {
    let (first, last) = interval_line_numbers(content, (start, end));
    Json::from((first, last))
}

pub fn interval_line_numbers(content: &[u8], (start, end): Interval) -> (usize, usize) {
    let newlines = |from: usize, to: usize| {
        content[from.min(content.len())..to.min(content.len())]
            .iter()
            .filter(|byte| **byte == b'\n')
            .count()
    };
    let first = newlines(0, start) + 1;
    let trailing = usize::from(end > start && content.get(end - 1) == Some(&b'\n'));
    (
        first,
        first.max((first + newlines(start, end)).saturating_sub(trailing)),
    )
}

fn truncated_read_guidance(path: &str, content: &[u8], intervals: &[Interval]) -> Json {
    let end = intervals
        .iter()
        .map(|interval| interval.1)
        .max()
        .unwrap_or(0);
    // Include the last partial line again: neither byte limits nor UTF-8 may
    // skip source. Hints do not register additional observed coverage.
    let start_line = split_newline_count(&String::from_utf8_lossy(&content[..end]));
    let total_lines = split_newline_count(&String::from_utf8_lossy(content));
    let alternative = if symbolic_path(path) {
        vec![obj! { "target" => path, "view" => "outline" }]
    } else {
        Vec::new()
    };
    obj! {
        "observedRangesUtf8Bytes" => Json::Arr(intervals.iter().map(|interval| Json::from(*interval)).collect()),
        "nextRead" => obj! {
            "target" => path,
            "view" => "range",
            "range" => obj! { "startLine" => start_line, "endLine" => total_lines.min(start_line + 79) },
        },
        "alternativeReads" => Json::Arr(alternative),
        "guidance" => "This read is truncated. Continue with nextRead (which repeats a partial boundary line), or inspect the outline and read a relevant symbol. Unseen bytes are not observed edit coverage. An explicit line range can exceed the inline byte limit for a very long line.",
    }
}

pub fn capabilities_result() -> Json {
    obj! {
        "status" => "ok",
        "data" => obj! {
            "description" => light_capability_description(),
            "languages" => Json::Arr(runtime_capability_registry().iter().map(|capability| capability.to_json()).collect()),
        },
    }
}

/// The byte range of 1-based lines `start..=end`.
pub fn line_byte_range(content: &[u8], start_line: usize, end_line: usize) -> Outcome<Interval> {
    let text = String::from_utf8_lossy(content);
    let lines = split_keep_newline(&text);
    if start_line > lines.len() {
        return Err(Failure::new("Range starts after the end of the file."));
    }
    let start: usize = lines[..start_line.saturating_sub(1)]
        .iter()
        .map(|line| line.len())
        .sum();
    let end: usize = lines[..end_line.min(lines.len())]
        .iter()
        .map(|line| line.len())
        .sum();
    Ok((start, end))
}

static IMPORT_LINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\s*(?:import(?-u:\b)|from(?-u:\b)|use(?-u:\b)|package(?-u:\b)|using(?-u:\b)|#include(?-u:\b))").expect("import line")
});

/// The import lines among the first 40, when they fit in 2,000 characters.
pub fn short_import_block(source: &str) -> Option<(String, Interval)> {
    let lines: Vec<&str> = split_keep_newline(source).into_iter().take(40).collect();
    let mut offsets = Vec::new();
    let mut total = 0;
    for line in &lines {
        total += line.len();
        offsets.push(total);
    }
    let selected: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter(|(_, line)| IMPORT_LINE.is_match(line))
        .map(|(index, _)| index)
        .collect();
    let first = *selected.first()?;
    let last = *selected.last()?;
    let start = if first == 0 { 0 } else { offsets[first - 1] };
    let end = offsets[last];
    let content = &source[start..end];
    if utf16_len(content) > 2_000 {
        return None;
    }
    Some((content.to_string(), (start, end)))
}

/// Who holds a read in context: the agent, and its context generation.
pub fn coverage_scope(context: &Json) -> (String, String) {
    let non_empty = |key: &str| {
        context
            .get(key)
            .and_then(Json::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    let consumer = non_empty("agentId")
        .or_else(|| non_empty("conversationId"))
        .or_else(|| non_empty("sessionId"))
        .unwrap_or_else(|| "lead".into());
    (consumer, context_generation(context))
}

pub fn context_generation(context: &Json) -> String {
    let metadata = context.get("metadata");
    let generation = metadata.and_then(|metadata| match metadata.get("contextGeneration") {
        Some(Json::Null) | None => metadata.get("contextEpoch"),
        found => found,
    });
    match generation {
        Some(Json::Str(value)) => return value.clone(),
        Some(number @ Json::Num(_)) => return number.stringify(),
        _ => {}
    }
    let summary = context
        .get("snapshot")
        .and_then(|snapshot| snapshot.get("messages"))
        .and_then(Json::as_array)
        .and_then(|messages| {
            messages.iter().rev().find(|message| {
                message
                    .get("metadata")
                    .and_then(|metadata| metadata.get("kind"))
                    .and_then(Json::as_str)
                    == Some("compaction_summary")
            })
        });
    match summary {
        Some(message) => format!(
            "compaction:{}",
            message
                .get("id")
                .map(json_string)
                .unwrap_or_else(|| "undefined".into())
        ),
        None => "initial".into(),
    }
}

/// `String(value)` for a JSON value.
fn json_string(value: &Json) -> String {
    match value {
        Json::Str(text) => text.clone(),
        other => other.stringify(),
    }
}

pub fn input_blocked(failure: &Failure) -> Json {
    let elapsed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let mut blocked = obj! {
        "status" => "blocked",
        "category" => "input",
        "message" => failure.message.as_str(),
        "diagnosticId" => format!("read-{}", base36(elapsed)),
    };
    if !failure.candidates.is_empty() {
        blocked.set(
            "recovery",
            Json::Arr(failure.candidates.clone()).stringify(),
        );
    }
    blocked
}

pub fn base36(mut value: u128) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".into();
    }
    let mut output = Vec::new();
    while value > 0 {
        output.push(DIGITS[(value % 36) as usize]);
        value /= 36;
    }
    output.reverse();
    String::from_utf8(output).expect("ascii digits")
}

/// Refuses binary, PDF and non-UTF-8 content.
pub fn readable_source(content: &[u8]) -> Outcome<()> {
    if content.contains(&0)
        || std::str::from_utf8(content).is_err()
        || content.starts_with(b"%PDF-")
    {
        return Err(Failure::new(
            "Binary or PDF content is not source text. Read PDF, DOCX and XLSX documents with read_attachment; for other binary files, use run_task to extract text, then read the output.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_interval_lines() {
        let content = b"a\nb\nc\n";
        assert_eq!(interval_line_numbers(content, (0, 6)), (1, 3));
        assert_eq!(interval_line_numbers(content, (2, 4)), (2, 2));
        assert_eq!(interval_line_numbers(content, (2, 2)), (2, 2));
        assert_eq!(line_byte_range(content, 2, 3).unwrap(), (2, 6));
        assert!(line_byte_range(content, 5, 6).is_err());
    }

    #[test]
    fn lists_directories_before_files() {
        let files = vec![
            "src/b.ts".to_string(),
            "src/a/x.ts".to_string(),
            "src/B.md".to_string(),
            "lib/y".to_string(),
        ];
        let entries = directory_entries("src", &files);
        assert_eq!(
            entries,
            [
                ("src/a".to_string(), "directory"),
                ("src/B.md".to_string(), "file"),
                ("src/b.ts".to_string(), "file")
            ]
        );
    }

    #[test]
    fn finds_short_import_blocks() {
        let (block, range) =
            short_import_block("// x\nimport a from \"a\";\nconst b = 1;\nimport c from \"c\";\n")
                .unwrap();
        assert_eq!(
            block,
            "import a from \"a\";\nconst b = 1;\nimport c from \"c\";\n"
        );
        assert_eq!(range, (5, 56));
        assert_eq!(base36(35), "z");
    }
}
