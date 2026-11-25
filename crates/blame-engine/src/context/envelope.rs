//! The form a harness result takes for the model, ported from
//! `packages/agent-runtime/src/tool-result-envelope.ts`.
//!
//! A result is one JSON object, or, when a text field would need JSON
//! escapes (source, output) or the result has images, a v2 multipart: a JSON
//! header naming the detached fields, each field fenced in its own text part,
//! then the images. The runner stores exactly this; the rules decode it,
//! change the object, and encode it again the same way.

use super::json::Json;
use blame_engine_protocol::ToolResultBlock;

const V2: &str = "blame_tool_result_v2";

/// Fields the model reads in a fence rather than as an escaped JSON string.
const TEXT_KEYS: [&str; 9] = [
    "content",
    "body",
    "context",
    "diagnostic",
    "imports",
    "signature",
    "snippet",
    "output",
    "message",
];
const UNSAFE_KEYS: [&str; 3] = ["__proto__", "constructor", "prototype"];

#[derive(Clone, Debug, PartialEq)]
enum Key {
    Name(String),
    Index(usize),
}

/// A stored harness result, decoded.
#[derive(Clone, Debug, PartialEq)]
pub struct Decoded {
    pub result: Json,
    /// How many of the stored blocks are text (the header and the fenced
    /// fields, or the single JSON text); the images follow them.
    pub text_blocks: usize,
}

/// `JSON.parse` of a single text, or `unwrapFeedbackEnvelope` of a v2
/// multipart. Results of earlier runners (v1) never reach the engine.
pub fn decode(blocks: &[ToolResultBlock]) -> Option<Decoded> {
    let texts: Vec<&str> = blocks
        .iter()
        .map_while(|block| match block {
            ToolResultBlock::Text { text } => Some(text.as_str()),
            ToolResultBlock::Image { .. } => None,
        })
        .collect();
    // Text after an image is no shape the runner writes.
    if blocks[texts.len()..]
        .iter()
        .any(|block| matches!(block, ToolResultBlock::Text { .. }))
    {
        return None;
    }
    let first = Json::parse(texts.first()?)?;
    if blocks.len() == 1 {
        return first.is_object().then_some(Decoded {
            result: first,
            text_blocks: 1,
        });
    }
    if first.get("format").and_then(Json::as_str) != Some(V2) {
        return None;
    }
    let mut result = first.get("result").filter(|r| r.is_object())?.clone();
    let sections = first.get("sections")?.as_array()?;
    if sections.len() + 1 != texts.len() {
        return None;
    }
    for (path, part) in sections.iter().zip(&texts[1..]) {
        let path = valid_path(path)?;
        let label = field_label(&path);
        let text = section_text(&label, part)?;
        if !assign(&mut result, &path, &reference(&label), text) {
            return None;
        }
    }
    Some(Decoded {
        result,
        text_blocks: texts.len(),
    })
}

/// `encodeToolResult`: the text parts of `result` as the model reads it.
/// With `images`, a header is written even when no field is detached, since
/// the images must follow it.
pub fn encode(result: &Json, images: bool) -> Vec<String> {
    let mut sections = Vec::new();
    let metadata = detach(&without_hashes(result), &mut Vec::new(), &mut sections);
    if sections.is_empty() && !images {
        return vec![metadata.to_text()];
    }
    let header = Json::object(vec![
        ("format", Some(Json::str(V2))),
        ("result", Some(metadata)),
        (
            "sections",
            Some(Json::Array(
                sections.iter().map(|(path, _)| path_json(path)).collect(),
            )),
        ),
    ]);
    std::iter::once(header.to_text())
        .chain(
            sections
                .iter()
                .map(|(path, text)| text_section(&field_label(path), text)),
        )
        .collect()
}

/// Revision and check identities, and digests: bookkeeping the model never
/// sends back.
fn is_hash(text: &str) -> bool {
    let hex = |s: &str, n: usize| {
        s.len() == n && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    };
    text.strip_prefix("src_").is_some_and(|rest| hex(rest, 32))
        || text
            .strip_prefix("validation://")
            .is_some_and(|rest| hex(rest, 64))
        || hex(text.strip_prefix("sha256:").unwrap_or(text), 64)
}

