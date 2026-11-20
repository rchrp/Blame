//! Line-based text search on ripgrep's own library crates (grep-searcher and
//! grep-regex), configured as the ripgrep binary the TypeScript harness runs
//! (`lexical-search.ts`): `--json --hidden --sort path --max-filesize 2M
//! --max-count N [--ignore-case] [--fixed-strings] -- PATTERN FILES|.`.
//!
//! The subprocess listed the candidate files on its command line when they
//! fit in 24,000 characters, and walked the workspace otherwise. Both orders
//! are reproduced: named files are searched in candidate order, with binary
//! data converted (NUL as a line end), and a walk visits paths in sorted
//! directory order, skipping files over 2 MiB and stopping a file at its
//! first NUL byte.

use crate::failure::{Failure, Outcome, Signal};
use crate::files::WorkspaceFiles;
use crate::text::{js_trim_end, strip_crlf_end, utf16_len, utf16_prefix};
use grep_matcher::Matcher;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::{BinaryDetection, Searcher, SearcherBuilder, Sink, SinkMatch};
use std::cmp::Ordering;
use std::io;

pub struct TextQuery {
    pub case_sensitive: bool,
    pub pattern: String,
    pub regex: bool,
}

/// One matching line. `hits` holds every matched text on that line.
#[derive(Clone, Debug, PartialEq)]
pub struct LexicalMatch {
    pub path: String,
    pub line_range: (usize, usize),
    pub range: (usize, usize),
    pub excerpt: String,
    pub hits: Vec<String>,
    pub regex: bool,
}

impl LexicalMatch {
    pub fn match_reason(&self) -> &'static str {
        if self.regex {
            "lexical_regex"
        } else {
            "lexical_exact"
        }
    }
}

pub struct LexicalResult {
    /// Files whose matching lines after the per-file bound were not examined.
    pub capped_files: Vec<String>,
    pub items: Vec<LexicalMatch>,
    /// Collection stopped at the total bound.
    pub truncated: bool,
}

const MAXIMUM_FILE_BYTES: u64 = 2 * 1024 * 1024;
// Listing files on ripgrep's command line had to fit Windows' 32,767-character limit.
const MAXIMUM_LISTED_PATH_CHARACTERS: usize = 24_000;

/// Searches `candidates` line by line, at most `maximum` lines in all and
/// `maximum_per_file` in one file.
pub fn search_lexically(
    files: &WorkspaceFiles,
    candidates: &[String],
    query: &TextQuery,
    maximum: usize,
    maximum_per_file: usize,
    signal: &Signal,
) -> Outcome<LexicalResult> {
    signal.check()?;
    if candidates.is_empty() {
        return Ok(LexicalResult {
            capped_files: Vec::new(),
            items: Vec::new(),
            truncated: false,
        });
    }
    let matcher = build_matcher(query)?;
    let listed_characters: usize = candidates.iter().map(|path| utf16_len(path) + 1).sum();
    let listed = listed_characters <= MAXIMUM_LISTED_PATH_CHARACTERS;
    let order: Vec<&String> = if listed {
        // ripgrep's size bound does not apply to files named on its command line.
        candidates
            .iter()
            .filter(|path| {
                files
                    .file_size(path)
                    .is_ok_and(|size| size <= MAXIMUM_FILE_BYTES)
            })
            .collect()
    } else {
        let mut walked: Vec<&String> = candidates.iter().collect();
        walked.sort_by(|left, right| walk_order(left, right));
        walked
    };
    let mut searcher = SearcherBuilder::new()
        .line_number(true)
        .max_matches(Some(maximum_per_file as u64))
        .binary_detection(if listed {
            BinaryDetection::convert(b'\x00')
        } else {
            BinaryDetection::quit(b'\x00')
        })
        .build();
    let mut items: Vec<LexicalMatch> = Vec::new();
    let mut truncated = false;
    for path in order {
        signal.check()?;
        let absolute = files.absolute(path);
        if !listed {
            match std::fs::symlink_metadata(&absolute) {
                Ok(metadata) if metadata.is_file() && metadata.len() <= MAXIMUM_FILE_BYTES => {}
                _ => continue,
            }
        }
        let mut sink = MatchSink {
            matcher: &matcher,
            path,
            query,
            items: &mut items,
            maximum,
            limited: false,
        };
        // --no-messages: unreadable files are skipped silently.
        let _ = searcher.search_path(&matcher, &absolute, &mut sink);
        if sink.limited {
            truncated = true;
            break;
        }
    }
    let capped_files = capped_files(&items, maximum_per_file);
    Ok(LexicalResult {
        capped_files,
        items,
        truncated,
    })
}

