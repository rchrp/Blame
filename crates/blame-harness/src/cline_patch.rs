//! Cline's apply-patch parser (`computePatchChanges` in @cline/core 0.2.0),
//! ported as it is: `edit_code` hands it exact-context patches and refuses any
//! fuzz, so what matters is its parsing, its errors and its line rewriting.

use crate::failure::{Failure, Outcome};
use crate::pathx;
use crate::text::utf16_len;
use unicode_normalization::UnicodeNormalization;

const BEGIN: &str = "*** Begin Patch";
const END: &str = "*** End Patch";
const ADD: &str = "*** Add File: ";
const UPDATE: &str = "*** Update File: ";
const DELETE: &str = "*** Delete File: ";
const MOVE: &str = "*** Move to: ";
const END_FILE: &str = "*** End of File";

#[derive(Clone, Debug, PartialEq)]
pub enum ChangeKind {
    Add,
    Delete,
    Update,
}

#[derive(Clone, Debug)]
pub struct Change {
    pub kind: ChangeKind,
    pub old_content: Option<String>,
    pub new_content: Option<String>,
    pub move_path: Option<String>,
}

fn diff_error(message: impl Into<String>) -> Failure {
    Failure::new(message)
}

struct Chunk {
    orig_index: usize,
    del_lines: Vec<String>,
    ins_lines: Vec<String>,
}

enum Action {
    Add(String),
    Delete,
    Update {
        chunks: Vec<Chunk>,
        move_path: Option<String>,
    },
}

struct Warning {
    path: String,
    chunk_index: usize,
    message: String,
    context: String,
}

/// Lines without their `\r`.
fn split_lines(text: &str) -> Vec<String> {
    text.split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line).to_string())
        .collect()
}

fn is_wrapper(line: &str) -> bool {
    !line.trim().is_empty()
        && ["%%bash", "apply_patch", "EOF", "```"]
            .iter()
            .any(|prefix| line.starts_with(prefix))
}

fn patch_lines(text: &str) -> Outcome<Vec<String>> {
    let lines = split_lines(text);
    let begin = lines.iter().position(|line| line.starts_with(BEGIN));
    let end = lines.iter().rposition(|line| line.starts_with(END));
    if begin.is_some() || end.is_some() {
        return match (begin, end) {
            (Some(begin), Some(end)) if end >= begin => Ok(lines[begin..=end].to_vec()),
            _ => Err(diff_error(
                "Invalid patch text - incomplete sentinels. Try breaking it into smaller patches.",
            )),
        };
    }
    let (mut start, mut stop) = (0, lines.len());
    while start < stop && is_wrapper(&lines[start]) {
        start += 1;
    }
    while stop > start && is_wrapper(&lines[stop - 1]) {
        stop -= 1;
    }
    let mut body: Vec<String> = lines[start..stop].to_vec();
    while body.first().is_some_and(String::is_empty) {
        body.remove(0);
    }
    while body.last().is_some_and(String::is_empty) {
        body.pop();
    }
    let mut output = vec![BEGIN.to_string()];
    output.extend(body);
    output.push(END.to_string());
    Ok(output)
}

fn paths_with(lines: &[String], prefixes: &[&str]) -> Vec<String> {
    let mut paths: Vec<String> = Vec::new();
    for line in lines {
        if let Some(prefix) = prefixes.iter().find(|prefix| line.starts_with(**prefix)) {
            let path = crate::text::js_trim(&line[prefix.len()..]).to_string();
            if !paths.contains(&path) {
                paths.push(path);
            }
        }
    }
    paths
}

fn resolve_path(root: &str, path: &str) -> Outcome<String> {
    if pathx::is_absolute(path) {
        return Ok(pathx::resolve("/", path));
    }
    let resolved = pathx::resolve(root, path);
    let local = pathx::relative(root, &resolved);
    if local.starts_with("..") || pathx::is_absolute(&local) {
        return Err(diff_error(format!("Path must stay within cwd: {path}")));
    }
    Ok(resolved)
}

