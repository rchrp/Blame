//! The subset of JSON Schema that Blame's result tools use, checked
//! without a dependency.
//!
//! Supported: `type` (a name or a list), `properties`, `required`,
//! `additionalProperties` (a boolean or a schema), `items`, `minItems`,
//! `maxItems`, `uniqueItems`, `enum`, `const`, `minLength`, `maxLength`,
//! `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `anyOf`,
//! `oneOf`, `allOf`, `not`. Annotations (`description`, `title`, `default`,
//! `examples`, `format`, `$schema`, `$id`, `$comment`, `deprecated`,
//! `readOnly`, `writeOnly`) are ignored, as the standard allows. Any other
//! keyword (`pattern`, `$ref`…) is reported by [`unsupported_keywords`], and
//! a contract using one is refused, so a schema is never silently checked
//! less than it says.

use serde_json::{Map, Value};

/// Errors reported for one value at most; the model needs the first few.
const MAX_ERRORS: usize = 20;

const CHECKED: &[&str] = &[
    "type",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "minItems",
    "maxItems",
    "uniqueItems",
    "enum",
    "const",
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "anyOf",
    "oneOf",
    "allOf",
    "not",
];

const ANNOTATIONS: &[&str] = &[
    "description",
    "title",
    "default",
    "examples",
    "format",
    "$schema",
    "$id",
    "$comment",
    "deprecated",
    "readOnly",
    "writeOnly",
];

/// Where `value` does not match `schema`, as `<JSON pointer>: <problem>`.
/// Empty when it matches.
pub fn validate(schema: &Value, value: &Value) -> Vec<String> {
    let mut errors = Vec::new();
    check(schema, value, "", &mut errors);
    errors.truncate(MAX_ERRORS);
    errors
}

/// JSON pointers of the keywords in `schema` that [`validate`] does not
/// check.
pub fn unsupported_keywords(schema: &Value) -> Vec<String> {
    let mut found = Vec::new();
    walk_keywords(schema, "", &mut found);
    found
}

fn walk_keywords(schema: &Value, at: &str, found: &mut Vec<String>) {
    let Value::Object(map) = schema else {
        if !schema.is_boolean() {
            found.push(format!("{at} (not a schema)"));
        }
        return;
    };
    for (key, child) in map {
        let here = format!("{at}/{}", escape(key));
        match key.as_str() {
            "properties" => {
                if let Value::Object(properties) = child {
                    for (name, schema) in properties {
                        walk_keywords(schema, &format!("{here}/{}", escape(name)), found);
                    }
                }
            }
            "items" | "additionalProperties" | "not" => walk_keywords(child, &here, found),
            "anyOf" | "oneOf" | "allOf" => {
                if let Value::Array(schemas) = child {
                    for (index, schema) in schemas.iter().enumerate() {
                        walk_keywords(schema, &format!("{here}/{index}"), found);
                    }
                }
            }
            key if CHECKED.contains(&key) || ANNOTATIONS.contains(&key) => {}
            _ => found.push(here),
        }
    }
}

fn check(schema: &Value, value: &Value, at: &str, errors: &mut Vec<String>) {
    if errors.len() >= MAX_ERRORS {
        return;
    }
    let schema = match schema {
        Value::Bool(true) => return,
        Value::Bool(false) => {
            errors.push(format!("{}: no value is allowed here", pointer(at)));
            return;
        }
        Value::Object(map) => map,
        _ => return,
    };
    if let Some(types) = schema.get("type")
        && !type_matches(types, value)
    {
        errors.push(format!(
            "{}: expected {}, found {}",
            pointer(at),
            type_names(types),
            kind(value)
        ));
        return;
    }
    if let Some(Value::Array(options)) = schema.get("enum")
        && !options.iter().any(|option| equal(option, value))
    {
        let options: Vec<String> = options.iter().map(Value::to_string).collect();
        errors.push(format!(
            "{}: must be one of {}",
            pointer(at),
            options.join(", ")
        ));
    }
    if let Some(expected) = schema.get("const")
        && !equal(expected, value)
    {
        errors.push(format!("{}: must be {expected}", pointer(at)));
    }
    match value {
        Value::Object(object) => check_object(schema, object, at, errors),
        Value::Array(items) => check_array(schema, items, at, errors),
        Value::String(text) => {
            let length = text.chars().count() as u64;
            if let Some(min) = schema.get("minLength").and_then(Value::as_u64)
                && length < min
            {
                errors.push(format!(
                    "{}: at least {min} characters, found {length}",
                    pointer(at)
                ));
            }
            if let Some(max) = schema.get("maxLength").and_then(Value::as_u64)
                && length > max
            {
                errors.push(format!(
                    "{}: at most {max} characters, found {length}",
                    pointer(at)
                ));
            }
        }
        Value::Number(number) => {
            if let Some(number) = number.as_f64() {
                check_number(schema, number, at, errors);
            }
        }
        Value::Bool(_) | Value::Null => {}
    }
    combinators(schema, value, at, errors);
}

