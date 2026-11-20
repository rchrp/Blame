//! JavaScript string semantics the model-facing text depends on.
//!
//! The TypeScript harness measures, slices and orders strings the way
//! JavaScript does: `length` counts UTF-16 code units, `trim` removes
//! ECMAScript white space, and `localeCompare` uses ICU's root collation. The
//! results the model reads were tuned with those numbers, so they are kept.

use std::cmp::Ordering;

/// `string.length`: UTF-16 code units.
pub fn utf16_len(value: &str) -> usize {
    value.chars().map(char::len_utf16).sum()
}

/// `string.slice(0, units)` in UTF-16 code units. A cut inside a surrogate
/// pair keeps the whole character out (JavaScript would keep a lone half).
pub fn utf16_prefix(value: &str, units: usize) -> &str {
    let mut used = 0;
    for (index, character) in value.char_indices() {
        let width = character.len_utf16();
        if used + width > units {
            return &value[..index];
        }
        used += width;
    }
    value
}

/// Byte offset of the UTF-16 offset `units` (clamped to the string).
pub fn utf16_to_byte(value: &str, units: usize) -> usize {
    utf16_prefix(value, units).len()
}

/// ECMAScript `WhiteSpace` and `LineTerminator`, which `trim` and `\s` use.
pub fn is_js_space(character: char) -> bool {
    matches!(
        character,
        '\u{9}' | '\u{a}' | '\u{b}' | '\u{c}' | '\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

pub fn js_trim(value: &str) -> &str {
    value.trim_matches(is_js_space)
}

pub fn js_trim_end(value: &str) -> &str {
    value.trim_end_matches(is_js_space)
}

pub fn js_trim_start(value: &str) -> &str {
    value.trim_start_matches(is_js_space)
}

/// `value.replace(/\s+/gu, " ")`.
pub fn collapse_spaces(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut in_space = false;
    for character in value.chars() {
        if is_js_space(character) {
            if !in_space {
                output.push(' ');
            }
            in_space = true;
        } else {
            output.push(character);
            in_space = false;
        }
    }
    output
}

/// `value.split(/\s+/u).filter(Boolean)`.
pub fn split_spaces(value: &str) -> Vec<&str> {
    value
        .split(is_js_space)
        .filter(|part| !part.is_empty())
        .collect()
}

/// `text.split(/(?<=\n)/u)`: lines with their newline, and a last line
/// without one (an empty string for empty text, as JavaScript gives `[""]`).
pub fn split_keep_newline(text: &str) -> Vec<&str> {
    if text.is_empty() {
        return vec![""];
    }
    let mut lines: Vec<&str> = text.split_inclusive('\n').collect();
    if text.ends_with('\n') {
        // JavaScript's lookbehind split leaves no empty tail.
        lines.retain(|line| !line.is_empty());
    }
    lines
}

/// `toLocaleLowerCase()` in the default locale.
pub fn lower(value: &str) -> String {
    value.to_lowercase()
}

/// `a.localeCompare(b)` in the ICU root locale, for the strings paths are
/// made of. ASCII follows the root collation table (white space, then
/// punctuation in ICU order, symbols, digits, letters case-insensitively, then
/// lowercase before uppercase). Other characters sort after ASCII letters by
/// code point, where ICU would interleave accented letters with their base
/// letters: no such path appears in the measured sessions.
pub fn locale_compare(left: &str, right: &str) -> Ordering {
    let primary = |value: &str| value.chars().map(primary_weight).collect::<Vec<u32>>();
    match primary(left).cmp(&primary(right)) {
        Ordering::Equal => {}
        other => return other,
    }
    let tertiary = |value: &str| {
        value
            .chars()
            .map(|character| u8::from(character.is_ascii_uppercase()))
            .collect::<Vec<u8>>()
    };
    tertiary(left).cmp(&tertiary(right))
}

const ROOT_ASCII_ORDER: &str = " _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$0123456789";

fn primary_weight(character: char) -> u32 {
    if let Some(index) = ROOT_ASCII_ORDER.find(character) {
        return index as u32 + 1;
    }
    if character.is_ascii_alphabetic() {
        return 100 + (character.to_ascii_lowercase() as u32 - 'a' as u32);
    }
    if (character as u32) < 0x20 {
        // Control characters are ignorable in ICU; keep them first and stable.
        return 0;
    }
    1_000 + character as u32
}

/// JavaScript's default `sort()` order: UTF-16 code units.
pub fn utf16_compare(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

/// Lines counted as `value.split("\n").length`.
pub fn split_newline_count(value: &str) -> usize {
    value.bytes().filter(|byte| *byte == b'\n').count() + 1
}

/// `value.replace(/\r?\n$/u, "")`.
pub fn strip_crlf_end(value: &str) -> &str {
    match value.strip_suffix('\n') {
        Some(rest) => rest.strip_suffix('\r').unwrap_or(rest),
        None => value,
    }
}

/// Lossy UTF-8 decoding as `buffer.toString("utf8")`: each invalid sequence
/// becomes U+FFFD, following the WHATWG decoder the same way Rust does.
pub fn utf8_lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locale_compare_follows_icu_root_order() {
        let mut values = vec![
            "a-b", "a_b", "ab", "a.b", "a/b", "aB", "Ab", "AB", "ab1", "a1b", "a b",
        ];
        values.sort_by(|left, right| locale_compare(left, right));
        assert_eq!(
            values,
            [
                "a b", "a_b", "a-b", "a.b", "a/b", "a1b", "ab", "aB", "Ab", "AB", "ab1"
            ]
        );
        let mut files = vec!["b.test.ts", "b.ts", "b-x.ts", "bx.ts", "B.ts"];
        files.sort_by(|left, right| locale_compare(left, right));
        assert_eq!(files, ["b-x.ts", "b.test.ts", "b.ts", "B.ts", "bx.ts"]);
        assert_eq!(locale_compare("x10", "x9"), Ordering::Less);
    }

    #[test]
    fn utf16_measures_like_javascript() {
        assert_eq!(utf16_len("a😀é"), 4);
        assert_eq!(utf16_prefix("a😀é", 2), "a");
        assert_eq!(utf16_prefix("a😀é", 3), "a😀");
    }

    #[test]
    fn splits_lines_like_lookbehind() {
        assert_eq!(split_keep_newline("a\nb"), ["a\n", "b"]);
        assert_eq!(split_keep_newline("a\n"), ["a\n"]);
        assert_eq!(split_keep_newline(""), [""]);
    }
}
