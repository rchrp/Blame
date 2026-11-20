//! JSON as JavaScript's `JSON.parse` and `JSON.stringify` see it.
//!
//! The context rules rewrite results that the TypeScript harness serialised,
//! and show the model what the TypeScript rules showed it. `serde_json::Value`
//! sorts object keys and re-formats numbers, so a rewritten result would not
//! read like the original. This value keeps keys in their order and numbers
//! as their text. Strings are escaped by `serde_json`, which escapes the same
//! characters `JSON.stringify` does.

#[derive(Clone, Debug, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    /// The number's text, as it was written.
    Number(String),
    String(String),
    Array(Vec<Json>),
    Object(Vec<(String, Json)>),
}

/// Nesting beyond this is not a harness result; parsing gives up.
const MAX_DEPTH: usize = 256;

impl Json {
    /// `JSON.parse`, or `None` for anything it would reject (and for lone
    /// surrogates, which a Rust string cannot hold).
    pub fn parse(text: &str) -> Option<Json> {
        let mut parser = Parser {
            text,
            bytes: text.as_bytes(),
            at: 0,
        };
        let value = parser.value(0)?;
        parser.skip_space();
        (parser.at == parser.bytes.len()).then_some(value)
    }

    /// `JSON.stringify`.
    pub fn to_text(&self) -> String {
        let mut out = String::new();
        self.write(&mut out);
        out
    }

