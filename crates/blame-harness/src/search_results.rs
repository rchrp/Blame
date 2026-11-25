//! search_code ranking, pages and result shapes (`light-search-results.ts`).

use crate::failure::{Failure, Outcome};
use crate::files::WorkspaceFiles;
use crate::json::Json;
use crate::lexical::{LexicalMatch, TextQuery, escape_regex, literal_braces};
use crate::obj;
use crate::syntax::ParsedSymbol;
use crate::text::{js_trim, locale_compare, lower, split_spaces, utf16_len, utf16_prefix};
use regex::Regex;
use std::sync::LazyLock;
use unicode_normalization::UnicodeNormalization;

pub const DEFAULT_MATCH_LIMIT: usize = 8;
pub const DEFAULT_FILE_LIMIT: usize = 50;
const MAXIMUM_CONTEXT_LINE_CHARACTERS: usize = 240;
// One page of matches stays readable in a single result; large context or
// limit values continue on the next page instead.
const MAXIMUM_PAGE_CHARACTERS: usize = 40_000;

/// The search input as the caller sent it (`nextSearch` echoes it), and the
/// grep translations of a routed shell inspection that the model-facing
/// schema does not expose (`CodeSearchRequest`).
#[derive(Clone, Debug)]
pub struct SearchInput {
    pub raw: Json,
    pub context_before: Option<usize>,
    pub context_after: Option<usize>,
    /// Drops presented lines, like `| grep -v` applied to grep's
    /// `path:line:text` output: any of these patterns.
    pub exclude: Vec<regex::Regex>,
}

impl SearchInput {
    /// Takes `contextBefore`, `contextAfter` and `excludeLines`
    /// (`[{ "source", "ignoreCase" }]`) out of the input.
    pub fn new(input: &Json) -> SearchInput {
        let mut raw = input.clone();
        let count = |value: Option<Json>| {
            value
                .and_then(|value| value.as_f64())
                .map(|value| value as usize)
        };
        let context_before = count(raw.remove("contextBefore"));
        let context_after = count(raw.remove("contextAfter"));
        let exclude = raw
            .remove("excludeLines")
            .and_then(|value| value.as_array().cloned())
            .unwrap_or_default()
            .iter()
            .filter_map(|pattern| {
                let source = pattern.get("source").and_then(Json::as_str)?;
                let ignore_case = pattern
                    .get("ignoreCase")
                    .and_then(Json::as_bool)
                    .unwrap_or(false);
                regex::RegexBuilder::new(source)
                    .case_insensitive(ignore_case)
                    .build()
                    .ok()
            })
            .collect();
        SearchInput {
            raw,
            context_before,
            context_after,
            exclude,
        }
    }

    pub fn excluded(&self, line: &str) -> bool {
        self.exclude.iter().any(|pattern| pattern.is_match(line))
    }