/// The order of a sorted directory walk: path components compared one by one.
fn walk_order(left: &str, right: &str) -> Ordering {
    left.split('/').cmp(right.split('/'))
}

fn build_matcher(query: &TextQuery) -> Outcome<RegexMatcher> {
    let mut builder = RegexMatcherBuilder::new();
    builder
        .multi_line(true)
        .unicode(true)
        .octal(false)
        .fixed_strings(!query.regex)
        .case_insensitive(!query.case_sensitive)
        .line_terminator(Some(b'\n'))
        .dot_matches_new_line(false)
        .ban_byte(Some(b'\x00'));
    builder
        .build_many(&[query.pattern.as_str()])
        .map_err(|error| {
            let stderr = format!("rg: {error}");
            if stderr.contains("regex parse error")
                || stderr.to_lowercase().contains("error parsing regex")
            {
                // `stderr.replace(/^.*?error:\s*/su, "").slice(0, 600)`.
                let rest = stderr
                    .find("error:")
                    .map(|index| stderr[index + 6..].trim_start_matches(crate::text::is_js_space))
                    .unwrap_or(&stderr);
                Failure::new(format!(
                    "Invalid regex for search_code (ripgrep syntax): {}",
                    utf16_prefix(rest, 600)
                ))
            } else {
                Failure::new(format!("ripgrep failed: {stderr}"))
            }
        })
}

struct MatchSink<'a> {
    matcher: &'a RegexMatcher,
    path: &'a str,
    query: &'a TextQuery,
    items: &'a mut Vec<LexicalMatch>,
    maximum: usize,
    limited: bool,
}

impl Sink for MatchSink<'_> {
    type Error = io::Error;

    fn matched(&mut self, _searcher: &Searcher, found: &SinkMatch<'_>) -> Result<bool, io::Error> {
        let line = found.bytes();
        // ripgrep matches a single line without its terminator (look-around
        // must not see it), and reports every match on it.
        let searched = line.strip_suffix(b"\n").unwrap_or(line);
        let mut submatches: Vec<(usize, usize)> = Vec::new();
        let _ = self.matcher.find_iter(searched, |found| {
            submatches.push((found.start(), found.end()));
            true
        });
        let valid: Vec<(usize, usize)> = submatches
            .into_iter()
            .filter(|(start, end)| end > start && *end <= line.len())
            .collect();
        let Some(first) = valid.first().copied() else {
            return Ok(true);
        };
        let (Some(line_number), offset) = (found.line_number(), found.absolute_byte_offset())
        else {
            return Ok(true);
        };
        let hits: Vec<String> = valid
            .iter()
            .map(|(start, end)| String::from_utf8_lossy(&line[*start..*end]).into_owned())
            .collect();
        let start_line = line_number as usize
            + line[..first.0]
                .iter()
                .filter(|byte| **byte == b'\n')
                .count();
        let first_hit = hits[0].clone();
        let line_content = String::from_utf8_lossy(line);
        self.items.push(LexicalMatch {
            path: self.path.to_string(),
            line_range: (
                start_line,
                start_line + first_hit.bytes().filter(|byte| *byte == b'\n').count(),
            ),
            range: (
                offset as usize + first.0,
                offset as usize + first.0 + first_hit.len(),
            ),
            excerpt: compact_line(&line_content),
            hits,
            regex: self.query.regex,
        });
        if self.items.len() >= self.maximum {
            self.limited = true;
            return Ok(false);
        }
        Ok(true)
    }
}