    fn write(&self, out: &mut String) {
        match self {
            Json::Null => out.push_str("null"),
            Json::Bool(value) => out.push_str(if *value { "true" } else { "false" }),
            Json::Number(text) => out.push_str(text),
            Json::String(text) => write_string(out, text),
            Json::Array(items) => {
                out.push('[');
                for (index, item) in items.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    item.write(out);
                }
                out.push(']');
            }
            Json::Object(entries) => {
                out.push('{');
                for (index, (key, value)) in entries.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    write_string(out, key);
                    out.push(':');
                    value.write(out);
                }
                out.push('}');
            }
        }
    }

    pub fn str(text: impl Into<String>) -> Json {
        Json::String(text.into())
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Json::String(text) => Some(text),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[Json]> {
        match self {
            Json::Array(items) => Some(items),
            _ => None,
        }
    }

    pub fn is_object(&self) -> bool {
        matches!(self, Json::Object(_))
    }

    /// A key of an object; `None` for anything else.
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Object(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn get_mut(&mut self, key: &str) -> Option<&mut Json> {
        match self {
            Json::Object(entries) => entries.iter_mut().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    /// `object[key] = value`: in place when the key exists, else last.
    pub fn set(&mut self, key: &str, value: Json) {
        if let Json::Object(entries) = self {
            match entries.iter_mut().find(|(k, _)| k == key) {
                Some((_, existing)) => *existing = value,
                None => entries.push((key.to_owned(), value)),
            }
        }
    }

    /// `delete object[key]`.
    pub fn remove(&mut self, key: &str) -> Option<Json> {
        match self {
            Json::Object(entries) => {
                let index = entries.iter().position(|(k, _)| k == key)?;
                Some(entries.remove(index).1)
            }
            _ => None,
        }
    }

    /// An object from entries, leaving out absent values as `JSON.stringify`
    /// leaves out `undefined`.
    pub fn object(entries: Vec<(&str, Option<Json>)>) -> Json {
        Json::Object(
            entries
                .into_iter()
                .filter_map(|(key, value)| value.map(|value| (key.to_owned(), value)))
                .collect(),
        )
    }
}

/// JavaScript's `string.length`: UTF-16 code units.
pub fn js_length(text: &str) -> usize {
    text.encode_utf16().count()
}

fn write_string(out: &mut String, text: &str) {
    out.push_str(&serde_json::to_string(text).expect("a string always serializes"));
}

struct Parser<'a> {
    text: &'a str,
    bytes: &'a [u8],
    at: usize,
}

impl Parser<'_> {
    fn skip_space(&mut self) {
        while matches!(self.bytes.get(self.at), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.at += 1;
        }
    }

    fn value(&mut self, depth: usize) -> Option<Json> {
        if depth > MAX_DEPTH {
            return None;
        }
        self.skip_space();
        match *self.bytes.get(self.at)? {
            b'{' => self.object(depth),
            b'[' => self.array(depth),
            b'"' => self.string().map(Json::String),
            b't' => self.literal("true", Json::Bool(true)),
            b'f' => self.literal("false", Json::Bool(false)),
            b'n' => self.literal("null", Json::Null),
            b'-' | b'0'..=b'9' => self.number(),
            _ => None,
        }
    }

    fn literal(&mut self, word: &str, value: Json) -> Option<Json> {
        self.text[self.at..].starts_with(word).then(|| {
            self.at += word.len();
            value
        })
    }

    fn number(&mut self) -> Option<Json> {
        let start = self.at;
        while matches!(
            self.bytes.get(self.at),
            Some(b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9')
        ) {
            self.at += 1;
        }
        let text = &self.text[start..self.at];
        // Validated by serde_json, kept as written.
        serde_json::from_str::<serde_json::Number>(text).ok()?;
        Some(Json::Number(text.to_owned()))
    }

    fn string(&mut self) -> Option<String> {
        let start = self.at;
        self.at += 1;
        loop {
            match *self.bytes.get(self.at)? {
                b'"' => break,
                b'\\' => self.at += 2,
                _ => self.at += 1,
            }
        }
        self.at += 1;
        serde_json::from_str::<String>(self.text.get(start..self.at)?).ok()
    }

    fn array(&mut self, depth: usize) -> Option<Json> {
        self.at += 1;
        let mut items = Vec::new();
        self.skip_space();
        if self.bytes.get(self.at) == Some(&b']') {
            self.at += 1;
            return Some(Json::Array(items));
        }
        loop {
            items.push(self.value(depth + 1)?);
            self.skip_space();
            match *self.bytes.get(self.at)? {
                b',' => self.at += 1,
                b']' => {
                    self.at += 1;
                    return Some(Json::Array(items));
                }
                _ => return None,
            }
        }
    }

    fn object(&mut self, depth: usize) -> Option<Json> {
        self.at += 1;
        let mut object = Json::Object(Vec::new());
        self.skip_space();
        if self.bytes.get(self.at) == Some(&b'}') {
            self.at += 1;
            return Some(object);
        }
        loop {
            self.skip_space();
            if self.bytes.get(self.at) != Some(&b'"') {
                return None;
            }
            let key = self.string()?;
            self.skip_space();
            if self.bytes.get(self.at) != Some(&b':') {
                return None;
            }
            self.at += 1;
            let value = self.value(depth + 1)?;
            // A repeated key keeps its first place and its last value.
            object.set(&key, value);
            self.skip_space();
            match *self.bytes.get(self.at)? {
                b',' => self.at += 1,
                b'}' => {
                    self.at += 1;
                    return Some(object);
                }
                _ => return None,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_comes_back_as_it_was_written() {
        for text in [
            r#"{"status":"ok","data":{"z":1,"a":[1.5,-2,1e-7,true,null]},"b":"x\n\"y\"\u001f"}"#,
            r#"[]"#,
            r#"{}"#,
            r#""é ✓ \u2028""#,
        ] {
            let value = Json::parse(text).unwrap();
            let again = Json::parse(&value.to_text()).unwrap();
            assert_eq!(value, again);
        }
        let text =
            r#"{"status":"ok","data":{"z":1,"a":[1.5,-2,1e-7,true,null]},"b":"x\n\"y\"\u001f"}"#;
        assert_eq!(Json::parse(text).unwrap().to_text(), text);
        assert_eq!(
            Json::parse(" { \"a\" : 1 , \"a\" : 2 , \"b\" : 3 } ")
                .unwrap()
                .to_text(),
            r#"{"a":2,"b":3}"#
        );
        assert_eq!(Json::parse("{\"a\":1} x"), None);
        assert_eq!(Json::parse("{\"a\":}"), None);
        assert_eq!(Json::parse("\"\\ud800\""), None);
        assert_eq!(js_length("a😀"), 3);
    }
}