    pub fn query(&self) -> &str {
        self.raw.get("query").and_then(Json::as_str).unwrap_or("")
    }
    pub fn mode(&self) -> Option<&str> {
        self.raw.get("mode").and_then(Json::as_str)
    }
    pub fn output(&self) -> Option<&str> {
        self.raw.get("output").and_then(Json::as_str)
    }
    pub fn case_sensitive(&self) -> bool {
        self.raw
            .get("caseSensitive")
            .and_then(Json::as_bool)
            .unwrap_or(false)
    }
    pub fn context(&self) -> Option<usize> {
        self.raw
            .get("context")
            .and_then(Json::as_f64)
            .map(|value| value as usize)
    }
    pub fn scope(&self) -> Option<&Json> {
        self.raw
            .get("scope")
            .filter(|scope| !matches!(scope, Json::Null))
    }
    pub fn with_query(&self, query: &str) -> SearchInput {
        let mut raw = self.raw.clone();
        raw.set("query", query);
        SearchInput {
            raw,
            ..self.clone()
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SearchPage {
    pub limit: usize,
    pub offset: usize,
}

#[derive(Default, Clone)]
pub struct SearchMore {
    pub capped_files: Vec<String>,
    pub has_more: bool,
    pub sized: bool,
    pub truncated: bool,
}

static IDENTIFIER_QUERY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[\p{L}_$][\p{L}\p{N}_$.-]*$").expect("pattern"));

pub fn search_mode(input: &SearchInput) -> String {
    match input.mode() {
        Some(mode @ ("references" | "regex")) => mode.into(),
        Some(mode) if mode != "auto" => mode.into(),
        _ => if IDENTIFIER_QUERY.is_match(input.query()) {
            "symbol"
        } else {
            "text"
        }
        .into(),
    }
}

pub fn search_page(input: &SearchInput) -> SearchPage {
    let output = input.output().unwrap_or("matches");
    let default = if output == "matches" {
        DEFAULT_MATCH_LIMIT
    } else {
        DEFAULT_FILE_LIMIT
    };
    SearchPage {
        limit: input
            .raw
            .get("limit")
            .and_then(Json::as_f64)
            .map_or(default, |value| value as usize),
        offset: input
            .raw
            .get("offset")
            .and_then(Json::as_f64)
            .map_or(0, |value| value as usize),
    }
}

fn unique_strings(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut output: Vec<String> = Vec::new();
    for value in values {
        if !output.contains(&value) {
            output.push(value);
        }
    }
    output
}

/// Whitespace separates OR terms; punctuation inside a term stays literal.
pub fn search_terms(query: &str) -> Vec<String> {
    let normalized: String = query.nfkc().collect();
    let lowered = lower(&normalized);
    let mut terms = unique_strings(split_spaces(&lowered).into_iter().map(str::to_string));
    terms.truncate(12);
    terms
}

pub fn lexical_query(query: &str, mode: &str, case_sensitive: bool) -> TextQuery {
    if mode == "regex" {
        return TextQuery {
            pattern: literal_braces(query),
            regex: true,
            case_sensitive,
        };
    }
    let terms = if case_sensitive {
        let mut terms = unique_strings(split_spaces(query).into_iter().map(str::to_string));
        terms.truncate(12);
        terms
    } else {
        search_terms(query)
    };
    if terms.len() < 2 {
        return TextQuery {
            pattern: query.to_string(),
            regex: false,
            case_sensitive,
        };
    }
    // The whole query comes first: a line holding it reads it as one hit
    // (the only hit with a space), and its file ranks first (`file_score`).
    let phrase = split_spaces(query)
        .into_iter()
        .map(escape_regex)
        .collect::<Vec<_>>()
        .join("[ \\t]+");
    TextQuery {
        pattern: std::iter::once(phrase)
            .chain(terms.iter().map(|term| escape_regex(term)))
            .collect::<Vec<_>>()
            .join("|"),
        regex: true,
        case_sensitive,
    }
}

pub struct FileHits {
    pub path: String,
    pub matches: Vec<LexicalMatch>,
    pub score: usize,
}

/// Groups matching lines by file. Text searches rank files by how many
/// distinct terms they contain, then by terms in the path and hit count;
/// regex searches keep grep's path order.
pub fn ranked_files(matches: &[LexicalMatch], terms: &[String], relevance: bool) -> Vec<FileHits> {
    let mut by_path: Vec<(String, Vec<LexicalMatch>)> = Vec::new();
    for found in matches {
        match by_path.iter_mut().find(|(path, _)| *path == found.path) {
            Some(entry) => entry.1.push(found.clone()),
            None => by_path.push((found.path.clone(), vec![found.clone()])),
        }
    }
    let mut files: Vec<FileHits> = by_path
        .into_iter()
        .map(|(path, mut file_matches)| {
            file_matches.sort_by_key(|found| found.line_range.0);
            let score = if relevance {
                file_score(&path, &file_matches, terms)
            } else {
                0
            };
            FileHits {
                path,
                matches: file_matches,
                score,
            }
        })
        .collect();
    files.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| locale_compare(&left.path, &right.path))
    });
    files
}

fn file_score(path: &str, matches: &[LexicalMatch], terms: &[String]) -> usize {
    let mut found: Vec<&String> = Vec::new();
    for item in matches {
        for term in matched_terms(item, terms) {
            if !found.contains(&term) {
                found.push(term);
            }
        }
    }
    let normalized = lower(path);
    let path_terms = terms
        .iter()
        .filter(|term| normalized.contains(term.as_str()))
        .count();
    // A file holding the whole query outranks files holding its words apart.
    let phrase = terms.len() > 1
        && matches
            .iter()
            .any(|item| item.hits.iter().any(|hit| hit.contains([' ', '\t'])));
    usize::from(phrase) * 1_000_000 + found.len() * 1_000 + path_terms * 100 + matches.len().min(99)
}

