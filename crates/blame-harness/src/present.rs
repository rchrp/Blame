//! A result in the form the model reads it (`modelToolResponse` in
//! `light-tools.ts`, `encodeToolResult` in `tool-result-envelope.ts`,
//! `redactSecurityValue` in `security-secret-redaction.ts`): secrets masked,
//! hash-only fields dropped, and each text field that JSON would escape moved
//! into its own fenced part after one JSON metadata line.

use crate::json::Json;
use crate::obj;
use regex::Regex;
use std::sync::LazyLock;

const V2: &str = "blame_tool_result_v2";
/// The most lines a text keeps inline in the JSON line.
const INLINE_LINES: usize = 3;
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

/// `modelToolResponse`: the presented content, a string or an array of parts.
pub fn model_tool_response(result: &Json) -> Json {
    // `{ content, ...text }`: the field always leaves the text; only an ok
    // result's parts (images) are attached.
    let mut text = result.clone();
    let content = text.remove("content");
    let ok = result.get("status").and_then(Json::as_str) == Some("ok");
    let attachments = match content {
        Some(Json::Arr(parts)) if ok => parts,
        _ => Vec::new(),
    };
    encode_tool_result(&redact_value(&text), attachments)
}

pub fn encode_tool_result(result: &Json, attachments: Vec<Json>) -> Json {
    let mut sections: Vec<(Vec<Json>, String)> = Vec::new();
    let metadata = detach(&without_hashes(result), &mut Vec::new(), &mut sections);
    if sections.is_empty() && attachments.is_empty() {
        return Json::Str(metadata.stringify());
    }
    let header = obj! {
        "format" => V2,
        "result" => metadata,
        "sections" => Json::Arr(sections.iter().map(|(path, _)| Json::Arr(path.clone())).collect()),
    };
    let mut parts = vec![obj! { "type" => "text", "text" => header.stringify() }];
    for (path, text) in &sections {
        parts.push(obj! { "type" => "text", "text" => text_section(&field_label(path), text) });
    }
    parts.extend(attachments);
    Json::Arr(parts)
}

static HASH_VALUE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:src_[0-9a-f]{32}|validation://[0-9a-f]{64}|(?:sha256:)?[0-9a-f]{64})$")
        .expect("hash pattern")
});