fn check_object(
    schema: &Map<String, Value>,
    object: &Map<String, Value>,
    at: &str,
    errors: &mut Vec<String>,
) {
    if let Some(Value::Array(required)) = schema.get("required") {
        for name in required.iter().filter_map(Value::as_str) {
            if !object.contains_key(name) {
                errors.push(format!("{}: `{name}` is required", pointer(at)));
            }
        }
    }
    let properties = schema.get("properties").and_then(Value::as_object);
    for (name, child) in object {
        let here = format!("{at}/{}", escape(name));
        match properties.and_then(|properties| properties.get(name)) {
            Some(property) => check(property, child, &here, errors),
            None => match schema.get("additionalProperties") {
                Some(Value::Bool(false)) => {
                    errors.push(format!("{here}: no such property"));
                }
                Some(additional @ Value::Object(_)) => check(additional, child, &here, errors),
                _ => {}
            },
        }
    }
}

fn check_array(schema: &Map<String, Value>, items: &[Value], at: &str, errors: &mut Vec<String>) {
    let count = items.len() as u64;
    if let Some(min) = schema.get("minItems").and_then(Value::as_u64)
        && count < min
    {
        errors.push(format!(
            "{}: at least {min} items, found {count}",
            pointer(at)
        ));
    }
    if let Some(max) = schema.get("maxItems").and_then(Value::as_u64)
        && count > max
    {
        errors.push(format!(
            "{}: at most {max} items, found {count}",
            pointer(at)
        ));
    }
    if schema.get("uniqueItems") == Some(&Value::Bool(true)) {
        for (index, item) in items.iter().enumerate() {
            if items[..index].iter().any(|earlier| equal(earlier, item)) {
                errors.push(format!("{}/{index}: repeats an earlier item", pointer(at)));
            }
        }
    }
    if let Some(item_schema) = schema.get("items") {
        for (index, item) in items.iter().enumerate() {
            check(item_schema, item, &format!("{at}/{index}"), errors);
        }
    }
}

fn check_number(schema: &Map<String, Value>, number: f64, at: &str, errors: &mut Vec<String>) {
    let bound = |key: &str| schema.get(key).and_then(Value::as_f64);
    if let Some(min) = bound("minimum")
        && number < min
    {
        errors.push(format!("{}: at least {min}, found {number}", pointer(at)));
    }
    if let Some(max) = bound("maximum")
        && number > max
    {
        errors.push(format!("{}: at most {max}, found {number}", pointer(at)));
    }
    if let Some(min) = bound("exclusiveMinimum")
        && number <= min
    {
        errors.push(format!("{}: more than {min}, found {number}", pointer(at)));
    }
    if let Some(max) = bound("exclusiveMaximum")
        && number >= max
    {
        errors.push(format!("{}: less than {max}, found {number}", pointer(at)));
    }
}

fn combinators(schema: &Map<String, Value>, value: &Value, at: &str, errors: &mut Vec<String>) {
    let matches = |schema: &Value| validate_at(schema, value, at).is_empty();
    if let Some(Value::Array(all)) = schema.get("allOf") {
        for schema in all {
            check(schema, value, at, errors);
        }
    }
    if let Some(Value::Array(any)) = schema.get("anyOf")
        && !any.iter().any(matches)
    {
        errors.push(format!(
            "{}: matches none of the allowed shapes",
            pointer(at)
        ));
    }
    if let Some(Value::Array(one)) = schema.get("oneOf") {
        let matching = one.iter().filter(|schema| matches(schema)).count();
        if matching != 1 {
            errors.push(format!(
                "{}: must match exactly one of the allowed shapes, matches {matching}",
                pointer(at)
            ));
        }
    }
    if let Some(not) = schema.get("not")
        && matches(not)
    {
        errors.push(format!(
            "{}: matches a shape that is not allowed",
            pointer(at)
        ));
    }
}