fn matched_terms<'t>(found: &LexicalMatch, terms: &'t [String]) -> Vec<&'t String> {
    let hits: Vec<String> = found.hits.iter().map(|hit| lower(hit)).collect();
    terms
        .iter()
        .filter(|term| hits.iter().any(|hit| hit.contains(term.as_str())))
        .collect()
}

/// Relevance order shows the best two lines of every ranked file before the
/// remaining lines, so one busy file cannot hide the others; path order
/// lists every line file by file. For a query of several words, lines
/// holding more of them come first across files: lines sharing one common
/// word (an import) filled the page before the lines that held the query
/// (US-110, 2026-11-26).
pub fn ordered_matches(files: &[FileHits], terms: &[String], relevance: bool) -> Vec<LexicalMatch> {
    if !relevance {
        return files
            .iter()
            .flat_map(|file| file.matches.iter().cloned())
            .collect();
    }
    let mut leading: Vec<(usize, usize)> = Vec::new();
    for (file_index, file) in files.iter().enumerate() {
        let mut order: Vec<usize> = (0..file.matches.len()).collect();
        order.sort_by(|left, right| {
            let (left_match, right_match) = (&file.matches[*left], &file.matches[*right]);
            matched_terms(right_match, terms)
                .len()
                .cmp(&matched_terms(left_match, terms).len())
                .then_with(|| left_match.line_range.0.cmp(&right_match.line_range.0))
        });
        leading.extend(
            order
                .into_iter()
                .take(2)
                .map(|match_index| (file_index, match_index)),
        );
    }
    let mut output: Vec<LexicalMatch> = leading
        .iter()
        .map(|(file, index)| files[*file].matches[*index].clone())
        .collect();
    for (file_index, file) in files.iter().enumerate() {
        for (match_index, found) in file.matches.iter().enumerate() {
            if !leading.contains(&(file_index, match_index)) {
                output.push(found.clone());
            }
        }
    }
    if terms.len() > 1 {
        // Stable: within as many words, the file order above stays.
        output.sort_by_cached_key(|found| std::cmp::Reverse(matched_terms(found, terms).len()));
    }
    output
}

/// grep-like context: `12:` marks the matching line, `11-` a surrounding one.
pub fn context_excerpt(source: &str, line: usize, before: usize, after: usize) -> String {
    let lines: Vec<&str> = source
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect();
    let first = 1.max(line.saturating_sub(before));
    let last = lines.len().min(line + after);
    let mut excerpt = Vec::new();
    for current in first..=last {
        let text = lines.get(current - 1).copied().unwrap_or("");
        let bounded = if utf16_len(text) > MAXIMUM_CONTEXT_LINE_CHARACTERS {
            format!(
                "{}…",
                utf16_prefix(text, MAXIMUM_CONTEXT_LINE_CHARACTERS - 1)
            )
        } else {
            text.to_string()
        };
        excerpt.push(format!(
            "{current}{}{bounded}",
            if current == line { ":" } else { "-" }
        ));
    }
    excerpt.join("\n")
}

pub fn search_envelope(
    input: &SearchInput,
    mode: &str,
    engine: &str,
    results: Vec<Json>,
    candidates: usize,
    more: SearchMore,
) -> Json {
    let mut results = results;
    without_repeated_context(&mut results);
    let page = search_page(input);
    let total = results.len();
    let shown = within_characters(results, MAXIMUM_PAGE_CHARACTERS);
    let sized = shown.len() < total;
    let shown_count = shown.len();
    let mut data = obj! {
        "mode" => mode,
        "engine" => engine,
        "results" => Json::Arr(shown),
        "candidateCount" => candidates,
    };
    let more = if sized {
        SearchMore {
            has_more: true,
            sized: true,
            ..more
        }
    } else {
        more
    };
    data.extend(limit_data(input, page, &more, shown_count));
    obj! { "status" => "ok", "data" => data }
}
/// Context lines an earlier match of the same file already shows are left
/// out, as grep merges overlapping context. A match whose context still
/// holds its own line (`12:`) needs no snippet; one whose context was all
/// shown keeps only its snippet.
fn without_repeated_context(results: &mut [Json]) {
    let mut shown: std::collections::HashMap<String, std::collections::HashSet<usize>> =
        std::collections::HashMap::new();
    for result in results.iter_mut() {
        let Some(context) = result
            .get("context")
            .and_then(Json::as_str)
            .map(str::to_string)
        else {
            continue;
        };
        let path = result
            .get("path")
            .and_then(Json::as_str)
            .unwrap_or("")
            .to_string();
        let seen = shown.entry(path).or_default();
        let mut kept: Vec<&str> = Vec::new();
        let mut holds_match = false;
        for line in context.split('\n') {
            let numbered = line
                .find([':', '-'])
                .and_then(|end| Some((end, line[..end].parse::<usize>().ok()?)));
            if let Some((end, number)) = numbered {
                if !seen.insert(number) {
                    continue;
                }
                holds_match |= line.as_bytes()[end] == b':';
            }
            kept.push(line);
        }
        if kept.is_empty() {
            result.remove("context");
            continue;
        }
        if holds_match {
            result.remove("snippet");
        }
        result.set("context", kept.join("\n"));
    }
}

