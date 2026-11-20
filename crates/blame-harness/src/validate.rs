//! Input validation with zod 4.6's semantics and messages, for the schemas
//! of the ported tools (`light-contracts.ts`), plus the lenient repair of
//! JSON sent as strings (`parseLeniently` in `light-tools.ts`).
//!
//! What zod does and this reproduces: values come out in schema key order,
//! strings are trimmed before their length checks, an object reports its
//! properties' issues before unknown keys, and a union whose options all
//! fail reports the one option that failed only on non-aborting checks, or
//! else "Invalid input".

use crate::json::{Json, quote};
use crate::text::utf16_len;

/// A refinement and the message it reports.
pub type Refinement = (fn(&Json) -> bool, &'static str);

pub enum Schema {
    Str {
        min: usize,
        max: usize,
    },
    Int {
        min: Option<(i64, bool)>,
        max: Option<i64>,
    },
    Bool,
    Enum(&'static [&'static str]),
    Object {
        fields: Vec<(&'static str, Schema, bool)>,
        /// A refinement and its message (zod's default is "Invalid input").
        refine: Option<Refinement>,
    },
    Array {
        item: Box<Schema>,
        min: Option<usize>,
        max: usize,
    },
    Union(Vec<Schema>),
    Literal(&'static str),
    /// An untrimmed string of at most `max` characters (edit content).
    Text {
        max: usize,
    },
    /// An untrimmed string with a minimum length (a patch).
    TextMin {
        min: usize,
        max: usize,
    },
    /// `z.string().regex(pattern)`, untrimmed; `display` is the pattern as
    /// JavaScript prints the RegExp.
    Pattern {
        pattern: &'static str,
        display: &'static str,
    },
    /// `.optional().default(value)`: an absent value becomes the default.
    Defaulted(Box<Schema>, &'static str),
    /// An untrimmed argv word: `z.string().min(1).max(max).refine(no NUL)`.
    Argument {
        max: usize,
    },
    /// `z.record(z.string().regex(key), value)` with a refinement on the whole record.
    Record {
        key: &'static str,
        value: Box<Schema>,
        refine: Option<Refinement>,
    },
    /// `z.discriminatedUnion(key, options)`, each option keyed by its literal.
    Discriminated {
        key: &'static str,
        options: Vec<(&'static str, Schema)>,
    },
}

#[derive(Clone, Debug)]
pub struct Issue {
    pub path: Vec<Json>,
    pub message: String,
    /// zod's `continue`: `Some(true)` for checks, `Some(false)` for explicit aborts.
    pub proceed: Option<bool>,
    /// The type a repairable `invalid_type` (or union) expected.
    pub expected: Option<&'static str>,
}

impl Issue {
    fn new(message: String, proceed: Option<bool>) -> Issue {
        Issue {
            path: Vec::new(),
            message,
            proceed,
            expected: None,
        }
    }
}

fn parsed_type(value: Option<&Json>) -> &'static str {
    match value {
        None => "undefined",
        Some(Json::Null) => "null",
        Some(Json::Bool(_)) => "boolean",
        Some(Json::Num(number)) if number.is_nan() => "nan",
        Some(Json::Num(_)) => "number",
        Some(Json::Str(_)) => "string",
        Some(Json::Arr(_)) => "array",
        Some(Json::Obj(_)) => "object",
    }
}

fn invalid_type(expected: &'static str, value: Option<&Json>, proceed: Option<bool>) -> Issue {
    Issue {
        expected: Some(expected),
        ..Issue::new(
            format!(
                "Invalid input: expected {expected}, received {}",
                parsed_type(value)
            ),
            proceed,
        )
    }
}

fn aborted(issues: &[Issue]) -> bool {
    issues.iter().any(|issue| issue.proceed != Some(true))
}

fn explicitly_aborted(issues: &[Issue]) -> bool {
    issues.iter().any(|issue| issue.proceed == Some(false))
}

/// The length zod's length checks see, when the value has one.
fn length_of(value: Option<&Json>, maximum: Option<usize>) -> Option<usize> {
    match value {
        Some(Json::Str(text)) => {
            let units = utf16_len(text);
            // Strings over a maximum are measured in code points.
            Some(if maximum.is_some_and(|maximum| units > maximum) {
                text.chars().count()
            } else {
                units
            })
        }
        Some(Json::Arr(values)) => Some(values.len()),
        _ => None,
    }
}

fn origin(value: Option<&Json>) -> (&'static str, &'static str) {
    match value {
        Some(Json::Arr(_)) => ("array", "items"),
        _ => ("string", "characters"),
    }
}

impl Schema {
    fn untrimmed(value: Option<&Json>, min: usize, max: usize) -> (Option<Json>, Vec<Issue>) {
        let mut issues = Vec::new();
        if !matches!(value, Some(Json::Str(_))) {
            issues.push(invalid_type("string", value, None));
        }
        if !explicitly_aborted(&issues) {
            if length_of(value, None).is_some_and(|length| length < min) {
                let (kind, unit) = origin(value);
                issues.push(Issue::new(
                    format!("Too small: expected {kind} to have >={min} {unit}"),
                    Some(true),
                ));
            }
            if length_of(value, Some(max)).is_some_and(|length| length > max) {
                let (kind, unit) = origin(value);
                issues.push(Issue::new(
                    format!("Too big: expected {kind} to have <={max} {unit}"),
                    Some(true),
                ));
            }
        }
        (value.cloned(), issues)
    }

    /// Parses `value` (`None` when absent), returning zod's output and issues.
    pub fn run(&self, value: Option<&Json>) -> (Option<Json>, Vec<Issue>) {
        match self {
            Schema::Str { min, max } => {
                let mut issues = Vec::new();
                let mut output = value.cloned();
                match value {
                    Some(Json::Str(text)) => {
                        output = Some(Json::Str(crate::text::js_trim(text).to_string()))
                    }
                    other => issues.push(invalid_type("string", other, None)),
                }
                // Length checks run on anything with a length, unless explicitly aborted.
                if !explicitly_aborted(&issues) {
                    let checked = output.as_ref();
                    if let Some(length) = length_of(checked, None)
                        && length < *min
                    {
                        let (kind, unit) = origin(checked);
                        issues.push(Issue::new(
                            format!("Too small: expected {kind} to have >={min} {unit}"),
                            Some(true),
                        ));
                    }
                    if let Some(length) = length_of(checked, Some(*max))
                        && length > *max
                    {
                        let (kind, unit) = origin(checked);
                        issues.push(Issue::new(
                            format!("Too big: expected {kind} to have <={max} {unit}"),
                            Some(true),
                        ));
                    }
                }
                (output, issues)
            }
            Schema::Int { min, max } => {
                let Some(Json::Num(number)) =
                    value.filter(|value| matches!(value, Json::Num(number) if number.is_finite()))
                else {
                    return (value.cloned(), vec![invalid_type("number", value, None)]);
                };
                if number.fract() != 0.0 {
                    return (
                        value.cloned(),
                        vec![invalid_type("int", value, Some(false))],
                    );
                }
                let mut issues = Vec::new();
                if let Some((minimum, inclusive)) = min {
                    let fails = if *inclusive {
                        *number < *minimum as f64
                    } else {
                        *number <= *minimum as f64
                    };
                    if fails {
                        let relation = if *inclusive { ">=" } else { ">" };
                        issues.push(Issue::new(
                            format!("Too small: expected number to be {relation}{minimum}"),
                            Some(true),
                        ));
                    }
                }
                if let Some(maximum) = max
                    && *number > *maximum as f64
                {
                    issues.push(Issue::new(
                        format!("Too big: expected number to be <={maximum}"),
                        Some(true),
                    ));
                }
                (value.cloned(), issues)
            }
            Schema::Bool => match value {
                Some(Json::Bool(_)) => (value.cloned(), Vec::new()),
                other => (value.cloned(), vec![invalid_type("boolean", other, None)]),
            },
            Schema::Enum(values) => match value {
                Some(Json::Str(text)) if values.contains(&text.as_str()) => {
                    (value.cloned(), Vec::new())
                }
                _ => {
                    let options = values
                        .iter()
                        .map(|option| quote(option))
                        .collect::<Vec<_>>()
                        .join("|");
                    (
                        value.cloned(),
                        vec![Issue::new(
                            format!("Invalid option: expected one of {options}"),
                            None,
                        )],
                    )
                }
            },
            Schema::Object { fields, refine } => {
                let Some(Json::Obj(entries)) = value else {
                    return (value.cloned(), vec![invalid_type("object", value, None)]);
                };
                let mut issues = Vec::new();
                let mut output = Json::obj();
                for (name, schema, optional) in fields {
                    let field = entries
                        .iter()
                        .find(|(key, _)| key == name)
                        .map(|(_, value)| value);
                    if field.is_none() && *optional {
                        continue;
                    }
                    let (parsed, field_issues) = schema.run(field);
                    issues.extend(field_issues.into_iter().map(|mut issue| {
                        issue.path.insert(0, Json::from(*name));
                        issue
                    }));
                    if let Some(parsed) = parsed {
                        output.set(name, parsed);
                    }
                }
                let unknown: Vec<String> = entries
                    .iter()
                    .filter(|(key, _)| !fields.iter().any(|(name, _, _)| name == key))
                    .map(|(key, _)| quote(key))
                    .collect();
                if !unknown.is_empty() {
                    let plural = if unknown.len() > 1 { "s" } else { "" };
                    issues.push(Issue::new(
                        format!("Unrecognized key{plural}: {}", unknown.join(", ")),
                        Some(true),
                    ));
                }
                if let Some((refine, message)) = refine
                    && !aborted(&issues)
                    && !refine(&output)
                {
                    issues.push(Issue::new((*message).into(), Some(true)));
                }
                (Some(output), issues)
            }
            Schema::Array { item, min, max } => {
                let Some(Json::Arr(values)) = value else {
                    return (value.cloned(), vec![invalid_type("array", value, None)]);
                };
                // zod 4.6 refuses an over-long array before parsing its items.
                if values.len() > *max {
                    return (
                        value.cloned(),
                        vec![Issue::new(
                            format!("Too big: expected array to have <={max} items"),
                            Some(false),
                        )],
                    );
                }
                let mut issues = Vec::new();
                let mut output = Vec::new();
                for (index, element) in values.iter().enumerate() {
                    let (parsed, element_issues) = item.run(Some(element));
                    issues.extend(element_issues.into_iter().map(|mut issue| {
                        issue.path.insert(0, Json::from(index));
                        issue
                    }));
                    output.push(parsed.unwrap_or(Json::Null));
                }
                if let Some(minimum) = min
                    && !explicitly_aborted(&issues)
                    && values.len() < *minimum
                {
                    issues.push(Issue::new(
                        format!("Too small: expected array to have >={minimum} items"),
                        Some(true),
                    ));
                }
                (Some(Json::Arr(output)), issues)
            }
            Schema::Text { max } => Schema::untrimmed(value, 0, *max),
            Schema::Pattern { pattern, display } => {
                let Some(Json::Str(text)) = value else {
                    return (value.cloned(), vec![invalid_type("string", value, None)]);
                };
                let matches =
                    regex::Regex::new(pattern).is_ok_and(|expression| expression.is_match(text));
                if matches {
                    (value.cloned(), Vec::new())
                } else {
                    (
                        value.cloned(),
                        vec![Issue::new(
                            format!("Invalid string: must match pattern {display}"),
                            Some(true),
                        )],
                    )
                }
            }
            Schema::Record {
                key,
                value: item,
                refine,
            } => {
                let Some(Json::Obj(entries)) = value else {
                    return (value.cloned(), vec![invalid_type("record", value, None)]);
                };
                let pattern = regex::Regex::new(key).expect("record key pattern");
                let mut issues = Vec::new();
                let mut output = Json::obj();
                for (name, element) in entries {
                    if !pattern.is_match(name) {
                        let mut issue = Issue::new("Invalid key in record".into(), Some(true));
                        issue.path.push(Json::from(name.as_str()));
                        issues.push(issue);
                        continue;
                    }
                    let (parsed, element_issues) = item.run(Some(element));
                    issues.extend(element_issues.into_iter().map(|mut issue| {
                        issue.path.insert(0, Json::from(name.as_str()));
                        issue
                    }));
                    if let Some(parsed) = parsed {
                        output.set(name, parsed);
                    }
                }
                if let Some((refine, message)) = refine
                    && !aborted(&issues)
                    && !refine(&output)
                {
                    issues.push(Issue::new((*message).into(), Some(true)));
                }
                (Some(output), issues)
            }
            Schema::Defaulted(schema, default) => match value {
                None => (Some(Json::from(*default)), Vec::new()),
                Some(value) => schema.run(Some(value)),
            },
            Schema::Argument { max } => {
                let (output, mut issues) = Schema::untrimmed(value, 1, *max);
                if !aborted(&issues)
                    && matches!(value, Some(Json::Str(text)) if text.contains('\0'))
                {
                    issues.push(Issue::new("Invalid input".into(), Some(true)));
                }
                (output, issues)
            }
            Schema::TextMin { min, max } => Schema::untrimmed(value, *min, *max),
            Schema::Literal(expected) => match value {
                Some(Json::Str(text)) if text == expected => (value.cloned(), Vec::new()),
                _ => (
                    value.cloned(),
                    vec![Issue::new(
                        format!("Invalid input: expected {}", quote(expected)),
                        None,
                    )],
                ),
            },
            Schema::Discriminated { key, options } => {
                let Some(Json::Obj(_)) = value else {
                    return (value.cloned(), vec![invalid_type("object", value, None)]);
                };
                let present = value.and_then(|value| value.get(key));
                let discriminator = present.and_then(Json::as_str);
                // An option whose discriminator has a default also takes an absent one.
                let defaults = |schema: &Schema| match schema {
                    Schema::Object { fields, .. } => fields.iter().any(|(name, field, _)| {
                        name == key && matches!(field, Schema::Defaulted(..))
                    }),
                    _ => false,
                };
                match options.iter().find(|(name, schema)| {
                    Some(*name) == discriminator || (present.is_none() && defaults(schema))
                }) {
                    Some((_, schema)) => schema.run(value),
                    None => {
                        let expected = options
                            .iter()
                            .flat_map(|(name, schema)| {
                                let mut names = vec![format!("'{name}'")];
                                if defaults(schema) {
                                    names.push("'undefined'".into());
                                }
                                names
                            })
                            .collect::<Vec<_>>()
                            .join(" | ");
                        let mut issue = Issue::new(
                            format!("Invalid discriminator value. Expected {expected}"),
                            None,
                        );
                        issue.path.push(Json::from(*key));
                        issue.expected = Some("object or array");
                        (value.cloned(), vec![issue])
                    }
                }
            }
            Schema::Union(options) => {
                let results: Vec<(Option<Json>, Vec<Issue>)> =
                    options.iter().map(|option| option.run(value)).collect();
                if let Some((parsed, _)) = results.iter().find(|(_, issues)| issues.is_empty()) {
                    return (parsed.clone(), Vec::new());
                }
                let live: Vec<&(Option<Json>, Vec<Issue>)> = results
                    .iter()
                    .filter(|(_, issues)| !aborted(issues))
                    .collect();
                if live.len() == 1 {
                    return live[0].clone();
                }
                (
                    value.cloned(),
                    vec![Issue {
                        expected: Some("object or array"),
                        ..Issue::new("Invalid input".into(), None)
                    }],
                )
            }
        }
    }
}

/// `parseLeniently`: a string holding the JSON of what the schema expected
/// is replaced by its parsed value, up to four times.
pub fn parse_leniently(schema: &Schema, value: &Json) -> Result<Json, Vec<Issue>> {
    let mut current = value.clone();
    for _ in 0..4 {
        let (parsed, issues) = schema.run(Some(&current));
        if issues.is_empty() {
            return Ok(parsed.unwrap_or(Json::Null));
        }
        match repaired(&current, &issues) {
            Some(next) => current = next,
            None => return Err(issues),
        }
    }
    let (parsed, issues) = schema.run(Some(&current));
    if issues.is_empty() {
        Ok(parsed.unwrap_or(Json::Null))
    } else {
        Err(issues)
    }
}

fn repaired(value: &Json, issues: &[Issue]) -> Option<Json> {
    let mut copy = value.clone();
    let mut changed = false;
    for issue in issues {
        let Some(expected) = issue.expected.filter(|expected| {
            ["array", "boolean", "number", "object", "object or array"].contains(expected)
        }) else {
            continue;
        };
        let Some((key, parents)) = issue.path.split_last() else {
            continue;
        };
        let Some(parent) = parents
            .iter()
            .try_fold(&mut copy, |node, part| child_mut(node, part))
        else {
            continue;
        };
        let Some(raw) = child_mut(parent, key) else {
            continue;
        };
        let Json::Str(text) = raw else { continue };
        let Ok(parsed) = Json::parse(crate::text::js_trim(text)) else {
            continue;
        };
        let kind = match parsed {
            Json::Arr(_) => "array",
            Json::Null => "null",
            Json::Obj(_) => "object",
            Json::Num(_) => "number",
            Json::Bool(_) => "boolean",
            Json::Str(_) => "string",
        };
        let fits = if expected == "object or array" {
            kind == "object" || kind == "array"
        } else {
            kind == expected
        };
        if !fits {
            continue;
        }
        *raw = parsed;
        changed = true;
    }
    changed.then_some(copy)
}

fn child_mut<'a>(node: &'a mut Json, key: &Json) -> Option<&'a mut Json> {
    match (node, key) {
        (Json::Obj(entries), Json::Str(name)) => entries
            .iter_mut()
            .find(|(known, _)| known == name)
            .map(|(_, value)| value),
        (Json::Arr(values), Json::Num(index)) => values.get_mut(*index as usize),
        _ => None,
    }
}

/// `invalidInput`: the first five issues, `path: message`.
pub fn issues_message(issues: &[Issue]) -> String {
    issues
        .iter()
        .take(5)
        .map(|issue| {
            let path = issue
                .path
                .iter()
                .map(|part| match part {
                    Json::Str(text) => text.clone(),
                    other => other.stringify(),
                })
                .collect::<Vec<_>>()
                .join(".");
            format!(
                "{}: {}",
                if path.is_empty() { "input" } else { &path },
                issue.message
            )
        })
        .collect::<Vec<_>>()
        .join("; ")
}

const RELATIVE_PATH: fn() -> Schema = || Schema::Str { min: 1, max: 4_096 };

pub fn search_code_schema() -> Schema {
    Schema::Object {
        fields: vec![
            ("query", Schema::Str { min: 1, max: 1_000 }, false),
            (
                "scope",
                Schema::Union(vec![
                    RELATIVE_PATH(),
                    Schema::Array {
                        item: Box::new(RELATIVE_PATH()),
                        min: None,
                        max: 100,
                    },
                ]),
                true,
            ),
            (
                "mode",
                Schema::Enum(&["auto", "text", "regex", "symbol", "references"]),
                true,
            ),
            ("output", Schema::Enum(&["matches", "files", "count"]), true),
            ("caseSensitive", Schema::Bool, true),
            (
                "context",
                Schema::Int {
                    min: Some((0, true)),
                    max: Some(30),
                },
                true,
            ),
            (
                "limit",
                Schema::Int {
                    min: Some((1, true)),
                    max: Some(100),
                },
                true,
            ),
            (
                "offset",
                Schema::Int {
                    min: Some((0, true)),
                    max: Some(5_000),
                },
                true,
            ),
        ],
        refine: None,
    }
}

fn line_range() -> Schema {
    Schema::Object {
        fields: vec![
            (
                "startLine",
                Schema::Int {
                    min: Some((0, false)),
                    max: None,
                },
                false,
            ),
            (
                "endLine",
                Schema::Int {
                    min: Some((0, false)),
                    max: None,
                },
                false,
            ),
        ],
        refine: Some((
            |value| {
                let line = |key: &str| value.get(key).and_then(Json::as_f64).unwrap_or(0.0);
                line("endLine") >= line("startLine")
            },
            "Invalid input",
        )),
    }
}

pub fn edit_code_schema() -> Schema {
    let symbol = Schema::Object {
        fields: vec![
            ("kind", Schema::Literal("symbol"), false),
            ("target", Schema::Str { min: 1, max: 4_096 }, false),
            (
                "action",
                Schema::Enum(&[
                    "replace",
                    "replace_body",
                    "rename",
                    "insert_before",
                    "insert_after",
                    "delete",
                ]),
                false,
            ),
            ("content", Schema::Text { max: 2_097_152 }, true),
        ],
        refine: Some((
            |value| {
                value.get("action").and_then(Json::as_str) == Some("delete")
                    || value.get("content").is_some()
            },
            "content is required",
        )),
    };
    let patch = Schema::Object {
        fields: vec![
            ("kind", Schema::Literal("patch"), false),
            ("target", Schema::Str { min: 1, max: 4_096 }, true),
            ("path", Schema::Str { min: 1, max: 4_096 }, true),
            (
                "patch",
                Schema::TextMin {
                    min: 1,
                    max: 2_097_152,
                },
                false,
            ),
        ],
        refine: None,
    };
    Schema::Object {
        fields: vec![(
            "operations",
            Schema::Array {
                item: Box::new(Schema::Discriminated {
                    key: "kind",
                    options: vec![("symbol", symbol), ("patch", patch)],
                }),
                min: Some(1),
                max: 50,
            },
            false,
        )],
        refine: None,
    }
}

/// `lightRunTaskInputSchema`'s analyze option (symbolic analysis enabled).
fn analyze_task_schema() -> Schema {
    let bounds = Schema::Object {
        fields: vec![
            (
                "min",
                Schema::Int {
                    min: None,
                    max: None,
                },
                false,
            ),
            (
                "max",
                Schema::Int {
                    min: None,
                    max: None,
                },
                false,
            ),
        ],
        refine: Some((
            |value| {
                value.get("min").and_then(Json::as_f64).unwrap_or(0.0)
                    <= value.get("max").and_then(Json::as_f64).unwrap_or(0.0)
            },
            "min must not exceed max",
        )),
    };
    let boolean = Schema::Object {
        fields: vec![("type", Schema::Literal("boolean"), false)],
        refine: None,
    };
    Schema::Object {
        fields: vec![
            ("kind", Schema::Literal("analyze"), false),
            ("target", Schema::Str { min: 1, max: 4_096 }, false),
            (
                "inputs",
                Schema::Record {
                    key: r"^[A-Za-z_$][A-Za-z0-9_$]*$",
                    value: Box::new(Schema::Union(vec![bounds, boolean])),
                    refine: Some((
                        |value| value.as_object().is_some_and(|entries| entries.len() <= 8),
                        "At most eight inputs",
                    )),
                },
                false,
            ),
            ("assertion", Schema::Str { min: 1, max: 2_000 }, false),
            (
                "timeoutMs",
                Schema::Int {
                    min: Some((100, true)),
                    max: Some(10_000),
                },
                true,
            ),
        ],
        refine: None,
    }
}

/// run_task's input schema: `lightRunTaskInputSchema` when symbolic
/// analysis is enabled, else `lightDefaultRunTaskInputSchema`.
pub fn run_task_schema() -> Schema {
    run_task_schema_for(std::env::var("BLAME_AGENT_SYMBOLIC_ANALYSIS").as_deref() == Ok("true"))
}

/// run_task's input schema with or without the analyze kind.
pub fn run_task_schema_for(symbolic: bool) -> Schema {
    let schema = default_run_task_schema();
    if !symbolic {
        return schema;
    }
    match schema {
        Schema::Discriminated { key, mut options } => {
            options.insert(0, ("analyze", analyze_task_schema()));
            Schema::Discriminated { key, options }
        }
        other => other,
    }
}

/// `lightDefaultRunTaskInputSchema`: run_task without symbolic analysis.
fn default_run_task_schema() -> Schema {
    let inspect = Schema::Object {
        fields: vec![
            ("kind", Schema::Literal("inspect"), false),
            (
                "run",
                Schema::Pattern {
                    pattern: r"^r[1-9]\d*$",
                    display: r"/^r[1-9]\d*$/u",
                },
                false,
            ),
            (
                "cursor",
                Schema::Pattern {
                    pattern: r"^\d+$",
                    display: r"/^\d+$/u",
                },
                true,
            ),
            ("until", Schema::Enum(&["exit", "output", "now"]), true),
        ],
        refine: None,
    };
    let project = Schema::Object {
        fields: vec![
            ("kind", Schema::Literal("project"), false),
            ("task", Schema::Str { min: 1, max: 300 }, false),
            ("packagePath", RELATIVE_PATH(), true),
            (
                "args",
                Schema::Array {
                    item: Box::new(Schema::Argument { max: 2_048 }),
                    min: None,
                    max: 32,
                },
                true,
            ),
        ],
        refine: None,
    };
    let command = Schema::Object {
        fields: vec![
            (
                "kind",
                Schema::Defaulted(Box::new(Schema::Literal("command")), "command"),
                false,
            ),
            ("command", Schema::Str { min: 1, max: 8_000 }, false),
            ("cwd", RELATIVE_PATH(), true),
        ],
        refine: None,
    };
    let dependency = Schema::Object {
        fields: vec![
            ("kind", Schema::Literal("dependency"), false),
            ("action", Schema::Enum(&["add", "remove"]), false),
            (
                "packages",
                Schema::Array {
                    item: Box::new(Schema::Str { min: 1, max: 300 }),
                    min: Some(1),
                    max: 50,
                },
                false,
            ),
            ("packagePath", RELATIVE_PATH(), true),
        ],
        refine: None,
    };
    Schema::Discriminated {
        key: "kind",
        options: vec![
            ("inspect", inspect),
            ("project", project),
            ("command", command),
            ("dependency", dependency),
        ],
    }
}

/// `finishTaskInputSchema`.
pub fn finish_task_schema() -> Schema {
    let image = Schema::Object {
        fields: vec![
            (
                "ref",
                Schema::Pattern {
                    pattern: r"^screenshot:[0-9a-f]{64}$",
                    display: r"/^screenshot:[0-9a-f]{64}$/u",
                },
                false,
            ),
            ("caption", Schema::Str { min: 1, max: 160 }, false),
        ],
        refine: None,
    };
    Schema::Object {
        fields: vec![
            (
                "summary",
                Schema::Str {
                    min: 1,
                    max: 100_000,
                },
                false,
            ),
            (
                "images",
                Schema::Array {
                    item: Box::new(image),
                    min: None,
                    max: 8,
                },
                true,
            ),
        ],
        refine: None,
    }
}

pub fn read_code_schema() -> Schema {
    Schema::Object {
        fields: vec![
            ("target", Schema::Str { min: 1, max: 4_096 }, false),
            (
                "view",
                Schema::Enum(&[
                    "auto",
                    "raw",
                    "outline",
                    "symbol",
                    "signature",
                    "range",
                    "declaration",
                ]),
                true,
            ),
            (
                "offset",
                Schema::Int {
                    min: Some((0, true)),
                    max: Some(256_000),
                },
                true,
            ),
            (
                "range",
                Schema::Union(vec![
                    line_range(),
                    Schema::Array {
                        item: Box::new(line_range()),
                        min: Some(1),
                        max: 8,
                    },
                ]),
                true,
            ),
        ],
        refine: None,
    }
}