fn compact_line(value: &str) -> String {
    let compact = js_trim_end(strip_crlf_end(value));
    if utf16_len(compact) > 500 {
        format!("{}…", utf16_prefix(compact, 499))
    } else {
        compact.to_string()
    }
}

fn capped_files(items: &[LexicalMatch], maximum_per_file: usize) -> Vec<String> {
    let mut counts: Vec<(&str, usize)> = Vec::new();
    for item in items {
        match counts.iter_mut().find(|(path, _)| *path == item.path) {
            Some(entry) => entry.1 += 1,
            None => counts.push((&item.path, 1)),
        }
    }
    counts
        .into_iter()
        .filter(|(_, count)| *count >= maximum_per_file)
        .map(|(path, _)| path.to_string())
        .collect()
}

/// `value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")`.
pub fn escape_regex(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for character in value.chars() {
        if ".*+?^${}()|[]\\".contains(character) {
            output.push('\\');
        }
        output.push(character);
    }
    output
}

/// Escapes each `{` that does not open a repetition (`{n}`, `{n,}`, `{n,m}`
/// after something to repeat). ripgrep rejects those, while grep -E and
/// agents read them as the brace itself, as in `initializations: {`.
pub fn literal_braces(pattern: &str) -> String {
    let characters: Vec<char> = pattern.chars().collect();
    let mut output = String::new();
    let mut in_class = false;
    let mut repeatable = false;
    let mut index = 0;
    while index < characters.len() {
        let character = characters[index];
        if character == '\\' {
            output.extend(&characters[index..(index + 2).min(characters.len())]);
            index += 1;
            repeatable = true;
        } else if in_class {
            output.push(character);
            if character == ']' {
                in_class = false;
            }
        } else if character == '[' {
            // `/^\[\^?\]?/`: the opening, a negation and a literal first `]`.
            let mut opening = 1;
            if characters.get(index + opening) == Some(&'^') {
                opening += 1;
            }
            if characters.get(index + opening) == Some(&']') {
                opening += 1;
            }
            output.extend(&characters[index..index + opening]);
            index += opening - 1;
            in_class = true;
            repeatable = true;
        } else if character == '{' && !(repeatable && opens_repetition(&characters[index..])) {
            output.push_str("\\{");
            repeatable = true;
        } else {
            output.push(character);
            repeatable = character != '(' && character != '|';
        }
        index += 1;
    }
    output
}

/// `/^\{\d+(?:,\d*)?\}/`.
fn opens_repetition(rest: &[char]) -> bool {
    let mut index = 1;
    let digits = rest[index..]
        .iter()
        .take_while(|character| character.is_ascii_digit())
        .count();
    if digits == 0 {
        return false;
    }
    index += digits;
    if rest.get(index) == Some(&',') {
        index += 1;
        index += rest[index..]
            .iter()
            .take_while(|character| character.is_ascii_digit())
            .count();
    }
    rest.get(index) == Some(&'}')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn walks_in_directory_order() {
        let mut paths = vec!["a-c", "a/b", "a.ts", "a/a"];
        paths.sort_by(|left, right| walk_order(left, right));
        assert_eq!(paths, ["a/a", "a/b", "a-c", "a.ts"]);
    }

    #[test]
    fn escapes_literal_braces_only() {
        assert_eq!(literal_braces("initializations: {"), "initializations: \\{");
        assert_eq!(literal_braces("a{2,3}"), "a{2,3}");
        assert_eq!(literal_braces("{2}"), "\\{2}");
        assert_eq!(literal_braces("[{]x"), "[{]x");
        assert_eq!(escape_regex("a.b(c)"), "a\\.b\\(c\\)");
    }
}