/// The leading results whose JSON fits the budget, and always the first.
fn within_characters(results: Vec<Json>, budget: usize) -> Vec<Json> {
    let mut used = 0;
    let mut kept = Vec::new();
    for result in results {
        used += utf16_len(&result.stringify());
        if !kept.is_empty() && used > budget {
            break;
        }
        kept.push(result);
    }
    kept
}

pub fn limit_data(input: &SearchInput, page: SearchPage, more: &SearchMore, shown: usize) -> Json {
    let capped = &more.capped_files;
    if !more.has_more && !more.truncated && capped.is_empty() {
        return if shown > 0 || page.offset > 0 {
            Json::obj()
        } else {
            obj! { "guidance" => "No match in the selected scope." }
        };
    }
    let mut notes: Vec<String> = Vec::new();
    if more.sized {
        notes.push("This page reached its size limit: call nextSearch for the following matches, or lower context.".into());
    } else if more.has_more {
        notes.push("Result limit reached: call nextSearch for the next page, raise limit, or use output \"files\" to list every matching file.".into());
    }
    if more.truncated {
        notes.push("Collection stopped at the scan bound, so later matching lines were not ranked; narrow the query or scope.".into());
    }
    if !capped.is_empty() {
        let named = capped
            .iter()
            .take(3)
            .cloned()
            .collect::<Vec<_>>()
            .join(", ");
        let rest = if capped.len() > 3 {
            format!(" and {} more files", capped.len() - 3)
        } else {
            String::new()
        };
        notes.push(format!(
            "Matching lines past the per-file bound were not examined in {named}{rest}."
        ));
    }
    let mut data = obj! { "limited" => true };
    if more.has_more {
        let mut next = input.raw.clone();
        next.set("offset", page.offset + shown);
        data.set("nextSearch", next);
    }
    data.set("guidance", notes.join(" "));
    data
}

pub fn search_result_key(value: &Json) -> String {
    let path = value
        .get("path")
        .map(js_string)
        .unwrap_or_else(|| "undefined".into());
    let name = match value.get("qualifiedName") {
        Some(Json::Null) | None => value
            .get("lines")
            .map(js_string)
            .unwrap_or_else(|| "undefined".into()),
        Some(name) => js_string(name),
    };
    format!("{path}:{name}")
}

/// `${value}` in a template literal.
fn js_string(value: &Json) -> String {
    match value {
        Json::Str(text) => text.clone(),
        Json::Arr(values) => values.iter().map(js_string).collect::<Vec<_>>().join(","),
        Json::Null => "null".into(),
        Json::Obj(_) => "[object Object]".into(),
        other => other.stringify(),
    }
}

pub fn unique_search_results(results: Vec<Json>) -> Vec<Json> {
    let mut seen: Vec<String> = Vec::new();
    results
        .into_iter()
        .filter(|value| {
            let key = search_result_key(value);
            if seen.contains(&key) {
                return false;
            }
            seen.push(key);
            true
        })
        .collect()
}

pub fn search_symbol_result(alias: &str, path: &str, symbol: &ParsedSymbol, reason: &str) -> Json {
    obj! {
        "alias" => alias,
        "path" => path,
        "lines" => Json::from(symbol.line_range),
        "kind" => symbol.kind,
        "qualifiedName" => symbol.qualified_name.as_str(),
        "signature" => symbol.signature.as_str(),
        "reason" => reason,
    }
}