fn without_hashes(value: &Json) -> Json {
    match value {
        Json::Array(items) => Json::Array(items.iter().map(without_hashes).collect()),
        Json::Object(entries) => Json::Object(
            entries
                .iter()
                .filter(|(name, item)| {
                    !name.to_ascii_lowercase().ends_with("sha256")
                        && !item.as_str().is_some_and(is_hash)
                })
                .map(|(name, item)| (name.clone(), without_hashes(item)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn detach(value: &Json, path: &mut Vec<Key>, sections: &mut Vec<(Vec<Key>, String)>) -> Json {
    match value {
        Json::Array(items) => Json::Array(
            items
                .iter()
                .enumerate()
                .map(|(index, item)| {
                    path.push(Key::Index(index));
                    let detached = detach(item, path, sections);
                    path.pop();
                    detached
                })
                .collect(),
        ),
        Json::Object(entries) => Json::Object(
            entries
                .iter()
                .map(|(key, item)| {
                    path.push(Key::Name(key.clone()));
                    let detached = match item {
                        Json::String(text)
                            if TEXT_KEYS.contains(&key.as_str())
                                && worth_detaching(text, &field_label(path)) =>
                        {
                            sections.push((path.clone(), text.clone()));
                            Json::str(reference(&field_label(path)))
                        }
                        _ => detach(item, path, sections),
                    };
                    path.pop();
                    (key.clone(), detached)
                })
                .collect(),
        ),
        other => other.clone(),
    }
}

/// A text gets its own fenced part when it spans lines, or when JSON would
/// escape it more than the part costs (its label twice, its path in the
/// header, the fences): the harness's rule (`present.rs`).
fn worth_detaching(text: &str, label: &str) -> bool {
    text.contains(['\n', '\r'])
        || text
            .chars()
            .filter(|c| matches!(c, '"' | '\\') || (*c as u32) < 0x20)
            .count()
            > 3 * label.len() + 24
}

fn path_json(path: &[Key]) -> Json {
    Json::Array(
        path.iter()
            .map(|key| match key {
                Key::Name(name) => Json::str(name.clone()),
                Key::Index(index) => Json::Number(index.to_string()),
            })
            .collect(),
    )
}

/// `data.segments[0].content`, as the model reads it.
fn field_label(path: &[Key]) -> String {
    let mut label = String::new();
    for (index, key) in path.iter().enumerate() {
        match key {
            Key::Index(i) => label.push_str(&format!("[{i}]")),
            Key::Name(name) if index > 0 => {
                label.push('.');
                label.push_str(name);
            }
            Key::Name(name) => label.push_str(name),
        }
    }
    label
}

fn reference(label: &str) -> String {
    format!("[see {label}]")
}

/// The label, then the text in a fence longer than any backtick run in it.
fn text_section(label: &str, text: &str) -> String {
    let mut longest = 0;
    let mut run = 0;
    for c in text.chars() {
        run = if c == '`' { run + 1 } else { 0 };
        longest = longest.max(run);
    }
    let fence = "`".repeat(3.max(longest + 1));
    format!("{label}:\n{fence}\n{text}\n{fence}")
}

fn section_text<'a>(label: &str, part: &'a str) -> Option<&'a str> {
    let rest = part.strip_prefix(label)?.strip_prefix(":\n")?;
    let ticks = rest.bytes().take_while(|b| *b == b'`').count();
    if ticks < 3 || rest.as_bytes().get(ticks) != Some(&b'\n') {
        return None;
    }
    let fence = &rest[..ticks];
    let body = &rest[ticks + 1..];
    // The fence and its newline closing the part, unless the body is empty
    // and the opening newline is shared.
    let end = body.len().checked_sub(ticks + 1)?;
    if !part.ends_with(&format!("\n{fence}")) {
        return None;
    }
    Some(&body[..end])
}

fn valid_path(path: &Json) -> Option<Vec<Key>> {
    let items = path.as_array()?;
    if items.is_empty() || items.len() > 20 {
        return None;
    }
    items
        .iter()
        .map(|item| match item {
            Json::String(name) if !UNSAFE_KEYS.contains(&name.as_str()) => {
                Some(Key::Name(name.clone()))
            }
            Json::Number(text) => text.parse::<usize>().ok().map(Key::Index),
            _ => None,
        })
        .collect()
}

/// Puts `text` where the placeholder is; false when the shape differs.
fn assign(result: &mut Json, path: &[Key], placeholder: &str, text: &str) -> bool {
    let Some((last, parents)) = path.split_last() else {
        return false;
    };
    let mut target = result;
    for key in parents {
        match child(target, key) {
            Some(next) if matches!(next, Json::Object(_) | Json::Array(_)) => target = next,
            _ => return false,
        }
    }
    match child(target, last) {
        Some(slot) if slot.as_str() == Some(placeholder) => {
            *slot = Json::str(text);
            true
        }
        _ => false,
    }
}

fn child<'a>(target: &'a mut Json, key: &Key) -> Option<&'a mut Json> {
    match (target, key) {
        (Json::Array(items), Key::Index(index)) => items.get_mut(*index),
        (Json::Array(items), Key::Name(name)) if name.bytes().all(|b| b.is_ascii_digit()) => {
            items.get_mut(name.parse::<usize>().ok()?)
        }
        (Json::Object(entries), Key::Name(name)) => {
            entries.iter_mut().find(|(k, _)| k == name).map(|(_, v)| v)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(text: &str) -> ToolResultBlock {
        ToolResultBlock::Text { text: text.into() }
    }

    #[test]
    fn a_result_with_source_is_fenced_and_decodes_back() {
        let result = Json::parse(
            r#"{"status":"ok","data":{"path":"a.ts","content":"line \"one\"\n```\n","sha256":"x","revision":"src_0123456789abcdef0123456789abcdef"}}"#,
        )
        .unwrap();
        let parts = encode(&result, false);
        assert_eq!(
            parts,
            [
                r#"{"format":"blame_tool_result_v2","result":{"status":"ok","data":{"path":"a.ts","content":"[see data.content]"}},"sections":[["data","content"]]}"#,
                "data.content:\n````\nline \"one\"\n```\n\n````",
            ]
        );
        let blocks: Vec<_> = parts.iter().map(|p| text(p)).collect();
        let decoded = decode(&blocks).unwrap();
        assert_eq!(decoded.text_blocks, 2);
        assert_eq!(
            decoded.result.to_text(),
            r#"{"status":"ok","data":{"path":"a.ts","content":"line \"one\"\n```\n"}}"#
        );
        // Encoding what was decoded gives the stored parts again.
        assert_eq!(encode(&decoded.result, false), parts);
    }

    #[test]
    fn plain_results_and_empty_sections_decode() {
        let plain = decode(&[text(r#"{"status":"ok"}"#)]).unwrap();
        assert_eq!(plain.result.to_text(), r#"{"status":"ok"}"#);
        assert_eq!(encode(&plain.result, false), [r#"{"status":"ok"}"#]);
        assert_eq!(
            encode(&plain.result, true),
            [r#"{"format":"blame_tool_result_v2","result":{"status":"ok"},"sections":[]}"#]
        );
        let empty = Json::parse(r#"{"status":"ok","output":"\n"}"#).unwrap();
        let blocks: Vec<_> = encode(&empty, false).iter().map(|p| text(p)).collect();
        assert_eq!(decode(&blocks).unwrap().result, empty);
        assert_eq!(decode(&[text("Done: all done")]), None);
        assert_eq!(decode(&[text("[1]")]), None);
    }

    #[test]
    fn a_one_line_snippet_with_quotes_stays_inline() {
        let result = Json::parse(r#"{"status":"ok","data":{"snippet":"let a = \"b\";"}}"#).unwrap();
        assert_eq!(encode(&result, false), [result.to_text()]);
    }
}
