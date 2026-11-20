//! An ordered JSON value that prints exactly as `JSON.stringify` does.
//!
//! The model reads result objects in the order their fields were written, and
//! `nextSearch` echoes the caller's input in its own key order, so objects are
//! ordered lists of entries, never sorted maps. serde_json's `preserve_order`
//! would do the same, but it is a workspace-wide feature: it would change the
//! bytes the engine stores.

use serde::de::{Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use std::fmt::{self, Write as _};

#[derive(Clone, Debug, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

impl Json {
    pub fn obj() -> Json {
        Json::Obj(Vec::new())
    }

    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Obj(entries) => entries
                .iter()
                .find(|(name, _)| name == key)
                .map(|(_, value)| value),
            _ => None,
        }
    }

    pub fn get_mut(&mut self, key: &str) -> Option<&mut Json> {
        match self {
            Json::Obj(entries) => entries
                .iter_mut()
                .find(|(name, _)| name == key)
                .map(|(_, value)| value),
            _ => None,
        }
    }

    /// Sets `key`, keeping its place when it exists (as a JS assignment does).
    pub fn set(&mut self, key: &str, value: impl Into<Json>) {
        if let Json::Obj(entries) = self {
            let value = value.into();
            match entries.iter_mut().find(|(name, _)| name == key) {
                Some(entry) => entry.1 = value,
                None => entries.push((key.to_string(), value)),
            }
        }
    }

    /// Builder form of [`Json::set`].
    pub fn with(mut self, key: &str, value: impl Into<Json>) -> Json {
        self.set(key, value);
        self
    }

    /// Sets `key` only when `value` is present, as `...(x ? { key: x } : {})`.
    pub fn with_opt<T: Into<Json>>(mut self, key: &str, value: Option<T>) -> Json {
        if let Some(value) = value {
            self.set(key, value);
        }
        self
    }

    /// The same entries in the given key order (others keep theirs, after).
    pub fn reordered(self, keys: &[&str]) -> Json {
        let Json::Obj(mut entries) = self else {
            return self;
        };
        let mut ordered = Vec::new();
        for key in keys {
            if let Some(index) = entries.iter().position(|(name, _)| name == key) {
                ordered.push(entries.remove(index));
            }
        }
        ordered.extend(entries);
        Json::Obj(ordered)
    }

    pub fn remove(&mut self, key: &str) -> Option<Json> {
        match self {
            Json::Obj(entries) => {
                let index = entries.iter().position(|(name, _)| name == key)?;
                Some(entries.remove(index).1)
            }
            _ => None,
        }
    }

    /// Object spread: `{ ...self, ...other }`.
    pub fn extend(&mut self, other: Json) {
        if let Json::Obj(entries) = other {
            for (key, value) in entries {
                self.set(&key, value);
            }
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Json::Str(value) => Some(value),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Json::Num(value) => Some(*value),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Json::Bool(value) => Some(*value),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&Vec<Json>> {
        match self {
            Json::Arr(values) => Some(values),
            _ => None,
        }
    }

    pub fn as_object(&self) -> Option<&Vec<(String, Json)>> {
        match self {
            Json::Obj(entries) => Some(entries),
            _ => None,
        }
    }

    pub fn is_object(&self) -> bool {
        matches!(self, Json::Obj(_))
    }

    /// `stringValue`: a non-blank string.
    pub fn string_value(&self) -> Option<&str> {
        self.as_str()
            .filter(|value| !crate::text::js_trim(value).is_empty())
    }

    /// `JSON.stringify(value)`.
    pub fn stringify(&self) -> String {
        let mut output = String::new();
        self.write(&mut output);
        output
    }

    fn write(&self, output: &mut String) {
        match self {
            Json::Null => output.push_str("null"),
            Json::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
            Json::Num(value) => write_number(*value, output),
            Json::Str(value) => write_string(value, output),
            Json::Arr(values) => {
                output.push('[');
                for (index, value) in values.iter().enumerate() {
                    if index > 0 {
                        output.push(',');
                    }
                    value.write(output);
                }
                output.push(']');
            }
            Json::Obj(entries) => {
                output.push('{');
                for (index, (key, value)) in entries.iter().enumerate() {
                    if index > 0 {
                        output.push(',');
                    }
                    write_string(key, output);
                    output.push(':');
                    value.write(output);
                }
                output.push('}');
            }
        }
    }

    pub fn parse(text: &str) -> Result<Json, String> {
        let mut deserializer = serde_json::Deserializer::from_str(text);
        let value = Json::deserialize(&mut deserializer).map_err(|error| error.to_string())?;
        deserializer.end().map_err(|error| error.to_string())?;
        Ok(value)
    }
}

impl fmt::Display for Json {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.stringify())
    }
}

/// Numbers as JavaScript prints them: integers without a fraction.
fn write_number(value: f64, output: &mut String) {
    if !value.is_finite() {
        output.push_str("null");
    } else if value.fract() == 0.0 && value.abs() < 1e21 {
        // -0 prints as 0, as in JavaScript.
        let _ = write!(output, "{}", value as i128);
    } else {
        let _ = write!(output, "{value}");
    }
}