pub fn auto_symbol_candidates(
    text_results: &[Json],
    candidates: &[String],
    query: &str,
) -> Vec<String> {
    let matching: Vec<&str> = text_results
        .iter()
        .filter_map(|value| value.get("path").and_then(Json::string_value))
        .collect();
    if !matching.is_empty() {
        return candidates
            .iter()
            .filter(|path| matching.contains(&path.as_str()))
            .cloned()
            .collect();
    }
    if query.contains('.') {
        candidates.to_vec()
    } else {
        Vec::new()
    }
}

static LITERAL_FILE_FORBIDDEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[\s*?{}\[\]#]").expect("pattern"));
static LITERAL_FILE_EXTENSION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\.(?:[cm]?[jt]sx?|json|ya?ml|toml|md|py|rs|go|java|c|cpp|h|hpp|vue|svelte)$")
        .expect("pattern")
});

/// Paths named by the query. A multi-term query only names a path that
/// contains every term: a single shared word such as a folder name is no
/// evidence of relevance and must not crowd out content matches.
pub fn path_matches(query: &str, candidates: &[String], limit: usize) -> Vec<String> {
    if std::env::var("BLAME_AGENT_LITERAL_FILE_SEARCH")
        .ok()
        .as_deref()
        != Some("false")
        && literal_file_query(query)
    {
        let literal = lower(query.strip_prefix("./").unwrap_or(query));
        let suffix = if literal.starts_with('.') {
            literal.clone()
        } else {
            format!(".{literal}")
        };
        let mut found: Vec<&String> = candidates
            .iter()
            .filter(|path| {
                let normalized = lower(path);
                normalized == literal
                    || normalized.ends_with(&format!("/{literal}"))
                    || (!literal.contains('/')
                        && normalized
                            .rsplit('/')
                            .next()
                            .unwrap_or("")
                            .ends_with(&suffix))
            })
            .collect();
        found.sort_by(|left, right| {
            let exact = |path: &str| lower(path) == literal;
            exact(right)
                .cmp(&exact(left))
                .then_with(|| locale_compare(left, right))
        });
        return found.into_iter().take(limit).cloned().collect();
    }
    let terms = search_terms(query);
    if terms.is_empty() {
        return Vec::new();
    }
    let query_lower = lower(query);
    let mut scored: Vec<(&String, usize)> = candidates
        .iter()
        .map(|path| {
            let normalized = lower(path);
            let exact = if normalized.contains(&query_lower) {
                100
            } else {
                0
            };
            (
                path,
                exact
                    + terms
                        .iter()
                        .filter(|term| normalized.contains(term.as_str()))
                        .count(),
            )
        })
        .filter(|(_, score)| *score >= 100 || *score >= terms.len())
        .collect();
    scored.sort_by(|left, right| {
        right
            .1
            .cmp(&left.1)
            .then_with(|| locale_compare(left.0, right.0))
    });
    scored
        .into_iter()
        .take(limit)
        .map(|(path, _)| path.clone())
        .collect()
}

fn literal_file_query(query: &str) -> bool {
    !LITERAL_FILE_FORBIDDEN.is_match(query)
        && !query.split('/').any(|part| part == "..")
        && LITERAL_FILE_EXTENSION.is_match(query)
}

/// Scope values: one string or an array of strings.
pub fn scope_values(scope: Option<&Json>) -> Vec<String> {
    match scope {
        Some(Json::Str(value)) => vec![value.clone()],
        Some(Json::Arr(values)) => values
            .iter()
            .filter_map(|value| value.as_str().map(str::to_string))
            .collect(),
        _ => Vec::new(),
    }
}

pub fn scoped_candidates(
    files: &WorkspaceFiles,
    paths: &[String],
    scope: &[String],
) -> Outcome<Vec<String>> {
    if scope.is_empty() {
        return Ok(paths.to_vec());
    }
    let matchers: Vec<Vec<ScopeMatcher>> = scope
        .iter()
        .map(|value| scope_matcher(files, value))
        .collect::<Outcome<_>>()?;
    Ok(paths
        .iter()
        .filter(|path| {
            matchers
                .iter()
                .any(|matcher| matcher.iter().any(|single| single.matches(path)))
        })
        .cloned()
        .collect())
}