/// `Nt`: NFC, typographic dashes, quotes and spaces as ASCII, unescaped quotes.
fn normalize(value: &str) -> String {
    let mapped: String = value
        .nfc()
        .map(|character| match character {
            '\u{2010}' | '\u{2011}' | '\u{2012}' | '\u{2013}' | '\u{2014}' | '\u{2212}' => '-',
            '\u{201c}' | '\u{201d}' | '\u{201e}' | '\u{ab}' | '\u{bb}' => '"',
            '\u{2018}' | '\u{2019}' | '\u{201b}' => '\'',
            '\u{a0}' | '\u{202f}' => ' ',
            other => other,
        })
        .collect();
    mapped
        .replace("\\`", "`")
        .replace("\\'", "'")
        .replace("\\\"", "\"")
}

/// Levenshtein distance in UTF-16 units, as `Cj`.
fn distance(shorter: &[u16], longer: &[u16]) -> usize {
    let mut previous: Vec<usize> = (0..=shorter.len()).collect();
    for (row, unit) in longer.iter().enumerate() {
        let mut current = vec![row + 1; shorter.len() + 1];
        for column in 1..=shorter.len() {
            current[column] = if *unit == shorter[column - 1] {
                previous[column - 1]
            } else {
                1 + previous[column - 1]
                    .min(current[column - 1])
                    .min(previous[column])
            };
        }
        previous = current;
    }
    previous[shorter.len()]
}

fn similarity(left: &str, right: &str) -> f64 {
    let (left, right): (Vec<u16>, Vec<u16>) = (
        left.encode_utf16().collect(),
        right.encode_utf16().collect(),
    );
    let (longer, shorter) = if left.len() > right.len() {
        (left, right)
    } else {
        (right, left)
    };
    if longer.is_empty() {
        return 1.0;
    }
    (longer.len() - distance(&shorter, &longer)) as f64 / longer.len() as f64
}

/// `kj`: where `context` matches in `lines` from `start`, with its fuzz.
fn find_context(
    lines: &[String],
    context: &[String],
    start: usize,
    eof: bool,
) -> (Option<usize>, f64, f64) {
    if context.is_empty() {
        return (Some(start), 0.0, 1.0);
    }
    let mut best: f64 = 0.0;
    let mut search = |from: usize| -> (Option<usize>, f64, f64) {
        let window = |at: usize, map: &dyn Fn(&String) -> String| -> String {
            lines[at.min(lines.len())..(at + context.len()).min(lines.len())]
                .iter()
                .map(map)
                .collect::<Vec<_>>()
                .join("\n")
        };
        let expected = normalize(&context.join("\n"));
        for at in from..lines.len() {
            let current = normalize(&window(at, &|line| line.clone()));
            if current == expected {
                return (Some(at), 0.0, 1.0);
            }
            best = best.max(similarity(&current, &expected));
        }
        let trimmed_end = normalize(
            &context
                .iter()
                .map(|line| crate::text::js_trim_end(line).to_string())
                .collect::<Vec<_>>()
                .join("\n"),
        );
        for at in from..lines.len() {
            if normalize(&window(at, &|line| {
                crate::text::js_trim_end(line).to_string()
            })) == trimmed_end
            {
                return (Some(at), 1.0, 1.0);
            }
        }
        let trimmed = normalize(
            &context
                .iter()
                .map(|line| crate::text::js_trim(line).to_string())
                .collect::<Vec<_>>()
                .join("\n"),
        );
        for at in from..lines.len() {
            if normalize(&window(at, &|line| crate::text::js_trim(line).to_string())) == trimmed {
                return (Some(at), 100.0, 1.0);
            }
        }
        for at in from..lines.len() {
            let score = similarity(&normalize(&window(at, &|line| line.clone())), &expected);
            if score >= 0.66 {
                return (Some(at), 1000.0, score);
            }
            best = best.max(score);
        }
        (None, 0.0, best)
    };
    if eof {
        let found = search(lines.len().saturating_sub(context.len()));
        if found.0.is_some() {
            return found;
        }
        let (at, fuzz, score) = search(start);
        return (at, fuzz + 1e4, score);
    }
    search(start)
}