fn without_hashes(value: &Json) -> Json {
    match value {
        Json::Arr(values) => Json::Arr(values.iter().map(without_hashes).collect()),
        Json::Obj(entries) => Json::Obj(
            entries
                .iter()
                .filter(|(name, item)| {
                    !name.to_lowercase().ends_with("sha256")
                        && !item.as_str().is_some_and(|text| HASH_VALUE.is_match(text))
                })
                .map(|(name, item)| (name.clone(), without_hashes(item)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn detach(value: &Json, path: &mut Vec<Json>, sections: &mut Vec<(Vec<Json>, String)>) -> Json {
    match value {
        Json::Arr(values) => Json::Arr(
            values
                .iter()
                .enumerate()
                .map(|(index, item)| {
                    path.push(Json::from(index));
                    let detached = detach(item, path, sections);
                    path.pop();
                    detached
                })
                .collect(),
        ),
        Json::Obj(entries) => Json::Obj(
            entries
                .iter()
                .map(|(key, item)| {
                    path.push(Json::from(key.as_str()));
                    let detached = match item {
                        Json::Str(text)
                            if TEXT_KEYS.contains(&key.as_str())
                                && worth_detaching(text, &field_label(path)) =>
                        {
                            sections.push((path.clone(), text.clone()));
                            Json::from(format!("[see {}]", field_label(path)))
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
/// A text gets its own fenced part when it spans more than
/// `INLINE_LINES` lines, or when JSON would escape it more than the part
/// costs (its label twice, its path in the header, the fences). A short
/// message or snippet stays inline: its section cost more than the escapes
/// it saved, and named its label three times (US-110, 2026-11-26).
fn worth_detaching(text: &str, label: &str) -> bool {
    text.split(['\n', '\r'])
        .filter(|line| !line.is_empty())
        .count()
        > INLINE_LINES
        || text
            .chars()
            .filter(|character| matches!(character, '"' | '\\') || (*character as u32) < 0x20)
            .count()
            > 3 * label.len() + 24
}

/// `data.segments[0].content`, as the model reads it.
fn field_label(path: &[Json]) -> String {
    let mut label = String::new();
    for (index, key) in path.iter().enumerate() {
        match key {
            Json::Num(number) => label.push_str(&format!("[{}]", *number as usize)),
            Json::Str(name) if index > 0 => {
                label.push('.');
                label.push_str(name);
            }
            Json::Str(name) => label.push_str(name),
            _ => {}
        }
    }
    label
}

/// The label, then the text in a fence longer than any backtick run inside it.
fn text_section(label: &str, text: &str) -> String {
    let mut longest = 0;
    let mut run = 0;
    for character in text.chars() {
        if character == '`' {
            run += 1;
            longest = longest.max(run);
        } else {
            run = 0;
        }
    }
    let fence = "`".repeat(3.max(longest + 1));
    format!("{label}:\n{fence}\n{text}\n{fence}")
}

// ---- Secret redaction -------------------------------------------------------

struct Signal {
    start: usize,
    end: usize,
    kind: String,
}

static KNOWN_SECRETS: LazyLock<Vec<(&'static str, Regex)>> = LazyLock::new(|| {
    [
        ("AWS_ACCESS_KEY", r"(?-u:\b)(?:AKIA|ASIA)[A-Z0-9]{16}(?-u:\b)"),
        ("GITHUB_TOKEN", r"(?-u:\b)gh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}(?-u:\b)"),
        ("GITHUB_TOKEN", r"(?-u:\b)github_pat_[A-Za-z0-9_]{22,}(?-u:\b)"),
        ("GITLAB_TOKEN", r"(?-u:\b)glpat-[A-Za-z0-9_-]{20,}(?-u:\b)"),
        ("OPENAI_API_KEY", r"(?-u:\b)sk-(?:proj-)?[A-Za-z0-9_-]{20,}(?-u:\b)"),
        ("SLACK_TOKEN", r"(?-u:\b)xox(?:b|p|a|r|s)-[A-Za-z0-9-]{16,}(?-u:\b)"),
        ("STRIPE_SECRET_KEY", r"(?-u:\b)sk_live_[A-Za-z0-9]{16,}(?-u:\b)"),
        (
            "PRIVATE_KEY",
            r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
        ),
    ]
    .into_iter()
    .map(|(kind, pattern)| (kind, Regex::new(pattern).expect("secret pattern")))
    .collect()
});

// `(["'`])([^\n"'`]{8,})\2` without a back-reference: the value excludes
// every quote, so the closing quote is the first one after it.
static CREDENTIAL_ASSIGNMENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?i)(?-u:\b)(api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|private[_-]?key|secret|token)(?-u:\b)\s*[:=]\s*(?:"([^\n"'`]{8,})"|'([^\n"'`]{8,})'|`([^\n"'`]{8,})`)"#,
    )
    .expect("assignment pattern")
});

static GITHUB_TOKEN_ASSIGNMENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?-u:\b)(GH_TOKEN|GITHUB_TOKEN)(?-u:\b)["']?\s*[:=]\s*["'`]?([^\s"'`,;}]+)"#)
        .expect("token pattern")
});

static TEMPLATED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\$\{|process\.env|import\.meta\.env|<[^>]+>").expect("pattern"));
static PLACEHOLDER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:change-?me|development|example|password|sample|secret|test|token|your[_-].*)$")
        .expect("pattern")
});

fn likely_credential(value: &str) -> bool {
    let normalized = crate::text::js_trim(value).to_lowercase();
    if normalized.is_empty() || normalized.chars().any(crate::text::is_js_space) {
        return false;
    }
    if TEMPLATED.is_match(&normalized) {
        return false;
    }
    !PLACEHOLDER.is_match(&normalized)
}

fn detect_secrets(content: &str) -> Vec<Signal> {
    let mut signals = Vec::new();
    for (kind, pattern) in KNOWN_SECRETS.iter() {
        for found in pattern.find_iter(content) {
            signals.push(Signal {
                start: found.start(),
                end: found.end(),
                kind: (*kind).to_string(),
            });
        }
    }
    for captures in CREDENTIAL_ASSIGNMENT.captures_iter(content) {
        let whole = captures.get(0).expect("match");
        let Some(value) = captures
            .get(2)
            .or_else(|| captures.get(3))
            .or_else(|| captures.get(4))
        else {
            continue;
        };
        if !likely_credential(value.as_str()) {
            continue;
        }
        let kind = captures
            .get(1)
            .map_or("SECRET", |name| name.as_str())
            .replace('-', "_")
            .to_uppercase();
        signals.push(assigned_value(
            whole.start(),
            whole.as_str(),
            value.as_str(),
            kind,
        ));
    }
    for captures in GITHUB_TOKEN_ASSIGNMENT.captures_iter(content) {
        let whole = captures.get(0).expect("match");
        let value = captures.get(2).map_or("", |value| value.as_str());
        if value.starts_with('$') || !likely_credential(value) {
            continue;
        }
        let kind = captures
            .get(1)
            .map_or("GH_TOKEN", |name| name.as_str())
            .to_string();
        signals.push(assigned_value(whole.start(), whole.as_str(), value, kind));
    }
    non_overlapping(signals)
}

fn assigned_value(index: usize, whole: &str, value: &str, kind: String) -> Signal {
    let start = index + whole.rfind(value).unwrap_or(0);
    Signal {
        start,
        end: start + value.len(),
        kind,
    }
}

fn non_overlapping(mut signals: Vec<Signal>) -> Vec<Signal> {
    signals.sort_by(|left, right| left.start.cmp(&right.start).then(right.end.cmp(&left.end)));
    let mut selected: Vec<Signal> = Vec::new();
    for signal in signals {
        if selected.iter().any(|item| signal.start < item.end) {
            continue;
        }
        selected.push(signal);
    }
    selected
}

pub fn redact_secrets(content: &str) -> String {
    let mut redacted = content.to_string();
    for signal in detect_secrets(content).into_iter().rev() {
        redacted.replace_range(
            signal.start..signal.end,
            &format!("<REDACTED_SECRET:{}>", signal.kind),
        );
    }
    redacted
}

pub fn redact_value(value: &Json) -> Json {
    match value {
        Json::Str(text) => Json::Str(redact_secrets(text)),
        Json::Arr(values) => Json::Arr(values.iter().map(redact_value).collect()),
        Json::Obj(entries) => {
            // Images and binary resources carry base64 data, not text.
            let kind = value.get("type").and_then(Json::as_str);
            let binary = (matches!(kind, Some("image" | "audio"))
                && value.get("data").and_then(Json::as_str).is_some())
                || value.get("blob").and_then(Json::as_str).is_some();
            if binary {
                return value.clone();
            }
            Json::Obj(
                entries
                    .iter()
                    .map(|(key, item)| {
                        let masked = match item {
                            Json::Str(text)
                                if (key == "GH_TOKEN" || key == "GITHUB_TOKEN")
                                    && !text.is_empty() =>
                            {
                                Json::from(format!("<REDACTED_SECRET:{key}>"))
                            }
                            _ => redact_value(item),
                        };
                        (key.clone(), masked)
                    })
                    .collect(),
            )
        }
        other => other.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_known_secrets_and_assignments() {
        assert_eq!(
            redact_secrets("key AKIAABCDEFGHIJKLMNOP end"),
            "key <REDACTED_SECRET:AWS_ACCESS_KEY> end"
        );
        assert_eq!(
            redact_secrets("password = \"hunter2hunter2\""),
            "password = \"<REDACTED_SECRET:PASSWORD>\""
        );
        assert_eq!(
            redact_secrets("password = \"example\""),
            "password = \"example\""
        );
        assert_eq!(
            redact_secrets("GH_TOKEN=abcdef123456"),
            "GH_TOKEN=<REDACTED_SECRET:GH_TOKEN>"
        );
    }

    #[test]
    fn detaches_escaped_text_fields() {
        let result = obj! { "status" => "ok", "data" => obj! { "content" => "a\nb\nc\nd", "hash" => "src_0123456789abcdef0123456789abcdef" } };
        let encoded = encode_tool_result(&result, Vec::new());
        let parts = encoded.as_array().expect("parts");
        assert_eq!(
            parts[0].get("text").and_then(Json::as_str),
            Some(
                r#"{"format":"blame_tool_result_v2","result":{"status":"ok","data":{"content":"[see data.content]"}},"sections":[["data","content"]]}"#
            )
        );
        assert_eq!(
            parts[1].get("text").and_then(Json::as_str),
            Some("data.content:\n```\na\nb\nc\nd\n```")
        );
        let short = obj! { "status" => "blocked", "message" => "Command exited with code 1.\nerror: no such file" };
        assert_eq!(
            encode_tool_result(&short, Vec::new()).as_str(),
            Some(
                r#"{"status":"blocked","message":"Command exited with code 1.\nerror: no such file"}"#
            )
        );
    }

    #[test]
    fn one_line_texts_stay_inline_unless_escapes_cost_more() {
        let snippet = obj! { "status" => "ok", "data" => obj! { "snippet" => "let a = \"b\";" } };
        assert_eq!(
            encode_tool_result(&snippet, Vec::new()).as_str(),
            Some(r#"{"status":"ok","data":{"snippet":"let a = \"b\";"}}"#)
        );
        let quoted = "\"x\",".repeat(40);
        let output = obj! { "status" => "ok", "data" => obj! { "output" => quoted.as_str() } };
        let encoded = encode_tool_result(&output, Vec::new());
        let parts = encoded.as_array().expect("parts");
        assert_eq!(
            parts[1].get("text").and_then(Json::as_str),
            Some(format!("data.output:\n```\n{quoted}\n```").as_str())
        );
    }
}