pub fn empty_search_scope(files: &WorkspaceFiles, paths: &[String], input: &SearchInput) -> Json {
    // A valid path containing spaces stays literal; an array is only a hint.
    let parts: Vec<String> = match input.scope() {
        Some(Json::Str(scope)) => split_spaces(js_trim(scope))
            .into_iter()
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    };
    let suggest_array = parts.len() > 1
        && parts.len() <= 100
        && parts.iter().all(|part| {
            scoped_candidates(files, paths, std::slice::from_ref(part))
                .is_ok_and(|found| !found.is_empty())
        });
    let mut data = obj! {
        "mode" => search_mode(input),
        "engine" => "none",
        "results" => Json::Arr(Vec::new()),
        "candidateCount" => 0,
        "scopeStatus" => "empty",
    };
    if suggest_array {
        let mut next = input.raw.clone();
        next.set("scope", Json::Arr(parts.iter().map(Json::from).collect()));
        data.set("nextSearch", next);
    }
    let middle = if suggest_array {
        "For multiple scopes, pass an array as shown in nextSearch. "
    } else {
        "Multiple scopes use an array, for example [\"src\",\"spec\"]. "
    };
    data.set(
        "guidance",
        format!("No eligible files were selected; the query was not searched. Check paths, globs and ignore rules. {middle}Spaces in one scope string are literal path characters."),
    );
    obj! { "status" => "ok", "data" => data }
}

enum ScopeMatcher {
    Glob(Regex),
    All,
    Root(String),
}

impl ScopeMatcher {
    fn matches(&self, path: &str) -> bool {
        match self {
            ScopeMatcher::Glob(expression) => expression.is_match(path),
            ScopeMatcher::All => true,
            ScopeMatcher::Root(root) => path == root || path.starts_with(&format!("{root}/")),
        }
    }
}

fn scope_matcher(files: &WorkspaceFiles, value: &str) -> Outcome<Vec<ScopeMatcher>> {
    let portable = safe_scope_pattern(&files.normalize_path(js_trim(value))?)?;
    expand_brace_patterns(&portable)
        .into_iter()
        .map(|pattern| single_scope_matcher(files, &pattern))
        .collect()
}

fn single_scope_matcher(files: &WorkspaceFiles, pattern: &str) -> Outcome<ScopeMatcher> {
    if pattern.contains(['?', '*']) {
        return Ok(ScopeMatcher::Glob(glob_expression(pattern)));
    }
    let root = files.normalize_path(pattern)?;
    Ok(if root == "." {
        ScopeMatcher::All
    } else {
        ScopeMatcher::Root(root)
    })
}

static DRIVE_PATH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z]:/").expect("pattern"));

fn safe_scope_pattern(value: &str) -> Outcome<String> {
    let portable = js_trim(value).replace('\\', "/");
    let portable = portable.strip_prefix("./").unwrap_or(&portable).to_string();
    if portable.is_empty() || portable.starts_with('/') || DRIVE_PATH.is_match(&portable) {
        return Err(Failure::new(
            "Search scopes must be workspace-relative paths or globs.",
        ));
    }
    if portable.split('/').any(|part| part == "..") {
        return Err(Failure::new("Search scope escapes the workspace root."));
    }
    if lower(&portable)
        .split('/')
        .any(|part| part == "node_modules")
    {
        return Err(Failure::new(
            "Dependency internals are excluded from code navigation. Use project manifests and run_task diagnostics.",
        ));
    }
    Ok(portable)
}

static BRACE_GROUP: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\{([^{}]+)\}").expect("pattern"));

fn expand_brace_patterns(pattern: &str) -> Vec<String> {
    let Some(captures) = BRACE_GROUP.captures(pattern) else {
        return vec![pattern.to_string()];
    };
    let whole = captures.get(0).expect("match");
    let alternatives: Vec<&str> = captures
        .get(1)
        .map_or("", |group| group.as_str())
        .split(',')
        .filter(|part| !part.is_empty())
        .collect();
    if alternatives.is_empty() || alternatives.len() > 16 {
        return vec![pattern.to_string()];
    }
    let prefix = &pattern[..whole.start()];
    let suffix = &pattern[whole.end()..];
    alternatives
        .into_iter()
        .flat_map(|value| expand_brace_patterns(&format!("{prefix}{value}{suffix}")))
        .collect()
}