fn validate_at(schema: &Value, value: &Value, at: &str) -> Vec<String> {
    let mut errors = Vec::new();
    check(schema, value, at, &mut errors);
    errors
}

fn type_matches(types: &Value, value: &Value) -> bool {
    match types {
        Value::String(name) => is_type(name, value),
        Value::Array(names) => names
            .iter()
            .filter_map(Value::as_str)
            .any(|name| is_type(name, value)),
        _ => true,
    }
}

fn is_type(name: &str, value: &Value) -> bool {
    match name {
        "object" => value.is_object(),
        "array" => value.is_array(),
        "string" => value.is_string(),
        "boolean" => value.is_boolean(),
        "null" => value.is_null(),
        "number" => value.is_number(),
        "integer" => match value {
            Value::Number(number) => {
                number.is_i64()
                    || number.is_u64()
                    || number.as_f64().is_some_and(|f| f.fract() == 0.0)
            }
            _ => false,
        },
        _ => false,
    }
}

fn type_names(types: &Value) -> String {
    match types {
        Value::String(name) => name.clone(),
        Value::Array(names) => names
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(" or "),
        other => other.to_string(),
    }
}

fn kind(value: &Value) -> &'static str {
    match value {
        Value::Object(_) => "an object",
        Value::Array(_) => "an array",
        Value::String(_) => "a string",
        Value::Number(_) => "a number",
        Value::Bool(_) => "a boolean",
        Value::Null => "null",
    }
}

/// JSON Schema equality: numbers compare by value (`1` equals `1.0`).
fn equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(a, b)| equal(a, b))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(key, a)| y.get(key).is_some_and(|b| equal(a, b)))
        }
        _ => a == b,
    }
}

fn pointer(at: &str) -> &str {
    if at.is_empty() { "/" } else { at }
}

fn escape(segment: &str) -> String {
    segment.replace('~', "~0").replace('/', "~1")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn finding() -> Value {
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["title", "severity", "locations"],
            "properties": {
                "title": { "type": "string", "minLength": 1, "description": "Short." },
                "severity": { "enum": ["low", "medium", "high"] },
                "score": { "type": "number", "minimum": 0, "maximum": 10 },
                "count": { "type": "integer" },
                "locations": {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                        "type": "object",
                        "required": ["path"],
                        "properties": { "path": { "type": "string" }, "line": { "type": ["number", "null"] } }
                    }
                },
                "status": { "oneOf": [{ "const": "open" }, { "const": "closed" }] }
            }
        })
    }

    #[test]
    fn a_matching_value_has_no_errors() {
        let value = json!({
            "title": "SQL injection",
            "severity": "high",
            "score": 9.5,
            "count": 3,
            "locations": [{ "path": "src/db.ts", "line": null }],
            "status": "open"
        });
        assert_eq!(validate(&finding(), &value), Vec::<String>::new());
        assert_eq!(unsupported_keywords(&finding()), Vec::<String>::new());
    }

    #[test]
    fn every_mismatch_is_reported_with_its_place() {
        let value = json!({
            "title": "",
            "severity": "critical",
            "score": 11,
            "count": 1.5,
            "locations": [{ "line": "3" }],
            "status": "pending",
            "extra": true
        });
        assert_eq!(
            validate(&finding(), &value),
            [
                "/count: expected integer, found a number",
                "/extra: no such property",
                "/locations/0: `path` is required",
                "/locations/0/line: expected number or null, found a string",
                "/score: at most 10, found 11",
                "/severity: must be one of \"low\", \"medium\", \"high\"",
                "/status: must match exactly one of the allowed shapes, matches 0",
                "/title: at least 1 characters, found 0",
            ]
        );
    }

    #[test]
    fn the_root_must_have_the_right_type() {
        assert_eq!(
            validate(&finding(), &json!("a title")),
            ["/: expected object, found a string"]
        );
        assert_eq!(
            validate(&json!(false), &json!(1)),
            ["/: no value is allowed here"]
        );
        assert_eq!(validate(&json!(true), &json!(1)), Vec::<String>::new());
    }

    #[test]
    fn unchecked_keywords_are_named() {
        let schema = json!({
            "type": "object",
            "properties": {
                "id": { "type": "string", "pattern": "^[a-z]+$" },
                "items": { "type": "array", "items": { "$ref": "#/definitions/x" } }
            },
            "definitions": {}
        });
        assert_eq!(
            unsupported_keywords(&schema),
            [
                "/definitions",
                "/properties/id/pattern",
                "/properties/items/items/$ref"
            ]
        );
    }
}