/// `Pj`: the next section's context lines, chunks, end index and EOF marker.
fn peek_section(lines: &[String], start: usize) -> Outcome<(Vec<String>, Vec<Chunk>, usize, bool)> {
    let mut index = start;
    let mut context: Vec<String> = Vec::new();
    let mut deleted: Vec<String> = Vec::new();
    let mut inserted: Vec<String> = Vec::new();
    let mut chunks = Vec::new();
    let mut mode = "keep";
    let stops = [
        "@@",
        END,
        UPDATE.trim(),
        DELETE.trim(),
        ADD.trim(),
        END_FILE,
    ];
    while index < lines.len() {
        let line = &lines[index];
        if line.is_empty() || stops.iter().any(|stop| line.starts_with(stop)) {
            break;
        }
        if line == "***" {
            break;
        }
        if line.starts_with("***") {
            return Err(diff_error(format!("Invalid line: {line}")));
        }
        index += 1;
        let previous = mode;
        let mut text = line.clone();
        mode = match text.chars().next() {
            Some('+') => "add",
            Some('-') => "delete",
            Some(' ') => "keep",
            _ => {
                text = format!(" {text}");
                "keep"
            }
        };
        let text = text[1..].to_string();
        if mode == "keep" && previous != mode {
            if !inserted.is_empty() || !deleted.is_empty() {
                chunks.push(Chunk {
                    orig_index: context.len() - deleted.len(),
                    del_lines: deleted,
                    ins_lines: inserted,
                });
            }
            deleted = Vec::new();
            inserted = Vec::new();
        }
        match mode {
            "delete" => {
                deleted.push(text.clone());
                context.push(text);
            }
            "add" => inserted.push(text),
            _ => context.push(text),
        }
    }
    if !inserted.is_empty() || !deleted.is_empty() {
        chunks.push(Chunk {
            orig_index: context.len() - deleted.len(),
            del_lines: deleted,
            ins_lines: inserted,
        });
    }
    if index < lines.len() && lines[index] == END_FILE {
        return Ok((context, chunks, index + 1, true));
    }
    Ok((context, chunks, index, false))
}

struct Parser<'a> {
    lines: &'a [String],
    files: &'a [(String, String)],
    actions: Vec<(String, Action)>,
    warnings: Vec<Warning>,
    index: usize,
    fuzz: f64,
}