fn glob_expression(pattern: &str) -> Regex {
    let characters: Vec<char> = pattern.chars().collect();
    let mut source = String::from("^");
    let mut index = 0;
    while index < characters.len() {
        let character = characters[index];
        if character == '*' && characters.get(index + 1) == Some(&'*') {
            let followed_by_slash = characters.get(index + 2) == Some(&'/');
            source.push_str(if followed_by_slash { "(?:.*/)?" } else { ".*" });
            index += if followed_by_slash { 2 } else { 1 };
        } else if character == '*' {
            source.push_str("[^/]*");
        } else if character == '?' {
            source.push_str("[^/]");
        } else {
            source.push_str(&escape_regex(&character.to_string()));
        }
        index += 1;
    }
    source.push('$');
    Regex::new(&source).unwrap_or_else(|_| Regex::new("^$").expect("empty pattern"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_braces_and_globs() {
        assert_eq!(
            expand_brace_patterns("src/{a,b}/*.ts"),
            ["src/a/*.ts", "src/b/*.ts"]
        );
        let glob = glob_expression("src/**/*.ts");
        assert!(glob.is_match("src/a.ts"));
        assert!(glob.is_match("src/x/y/a.ts"));
        assert!(!glob.is_match("lib/a.ts"));
    }

    #[test]
    fn lines_holding_more_query_words_come_first_across_files() {
        let line = |path: &str, number: usize, hits: &[&str]| LexicalMatch {
            path: path.to_string(),
            line_range: (number, number),
            range: (0, 0),
            excerpt: String::new(),
            hits: hits.iter().map(|hit| hit.to_string()).collect(),
            regex: true,
        };
        let terms = search_terms("claude session");
        let matches = vec![
            line("a.ts", 1, &["claude"]),
            line("a.ts", 2, &["claude"]),
            line("a.ts", 3, &["claude"]),
            line("b.ts", 1, &["claude"]),
            line("c.ts", 9, &["Claude", "session"]),
        ];
        let ordered = ordered_matches(&ranked_files(&matches, &terms, true), &terms, true);
        let order: Vec<(&str, usize)> = ordered
            .iter()
            .map(|found| (found.path.as_str(), found.line_range.0))
            .collect();
        assert_eq!(
            order,
            [
                ("c.ts", 9),
                ("a.ts", 1),
                ("a.ts", 2),
                ("b.ts", 1),
                ("a.ts", 3)
            ]
        );
    }

    #[test]
    fn builds_terms_and_queries() {
        assert_eq!(search_terms("Foo  bar foo"), ["foo", "bar"]);
        let query = lexical_query("a.b c", "text", false);
        assert!(query.regex);
        assert_eq!(query.pattern, "a\\.b[ \\t]+c|a\\.b|c");
        assert!(!lexical_query("one", "text", false).regex);
    }

    #[test]
    fn keys_results_like_template_literals() {
        assert_eq!(
            search_result_key(&obj! { "path" => "a.ts", "lines" => Json::from((1usize, 2usize)) }),
            "a.ts:1,2"
        );
        assert_eq!(
            search_result_key(&obj! { "path" => "a.ts" }),
            "a.ts:undefined"
        );
    }

    #[test]
    fn shows_shared_context_lines_once() {
        let mut results = vec![
            obj! { "path" => "a.txt", "snippet" => "marker 1", "context" => "1-one\n2:marker 1\n3-three" },
            obj! { "path" => "a.txt", "snippet" => "marker 2", "context" => "3-three\n4:marker 2\n5-five" },
            obj! { "path" => "a.txt", "snippet" => "three", "context" => "2-marker 1\n3:three\n4-marker 2" },
            obj! { "path" => "b.txt", "snippet" => "one", "context" => "1:one" },
        ];
        without_repeated_context(&mut results);
        let field = |index: usize, key: &str| {
            results[index]
                .get(key)
                .and_then(Json::as_str)
                .map(str::to_string)
        };
        assert_eq!(
            field(0, "context").as_deref(),
            Some("1-one\n2:marker 1\n3-three")
        );
        assert_eq!(field(0, "snippet"), None);
        assert_eq!(field(1, "context").as_deref(), Some("4:marker 2\n5-five"));
        assert_eq!(field(1, "snippet"), None);
        assert_eq!(field(2, "context"), None);
        assert_eq!(field(2, "snippet").as_deref(), Some("three"));
        assert_eq!(field(3, "context").as_deref(), Some("1:one"));
    }
}
