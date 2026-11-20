//! An earlier read that a later read repeats in part: the repeated runs of
//! lines are cut out. Ported from
//! `packages/agent-runtime/src/read-overlap-projection.ts`; lengths are
//! JavaScript's (UTF-16 code units), so the same runs qualify.

use super::json::{Json, js_length};
use std::collections::HashMap;

pub const OVERLAP_MARKER: &str = "[… exact source repeated in a later read …]\n";

/// A text this short is kept whole.
const MIN_TEXT: usize = 256;
/// A repeated run is cut only from this many lines and this many units on.
const MIN_RUN_LINES: usize = 3;
const MIN_RUN_LENGTH: usize = 256;

pub struct Projected {
    pub data: Json,
    /// What is left of this read, for the reads before it to be compared to.
    pub retained: Vec<String>,
    pub changed: bool,
}

/// `projectReadOverlap`: `data` with what `references` (later reads of the
/// same file) already show replaced by a marker.
pub fn project_read_overlap(data: &Json, references: &[String]) -> Projected {
    let mut retained = Vec::new();
    let mut project = |value: &Json| match value {
        Json::String(text) => {
            let (content, kept) = project_text(text, references);
            retained.extend(kept);
            Json::String(content)
        }
        other => other.clone(),
    };
    let mut projected = data.clone();
    for key in ["content", "signature", "body", "imports"] {
        if let Some(value) = data.get(key) {
            let value = project(value);
            projected.set(key, value);
        }
    }
    if let Some(Json::Array(segments)) = data.get("segments") {
        let segments = segments
            .iter()
            .map(|segment| match segment.get("content") {
                Some(content) if segment.is_object() => {
                    let mut segment = segment.clone();
                    segment.set("content", project(content));
                    segment
                }
                _ => segment.clone(),
            })
            .collect();
        projected.set("segments", Json::Array(segments));
    }
    let changed = projected != *data;
    Projected {
        data: projected,
        retained,
        changed,
    }
}

/// The lines of a text, each with its newline (the last one may have none).
fn lines(text: &str) -> Vec<&str> {
    text.split_inclusive('\n').collect()
}

fn project_text(source: &str, references: &[String]) -> (String, Vec<String>) {
    if js_length(source) < MIN_TEXT {
        return (source.to_owned(), vec![source.to_owned()]);
    }
    let lines = lines(source);
    let mut spans: Vec<(usize, usize)> = references
        .iter()
        .flat_map(|reference| matching_spans(&lines, reference))
        .collect();
    spans.sort_by_key(|span| span.0);
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for (start, end) in spans {
        match merged.last_mut() {
            Some(previous) if start <= previous.1 => previous.1 = previous.1.max(end),
            _ => merged.push((start, end)),
        }
    }
    let mut parts = String::new();
    let mut retained = Vec::new();
    let mut position = 0;
    for (start, end) in merged {
        let kept = lines[position..start].concat();
        parts.push_str(&kept);
        parts.push_str(OVERLAP_MARKER);
        retained.push(kept);
        position = end;
    }
    let rest = lines[position..].concat();
    parts.push_str(&rest);
    retained.push(rest);
    retained.retain(|text| !text.is_empty());
    (parts, retained)
}

/// Line position of each line that appears once; `None` for repeated ones.
fn unique_positions<'a>(lines: &[&'a str]) -> HashMap<&'a str, Option<usize>> {
    let mut positions = HashMap::new();
    for (index, line) in lines.iter().enumerate() {
        positions
            .entry(*line)
            .and_modify(|position| *position = None)
            .or_insert(Some(index));
    }
    positions
}

/// Runs of `lines` (as line ranges) that `reference` repeats, anchored on a
/// line unique to both.
fn matching_spans(lines: &[&str], reference: &str) -> Vec<(usize, usize)> {
    let other = self::lines(reference);
    let positions = unique_positions(&other);
    let source_positions = unique_positions(lines);
    let mut offsets = vec![0usize];
    for line in lines {
        offsets.push(offsets.last().unwrap() + js_length(line));
    }
    let mut spans = Vec::new();
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index];
        let (Some(Some(target)), Some(Some(own))) =
            (positions.get(line), source_positions.get(line))
        else {
            index += 1;
            continue;
        };
        if *own != index {
            index += 1;
            continue;
        }
        let (start, end) = matching_run(lines, &other, index, *target);
        if end - start >= MIN_RUN_LINES && offsets[end] - offsets[start] >= MIN_RUN_LENGTH {
            spans.push((start, end));
        }
        index = end;
    }
    spans
}

fn matching_run(source: &[&str], target: &[&str], left: usize, right: usize) -> (usize, usize) {
    let mut start = left;
    let mut end = left + 1;
    while start > 0
        && right > left - start
        && source[start - 1] == target[right - (left - start) - 1]
    {
        start -= 1;
    }
    while end < source.len() && target.get(right + end - left) == Some(&source[end]) {
        end += 1;
    }
    (start, end)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn numbered(range: std::ops::Range<usize>) -> String {
        range
            .map(|n| format!("const line{n} = {n}; // a line long enough to count\n"))
            .collect()
    }

    #[test]
    fn repeated_runs_become_a_marker() {
        let earlier = numbered(0..20);
        let later = numbered(10..30);
        let data = Json::object(vec![("content", Some(Json::str(earlier.clone())))]);
        let projected = project_read_overlap(&data, &[later]);
        assert!(projected.changed);
        assert_eq!(
            projected.data.get("content").unwrap().as_str().unwrap(),
            format!("{}{OVERLAP_MARKER}", numbered(0..10))
        );
        assert_eq!(projected.retained, [numbered(0..10)]);

        // Short texts and short runs stay.
        let short = Json::object(vec![("content", Some(Json::str("tiny\n")))]);
        assert!(!project_read_overlap(&short, &["tiny\n".into()]).changed);
        let two = numbered(10..12);
        assert!(!project_read_overlap(&data, &[two]).changed);
    }
}