/// JSON.stringify's string quoting: only `"`, `\` and control characters.
pub fn write_string(value: &str, output: &mut String) {
    output.push('"');
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            '\u{8}' => output.push_str("\\b"),
            '\u{c}' => output.push_str("\\f"),
            control if (control as u32) < 0x20 => {
                let _ = write!(output, "\\u{:04x}", control as u32);
            }
            other => output.push(other),
        }
    }
    output.push('"');
}

pub fn quote(value: &str) -> String {
    let mut output = String::new();
    write_string(value, &mut output);
    output
}

impl From<&str> for Json {
    fn from(value: &str) -> Self {
        Json::Str(value.to_string())
    }
}
impl From<String> for Json {
    fn from(value: String) -> Self {
        Json::Str(value)
    }
}
impl From<&String> for Json {
    fn from(value: &String) -> Self {
        Json::Str(value.clone())
    }
}
impl From<bool> for Json {
    fn from(value: bool) -> Self {
        Json::Bool(value)
    }
}
impl From<f64> for Json {
    fn from(value: f64) -> Self {
        Json::Num(value)
    }
}
impl From<usize> for Json {
    fn from(value: usize) -> Self {
        Json::Num(value as f64)
    }
}
impl From<u64> for Json {
    fn from(value: u64) -> Self {
        Json::Num(value as f64)
    }
}
impl From<i64> for Json {
    fn from(value: i64) -> Self {
        Json::Num(value as f64)
    }
}
impl From<u32> for Json {
    fn from(value: u32) -> Self {
        Json::Num(f64::from(value))
    }
}
impl From<i32> for Json {
    fn from(value: i32) -> Self {
        Json::Num(f64::from(value))
    }
}
impl<T: Into<Json>> From<Vec<T>> for Json {
    fn from(values: Vec<T>) -> Self {
        Json::Arr(values.into_iter().map(Into::into).collect())
    }
}
impl From<(usize, usize)> for Json {
    fn from((start, end): (usize, usize)) -> Self {
        Json::Arr(vec![start.into(), end.into()])
    }
}

impl<'de> Deserialize<'de> for Json {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Json, D::Error> {
        struct JsonVisitor;
        impl<'de> Visitor<'de> for JsonVisitor {
            type Value = Json;
            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a JSON value")
            }
            fn visit_bool<E>(self, value: bool) -> Result<Json, E> {
                Ok(Json::Bool(value))
            }
            fn visit_i64<E>(self, value: i64) -> Result<Json, E> {
                Ok(Json::Num(value as f64))
            }
            fn visit_u64<E>(self, value: u64) -> Result<Json, E> {
                Ok(Json::Num(value as f64))
            }
            fn visit_f64<E>(self, value: f64) -> Result<Json, E> {
                Ok(Json::Num(value))
            }
            fn visit_str<E>(self, value: &str) -> Result<Json, E> {
                Ok(Json::Str(value.to_string()))
            }
            fn visit_string<E>(self, value: String) -> Result<Json, E> {
                Ok(Json::Str(value))
            }
            fn visit_unit<E>(self) -> Result<Json, E> {
                Ok(Json::Null)
            }
            fn visit_none<E>(self) -> Result<Json, E> {
                Ok(Json::Null)
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> Result<Json, A::Error> {
                let mut values = Vec::new();
                while let Some(value) = sequence.next_element::<Json>()? {
                    values.push(value);
                }
                Ok(Json::Arr(values))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Json, A::Error> {
                let mut object = Json::obj();
                // A repeated key keeps its first place and its last value, as JSON.parse.
                while let Some((key, value)) = map.next_entry::<String, Json>()? {
                    object.set(&key, value);
                }
                Ok(object)
            }
        }
        deserializer.deserialize_any(JsonVisitor)
    }
}

/// `json!`-like object literal: `obj! { "a" => 1, "b" => "x" }`.
#[macro_export]
macro_rules! obj {
    () => { $crate::json::Json::obj() };
    ($($key:expr => $value:expr),+ $(,)?) => {{
        let mut object = $crate::json::Json::obj();
        $( object.set($key, $value); )+
        object
    }};
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prints_like_json_stringify() {
        let value = Json::parse(r#"{"b":1,"a":[1.5,-0,"x\u0001\"\n"],"c":null,"d":true}"#).unwrap();
        assert_eq!(
            value.stringify(),
            r#"{"b":1,"a":[1.5,0,"x\u0001\"\n"],"c":null,"d":true}"#
        );
        assert_eq!(quote("é\u{2028}/"), "\"é\u{2028}/\"");
    }

    #[test]
    fn repeated_keys_keep_first_place() {
        let value = Json::parse(r#"{"a":1,"b":2,"a":3}"#).unwrap();
        assert_eq!(value.stringify(), r#"{"a":3,"b":2}"#);
    }
}