impl Parser<'_> {
    fn line(&self) -> Option<&str> {
        self.lines.get(self.index).map(String::as_str)
    }

    fn file(&self, path: &str) -> Option<&str> {
        self.files
            .iter()
            .find(|(known, _)| known == path)
            .map(|(_, content)| content.as_str())
    }

    fn parse(&mut self) -> Outcome<()> {
        if self.line().is_some_and(|line| line.starts_with(BEGIN)) {
            self.index += 1;
        }
        while self.index < self.lines.len()
            && !self.line().is_some_and(|line| line.starts_with(END))
        {
            let line = self.line().unwrap_or("").to_string();
            if let Some(path) = line.strip_prefix(UPDATE) {
                self.parse_update(crate::text::js_trim(path).to_string())?;
            } else if let Some(path) = line.strip_prefix(DELETE) {
                self.parse_delete(crate::text::js_trim(path).to_string())?;
            } else if let Some(path) = line.strip_prefix(ADD) {
                self.parse_add(crate::text::js_trim(path).to_string())?;
            } else {
                return Err(diff_error(format!("Unknown line while parsing: {line}")));
            }
        }
        Ok(())
    }

    fn check_duplicate(&self, path: &str, kind: &str) -> Outcome<()> {
        if self.actions.iter().any(|(known, _)| known == path) {
            return Err(diff_error(format!("Duplicate {kind} for file: {path}")));
        }
        Ok(())
    }

    fn parse_update(&mut self, path: String) -> Outcome<()> {
        self.check_duplicate(&path, "update")?;
        self.index += 1;
        let move_path = if self.line().is_some_and(|line| line.starts_with(MOVE)) {
            let line = self.line().unwrap_or("").to_string();
            self.index += 1;
            Some(crate::text::js_trim(&line[MOVE.len()..]).to_string())
        } else {
            None
        };
        let Some(content) = self.file(&path).map(str::to_string) else {
            return Err(diff_error(format!(
                "Update File Error: Missing File: {path}"
            )));
        };
        let chunks = self.parse_update_file(&content, &path)?;
        self.actions
            .push((path, Action::Update { chunks, move_path }));
        Ok(())
    }

    fn parse_update_file(&mut self, content: &str, path: &str) -> Outcome<Vec<Chunk>> {
        let source: Vec<String> = content.split('\n').map(str::to_string).collect();
        let mut chunks: Vec<Chunk> = Vec::new();
        let mut cursor = 0usize;
        let stops = [END, UPDATE.trim(), DELETE.trim(), ADD.trim(), END_FILE];
        let mut guard = 0;
        while !self
            .line()
            .is_some_and(|line| stops.iter().any(|stop| line.starts_with(stop)))
        {
            guard += 1;
            if guard > self.lines.len() + 1 {
                // The TypeScript parser loops forever on a bare `***` here.
                return Err(diff_error(format!(
                    "Invalid line: {}",
                    self.line().unwrap_or("")
                )));
            }
            let line = self.line().map(str::to_string);
            let anchor = line
                .as_deref()
                .and_then(|line| line.strip_prefix("@@ "))
                .map(str::to_string);
            if anchor.is_some() || line.as_deref() == Some("@@") {
                self.index += 1;
            } else if cursor != 0 {
                return Err(diff_error(format!(
                    "Invalid Line:\n{}",
                    line.unwrap_or_default()
                )));
            }
            if let Some(anchor) = anchor
                .as_deref()
                .map(crate::text::js_trim)
                .filter(|anchor| !anchor.is_empty())
            {
                let wanted = normalize(anchor);
                for (index, candidate) in source.iter().enumerate().skip(cursor) {
                    if !candidate.is_empty()
                        && (normalize(candidate) == wanted
                            || normalize(crate::text::js_trim(candidate)) == wanted)
                    {
                        cursor = index + 1;
                        if normalize(crate::text::js_trim(candidate)) == wanted
                            && normalize(candidate) != wanted
                        {
                            self.fuzz += 1.0;
                        }
                        break;
                    }
                }
            }
            let (context, section, next, eof) = peek_section(self.lines, self.index)?;
            let (found, fuzz, score) = find_context(&source, &context, cursor, eof);
            match found {
                None => {
                    let text = context.join("\n");
                    let context = if utf16_len(&text) > 200 {
                        format!("{}...", crate::text::utf16_prefix(&text, 200))
                    } else {
                        text
                    };
                    self.warnings.push(Warning {
                        path: path.to_string(),
                        chunk_index: chunks.len(),
                        message: format!(
                            "Could not find matching context (similarity: {}). Chunk skipped.",
                            crate::fold::to_fixed(score, 2)
                        ),
                        context,
                    });
                    self.index = next;
                }
                Some(at) => {
                    self.fuzz += fuzz;
                    for mut chunk in section {
                        chunk.orig_index += at;
                        chunks.push(chunk);
                    }
                    cursor = at + context.len();
                    self.index = next;
                }
            }
        }
        Ok(chunks)
    }

    fn parse_delete(&mut self, path: String) -> Outcome<()> {
        self.check_duplicate(&path, "delete")?;
        if self.file(&path).is_none() {
            return Err(diff_error(format!(
                "Delete File Error: Missing File: {path}"
            )));
        }
        self.actions.push((path, Action::Delete));
        self.index += 1;
        Ok(())
    }

    fn parse_add(&mut self, path: String) -> Outcome<()> {
        self.check_duplicate(&path, "add")?;
        if self.file(&path).is_some() {
            return Err(diff_error(format!(
                "Add File Error: File already exists: {path}"
            )));
        }
        self.index += 1;
        let stops = [END, UPDATE.trim(), DELETE.trim(), ADD.trim()];
        let mut added = Vec::new();
        while self.index < self.lines.len()
            && !self
                .line()
                .is_some_and(|line| stops.iter().any(|stop| line.starts_with(stop)))
        {
            let line = self.lines[self.index].clone();
            self.index += 1;
            let Some(text) = line.strip_prefix('+') else {
                return Err(diff_error(format!(
                    "Invalid Add File line (missing '+'): {line}"
                )));
            };
            added.push(text.to_string());
        }
        self.actions.push((path, Action::Add(added.join("\n"))));
        Ok(())
    }
}

/// `Ej`: the file's lines with each chunk applied.
fn apply_chunks(content: &str, chunks: &[Chunk], path: &str) -> Outcome<String> {
    if chunks.is_empty() {
        return Ok(content.to_string());
    }
    let lines: Vec<&str> = content.split('\n').collect();
    let mut output: Vec<String> = Vec::new();
    let mut index = 0;
    for chunk in chunks {
        if chunk.orig_index > lines.len() {
            return Err(diff_error(format!(
                "{path}: chunk.origIndex {} > lines.length {}",
                chunk.orig_index,
                lines.len()
            )));
        }
        if index > chunk.orig_index {
            return Err(diff_error(format!(
                "{path}: currentIndex {index} > chunk.origIndex {}",
                chunk.orig_index
            )));
        }
        output.extend(
            lines[index..chunk.orig_index]
                .iter()
                .map(|line| line.to_string()),
        );
        output.extend(chunk.ins_lines.iter().cloned());
        index = chunk.orig_index + chunk.del_lines.len();
    }
    output.extend(
        lines[index.min(lines.len())..]
            .iter()
            .map(|line| line.to_string()),
    );
    Ok(output.join("\n"))
}

/// `computePatchChanges(patch, root, { restrictToCwd: true })`: each file's
/// change and the fuzz the parser needed.
pub fn compute_patch_changes(patch: &str, root: &str) -> Outcome<(Vec<(String, Change)>, f64)> {
    let lines = patch_lines(patch)?;
    let mut files: Vec<(String, String)> = Vec::new();
    let mut eols: Vec<(String, &'static str)> = Vec::new();
    for path in paths_with(&lines, &[UPDATE, DELETE]) {
        let absolute = resolve_path(root, &path)?;
        let Ok(bytes) = std::fs::read(&absolute) else {
            return Err(diff_error(format!("File not found: {path}")));
        };
        let content = String::from_utf8_lossy(&bytes).into_owned();
        eols.push((
            path.clone(),
            if content.contains("\r\n") {
                "\r\n"
            } else {
                "\n"
            },
        ));
        files.push((path, content.replace("\r\n", "\n")));
    }
    for path in paths_with(&lines, &[ADD]) {
        let absolute = resolve_path(root, &path)?;
        if let Ok(bytes) = std::fs::read(&absolute) {
            files.push((path, String::from_utf8_lossy(&bytes).into_owned()));
        }
    }
    let mut parser = Parser {
        lines: &lines,
        files: &files,
        actions: Vec::new(),
        warnings: Vec::new(),
        index: 0,
        fuzz: 0.0,
    };
    parser.parse()?;
    if !parser.warnings.is_empty() {
        let count = parser.warnings.len();
        let mut message = vec![format!(
            "Patch could not be applied because {count} hunk{} did not match the current file content.",
            if count == 1 { "" } else { "s" }
        )];
        for warning in &parser.warnings {
            message.push(format!(
                "{}: hunk {}: {}",
                warning.path,
                warning.chunk_index + 1,
                warning.message
            ));
            if !warning.context.is_empty() {
                message.push(format!("Context:\n{}", warning.context));
            }
        }
        return Err(diff_error(message.join("\n")));
    }
    let with_eol = |path: &str, content: &str| {
        let eol = eols
            .iter()
            .find(|(known, _)| known == path)
            .map_or("\n", |(_, eol)| *eol);
        content.split('\n').collect::<Vec<_>>().join(eol)
    };
    let mut changes = Vec::new();
    for (path, action) in parser.actions {
        let old = files
            .iter()
            .find(|(known, _)| *known == path)
            .map(|(_, content)| content.clone());
        let change = match action {
            Action::Delete => Change {
                kind: ChangeKind::Delete,
                old_content: old.map(|content| with_eol(&path, &content)),
                new_content: None,
                move_path: None,
            },
            // `al`: the OS line ending; on POSIX the content is unchanged.
            Action::Add(content) => Change {
                kind: ChangeKind::Add,
                old_content: None,
                new_content: Some(content),
                move_path: None,
            },
            Action::Update { chunks, move_path } => {
                let new = apply_chunks(old.as_deref().unwrap_or(""), &chunks, &path)?;
                Change {
                    kind: ChangeKind::Update,
                    old_content: old.map(|content| with_eol(&path, &content)),
                    new_content: Some(with_eol(&path, &new)),
                    move_path,
                }
            }
        };
        changes.push((path, change));
    }
    Ok((changes, parser.fuzz))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_typographic_characters() {
        assert_eq!(normalize("a — “b” ‘c’\u{a0}\\`"), "a - \"b\" 'c' `");
    }

    #[test]
    fn measures_similarity_like_levenshtein() {
        assert_eq!(similarity("kitten", "sitting"), 4.0 / 7.0);
        assert_eq!(similarity("", ""), 1.0);
    }
}
