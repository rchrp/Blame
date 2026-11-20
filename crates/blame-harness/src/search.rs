//! search_code over the current workspace snapshot: paths, text, regex,
//! symbols and references (`light-code-search.ts`, `light-reference-search.ts`,
//! `light-reference-candidates.ts`).

use crate::aliases::{Alias, AliasRegistry};
use crate::compiler::{CompilerPort, CompilerReply, ReferenceTarget};
use crate::failure::{Outcome, Signal};
use crate::files::WorkspaceFiles;
use crate::identity::sha256_hex;
use crate::json::Json;
use crate::languages::symbolic_path;
use crate::lexical::{LexicalMatch, LexicalResult, search_lexically};
use crate::navigation::{enclosing_symbol, qualified_target, symbol_matches};
use crate::obj;
use crate::search_results::*;
use crate::syntax::{ParsedSymbol, parse_code};
use crate::text::{js_trim, lower};
use regex::Regex;
use std::sync::{Arc, LazyLock};

const MAXIMUM_MATCHING_LINES: usize = 20_000;
const MAXIMUM_MATCHING_LINES_PER_FILE: usize = 500;

pub struct CodeSearch<'a> {
    pub files: &'a WorkspaceFiles,
    pub aliases: &'a mut AliasRegistry,
    pub compiler: &'a dyn CompilerPort,
    pub signal: &'a Signal,
    /// The source revision of the snapshot the search started from.
    pub revision: String,
}

struct Source {
    content: Arc<Vec<u8>>,
    symbols: Vec<ParsedSymbol>,
    text: String,
}

struct TextResults {
    capped_files: Vec<String>,
    has_more: bool,
    results: Vec<Json>,
    truncated: bool,
}

enum Semantic {
    Result(Json),
    Fallback {
        fallback: String,
        lexical_query: String,
    },
}

impl CodeSearch<'_> {
    pub fn search(&mut self, request: &SearchInput) -> Outcome<Json> {
        let snapshot = self.files.snapshot(self.signal)?;
        self.revision = snapshot.revision.source_revision_id.clone();
        let candidates =
            scoped_candidates(self.files, &snapshot.files, &scope_values(request.scope()))?;
        if candidates.is_empty() {
            return Ok(empty_search_scope(self.files, &snapshot.files, request));
        }
        if request.output().is_some_and(|output| output != "matches") {
            return self.file_search(request, &candidates);
        }
        let semantic = if request.mode() == Some("references") {
            Some(self.references(request, &snapshot.files)?)
        } else {
            None
        };
        let fallback = match semantic {
            Some(Semantic::Result(result)) => return Ok(result),
            Some(Semantic::Fallback {
                fallback,
                lexical_query,
            }) => Some((fallback, lexical_query)),
            None => None,
        };
        let searched = match &fallback {
            Some((_, lexical_query)) => request.with_query(lexical_query),
            None => request.clone(),
        };
        let mut result = self.search_result(&searched, &search_mode(request), &candidates)?;
        if let Some((reason, _)) = fallback {
            if let Some(data) = result.get_mut("data") {
                data.set("semanticFallback", reason.as_str());
                let recovery = self.recovery(request, &reason, &candidates)?;
                data.extend(recovery);
            }
            return Ok(result);
        }
        // Keep the original lexical/symbol results and explicit target
        // choice. The bounded syntax route is also reachable from ordinary
        // searches, even when early call sites or substring matches crowd out
        // the exact declaration.
        if request.mode() != Some("regex")
            && let Some(query) = declaration_query(request.query())
        {
            let exact = result
                .get("data")
                .and_then(|data| data.get("results"))
                .and_then(Json::as_array)
                .is_some_and(|items| {
                    items.iter().any(|item| {
                        item.get("reason").and_then(Json::as_str) == Some("symbol_name")
                            && item
                                .get("qualifiedName")
                                .and_then(Json::as_str)
                                .is_some_and(|name| {
                                    name == query || name.ends_with(&format!(".{query}"))
                                })
                    })
                });
            if !exact {
                let discovery = self.declarations(&request.with_query(&query), &candidates)?;
                let status = discovery
                    .get("declarationDiscovery")
                    .and_then(|value| value.get("status"))
                    .and_then(Json::as_str);
                let limited = discovery
                    .get("declarationDiscovery")
                    .and_then(|value| value.get("limited"))
                    .and_then(Json::as_bool)
                    == Some(true);
                let found = discovery
                    .get("declarationCandidates")
                    .and_then(Json::as_array)
                    .is_some_and(|items| !items.is_empty());
                if (found || limited || status == Some("source_changed"))
                    && let Some(data) = result.get_mut("data")
                {
                    data.extend(discovery);
                }
            }
        }
        Ok(result)
    }

    fn search_result(
        &mut self,
        request: &SearchInput,
        mode: &str,
        candidates: &[String],
    ) -> Outcome<Json> {
        let page = search_page(request);
        let end = page.offset + page.limit;
        if mode == "symbol" && request.mode() == Some("symbol") {
            let symbols = self.symbol_search(request.query(), candidates, end + 1)?;
            let has_more = symbols.len() > end;
            return Ok(search_envelope(
                request,
                "symbol",
                "syntax",
                slice(symbols, page.offset, end),
                candidates.len(),
                SearchMore {
                    has_more,
                    ..Default::default()
                },
            ));
        }
        let text = self.text_search(
            request,
            if mode == "regex" { "regex" } else { "text" },
            candidates,
            end + 1,
        )?;
        if mode != "symbol" {
            let engine = if mode == "references" {
                "lexical_fallback"
            } else {
                "ripgrep"
            };
            let has_more = text.has_more || text.results.len() > end;
            return Ok(search_envelope(
                request,
                mode,
                engine,
                slice(text.results, page.offset, end),
                candidates.len(),
                SearchMore {
                    capped_files: text.capped_files,
                    has_more,
                    truncated: text.truncated,
                    sized: false,
                },
            ));
        }
        let symbol_candidates = auto_symbol_candidates(&text.results, candidates, request.query());
        let symbols = self.symbol_search(request.query(), &symbol_candidates, end + 1)?;
        let symbol_count = symbols.len();
        let leading: Vec<Json> = symbols
            .into_iter()
            .take(page.limit.div_ceil(2) + page.offset)
            .collect();
        let merged = unique_search_results(
            leading
                .into_iter()
                .chain(text.results.iter().cloned())
                .collect(),
        );
        let has_more = text.has_more || symbol_count > end || merged.len() > end;
        Ok(search_envelope(
            request,
            "auto",
            "syntax_and_ripgrep",
            slice(merged, page.offset, end),
            candidates.len(),
            SearchMore {
                capped_files: text.capped_files,
                has_more,
                truncated: text.truncated,
                sized: false,
            },
        ))
    }

    /// files and count outputs: every matching file, without aliases or symbol parsing.
    fn file_search(&mut self, request: &SearchInput, candidates: &[String]) -> Outcome<Json> {
        let mode = if request.mode() == Some("regex") {
            "regex"
        } else {
            "text"
        };
        let searched = self.lexical(request, mode, candidates)?;
        let files = ranked_files(
            &searched.items,
            &search_terms(request.query()),
            mode == "text",
        );
        let page = search_page(request);
        let mut data = obj! {
            "mode" => mode,
            "engine" => "ripgrep",
            "output" => request.output().unwrap_or(""),
            "candidateCount" => candidates.len(),
            "totalFiles" => files.len(),
            "totalMatchingLines" => searched.items.len(),
        };
        if request.output() == Some("count") {
            let more = SearchMore {
                capped_files: searched.capped_files,
                has_more: false,
                truncated: searched.truncated,
                sized: false,
            };
            data.extend(limit_data(request, page, &more, files.len()));
            return Ok(obj! { "status" => "ok", "data" => data });
        }
        let shown: Vec<Json> = files
            .iter()
            .skip(page.offset)
            .take(page.limit)
            .map(
                |file| obj! { "path" => file.path.as_str(), "matchingLines" => file.matches.len() },
            )
            .collect();
        let count = shown.len();
        data.set("files", Json::Arr(shown));
        let more = SearchMore {
            capped_files: searched.capped_files,
            has_more: files.len() > page.offset + page.limit,
            truncated: searched.truncated,
            sized: false,
        };
        data.extend(limit_data(request, page, &more, count));
        Ok(obj! { "status" => "ok", "data" => data })
    }

    fn lexical(
        &self,
        request: &SearchInput,
        mode: &str,
        candidates: &[String],
    ) -> Outcome<LexicalResult> {
        let query = lexical_query(request.query(), mode, request.case_sensitive());
        search_lexically(
            self.files,
            candidates,
            &query,
            MAXIMUM_MATCHING_LINES,
            MAXIMUM_MATCHING_LINES_PER_FILE,
            self.signal,
        )
    }

    fn symbol_search(
        &mut self,
        query: &str,
        candidates: &[String],
        maximum: usize,
    ) -> Outcome<Vec<Json>> {
        struct Selected {
            path: String,
            content: Arc<Vec<u8>>,
            symbol: ParsedSymbol,
            exact: bool,
        }
        let mut selected: Vec<Selected> = Vec::new();
        let normalized = lower(query);
        for path in candidates {
            self.signal.check()?;
            if selected.len() == maximum {
                break;
            }
            if !symbolic_path(path) {
                continue;
            }
            let content = Arc::new(self.files.read(path)?.content);
            if content.len() > 2 * 1024 * 1024 {
                continue;
            }
            let parsed = parse_code(path, &content);
            for symbol in &parsed.symbols {
                if !symbol_matches(symbol, &normalized) {
                    continue;
                }
                let exact = lower(&symbol.name) == normalized
                    || lower(&symbol.qualified_name) == normalized;
                if selected.len() < maximum {
                    selected.push(Selected {
                        path: path.clone(),
                        content: content.clone(),
                        symbol: symbol.clone(),
                        exact,
                    });
                } else if exact && selected.last().is_some_and(|last| !last.exact) {
                    selected.pop();
                    selected.push(Selected {
                        path: path.clone(),
                        content: content.clone(),
                        symbol: symbol.clone(),
                        exact,
                    });
                }
                // Stable ties retain candidate/source order. Scan the already
                // parsed file for exact names, but retain the bound on
                // visiting further files.
                selected.sort_by_key(|item| std::cmp::Reverse(item.exact));
                if selected.len() == maximum && selected.iter().all(|item| item.exact) {
                    break;
                }
            }
        }
        // Register only returned aliases; discovery still grants no read coverage.
        Ok(selected
            .into_iter()
            .map(|item| {
                let alias = self
                    .aliases
                    .register_symbol(&item.path, &item.content, &item.symbol);
                search_symbol_result(&alias, &item.path, &item.symbol, "symbol_name")
            })
            .collect())
    }

    fn text_search(
        &mut self,
        request: &SearchInput,
        mode: &str,
        candidates: &[String],
        wanted: usize,
    ) -> Outcome<TextResults> {
        let relevance = mode == "text";
        let paths: Vec<Json> = if relevance {
            path_matches(request.query(), candidates, wanted)
                .into_iter()
                .map(|path| {
                    let alias = self.aliases.register_path(&path);
                    obj! { "alias" => alias, "kind" => "path", "path" => path.as_str(), "reason" => "path_name", "target" => path.as_str() }
                })
                .collect()
        } else {
            Vec::new()
        };
        let searched = self.lexical(request, mode, candidates)?;
        let terms = search_terms(request.query());
        let ordered = ordered_matches(
            &ranked_files(&searched.items, &terms, relevance),
            &terms,
            relevance,
        );
        let (has_more, content) = self.materialize_matches(&ordered, request, wanted)?;
        let results = unique_search_results(paths.into_iter().chain(content).collect());
        Ok(TextResults {
            capped_files: searched.capped_files,
            has_more,
            results,
            truncated: searched.truncated,
        })
    }

    fn materialize_matches(
        &mut self,
        ordered: &[LexicalMatch],
        request: &SearchInput,
        wanted: usize,
    ) -> Outcome<(bool, Vec<Json>)> {
        // text mode groups the hits of one declaration; regex mode lists each line like grep.
        let per_line = request.mode() == Some("regex");
        let promote = request.mode() != Some("text");
        let mut sources: Vec<(String, Source)> = Vec::new();
        let mut results = Vec::new();
        let mut seen: Vec<String> = Vec::new();
        for found in ordered {
            if results.len() >= wanted {
                return Ok((true, results));
            }
            if !sources.iter().any(|(path, _)| *path == found.path) {
                let content = Arc::new(self.files.read(&found.path)?.content);
                let symbols = if promote && symbolic_path(&found.path) {
                    parse_code(&found.path, &content).symbols.clone()
                } else {
                    Vec::new()
                };
                let text = String::from_utf8_lossy(&content).into_owned();
                sources.push((
                    found.path.clone(),
                    Source {
                        content,
                        symbols,
                        text,
                    },
                ));
            }
            let source = &sources
                .iter()
                .find(|(path, _)| *path == found.path)
                .expect("source")
                .1;
            let item = text_match(self.aliases, found, source, request);
            let key = if per_line {
                format!("{}:{}", found.path, found.line_range.0)
            } else {
                search_result_key(&item)
            };
            if seen.contains(&key) {
                continue;
            }
            seen.push(key);
            results.push(item);
        }
        Ok((false, results))
    }

    fn references(&mut self, input: &SearchInput, paths: &[String]) -> Outcome<Semantic> {
        let query = input.query();
        let is_symbol = matches!(self.aliases.get(query), Some(Alias::Symbol { .. }));
        if !is_symbol && !qualified_target(query) {
            return Ok(Semantic::Fallback {
                fallback: "symbol_target_required".into(),
                lexical_query: query.into(),
            });
        }
        let resolved = self.aliases.resolve_symbol(query, self.files)?;
        let lexical_query = resolved.symbol.name.clone();
        if !JS_TS_PATH.is_match(&resolved.path) {
            return Ok(Semantic::Fallback {
                fallback: "unsupported_language".into(),
                lexical_query,
            });
        }
        if !paths.contains(&resolved.path) {
            return Ok(Semantic::Fallback {
                fallback: "target_excluded".into(),
                lexical_query,
            });
        }
        let hash = sha256_hex(&resolved.content);
        let reply = self.compiler.references(&ReferenceTarget {
            root: &self.files.root,
            path: &resolved.path,
            name: &resolved.symbol.qualified_name,
            start: resolved.symbol.range.0,
            end: resolved.symbol.range.1,
            hash: &hash,
        });
        match reply {
            CompilerReply::Unavailable(reason) => Ok(Semantic::Fallback {
                fallback: reason,
                lexical_query,
            }),
            // The compiler side process presents its own locations; until it
            // exists no reply is ever ok.
            CompilerReply::Ok(result) => Ok(Semantic::Result(result)),
        }
    }

    fn recovery(
        &mut self,
        input: &SearchInput,
        reason: &str,
        candidates: &[String],
    ) -> Outcome<Json> {
        if reason != "symbol_target_required" {
            return Ok(
                obj! { "guidance" => "Lexical fallback. For compiler references, choose an sN or path#name target; read before editing." },
            );
        }
        self.declarations(input, candidates)
    }

    fn declarations(&mut self, input: &SearchInput, paths: &[String]) -> Outcome<Json> {
        let (candidates, discovery) = self.declaration_candidates(input.query(), paths)?;
        let mut declarations = Vec::new();
        for candidate in candidates {
            let alias = self.aliases.register_symbol(
                &candidate.path,
                &candidate.content,
                &candidate.symbol,
            );
            let mut entry = search_symbol_result(
                &alias,
                &candidate.path,
                &candidate.symbol,
                "exact_declaration_candidate",
            );
            let signature: String = candidate.symbol.signature.chars().take(160).collect();
            let truncated = signature != candidate.symbol.signature;
            entry.set("signature", signature);
            if truncated {
                entry.set("signatureTruncated", true);
            }
            let target = if candidate.qualified_unique {
                format!("{}#{}", candidate.path, candidate.symbol.qualified_name)
            } else {
                alias
            };
            entry.set("target", target);
            declarations.push(entry);
        }
        let scoped = |mut value: Json| {
            if let Some(scope) = input.scope() {
                value.set("scope", scope.clone());
            }
            value
        };
        let targets: Vec<String> = declarations
            .iter()
            .map(|entry| {
                entry
                    .get("target")
                    .and_then(Json::as_str)
                    .unwrap_or("")
                    .to_string()
            })
            .collect();
        let next_searches: Vec<Json> = if declarations.is_empty() {
            vec![scoped(
                obj! { "query" => input.query(), "mode" => "symbol" },
            )]
        } else {
            targets
                .iter()
                .map(|target| scoped(obj! { "query" => target.as_str(), "mode" => "references" }))
                .collect()
        };
        Ok(obj! {
            "declarationDiscovery" => discovery,
            "declarationCandidates" => Json::Arr(declarations),
            "nextReads" => Json::Arr(targets.iter().map(|target| obj! { "target" => target.as_str(), "view" => "symbol" }).collect()),
            "nextSearches" => Json::Arr(next_searches),
            "guidance" => "Bounded syntax candidates, not exhaustive and not compiler-resolved references. Choose the intended declaration, then follow nextSearches. No edit coverage; read truncated signatures explicitly.",
        })
    }

    /// Syntax discovery only: a caller must explicitly choose a declaration
    /// before compiler resolution.
    fn declaration_candidates(
        &mut self,
        query: &str,
        paths: &[String],
    ) -> Outcome<(Vec<Candidate>, Json)> {
        self.signal.check()?;
        let revision = self.revision.clone();
        // Ordering hints never establish declaration identity. Keep exact
        // filename affinity first, then the bounded scan for source before
        // test callers.
        let filename = query.split('.').next().unwrap_or("");
        let source_order = std::env::var("BLAME_AGENT_DECLARATION_SOURCE_ORDER")
            .ok()
            .as_deref()
            != Some("false");
        let mut eligible: Vec<&String> = paths
            .iter()
            .filter(|path| JS_TS_PATH.is_match(path))
            .collect();
        let affinity = |path: &str| {
            JS_TS_SUFFIX.replace(path.rsplit('/').next().unwrap_or(""), "") == filename
        };
        eligible.sort_by(|left, right| {
            affinity(right).cmp(&affinity(left)).then_with(|| {
                if source_order {
                    test_like_path(left).cmp(&test_like_path(right))
                } else {
                    std::cmp::Ordering::Equal
                }
            })
        });
        let mut selected: Vec<Candidate> = Vec::new();
        let mut reads: Vec<(String, String)> = Vec::new();
        let (mut visited, mut read_bytes, mut skipped) = (0usize, 0usize, 0usize);
        let mut limited = false;
        let report = |status: &str,
                      visited: usize,
                      read_bytes: usize,
                      skipped: usize,
                      limited: bool| {
            let mut discovery =
                obj! { "engine" => "syntax", "status" => status, "navigationOnly" => true };
            if status == "current" {
                discovery.set("sourceRevision", revision.as_str());
            }
            discovery
                .with("eligibleFiles", eligible.len())
                .with("visitedFiles", visited)
                .with("readBytes", read_bytes)
                .with("skippedFiles", skipped)
                .with("limited", limited)
                .with("limits", obj! { "files" => 64, "bytes" => 1024 * 1024, "fileBytes" => 256 * 1024, "declarations" => 4 })
        };
        if !SUPPORTED_QUERY.is_match(query) {
            return Ok((
                Vec::new(),
                report("unsupported_query", visited, read_bytes, skipped, limited),
            ));
        }
        for path in &eligible {
            self.signal.check()?;
            if visited == 64 || selected.len() > 4 {
                limited = true;
                break;
            }
            visited += 1;
            let content = match self.files.file_size(path) {
                Ok(size) if size > 256 * 1024 => {
                    skipped += 1;
                    continue;
                }
                Ok(size) if read_bytes as u64 + size > 1024 * 1024 => {
                    limited = true;
                    break;
                }
                Ok(_) => match self.files.read(path) {
                    Ok(file) => Arc::new(file.content),
                    Err(_) => {
                        self.signal.check()?;
                        skipped += 1;
                        continue;
                    }
                },
                Err(_) => {
                    self.signal.check()?;
                    skipped += 1;
                    continue;
                }
            };
            // Recheck after the read, since the file could have grown after stat.
            if content.len() > 256 * 1024 {
                skipped += 1;
                continue;
            }
            if read_bytes + content.len() > 1024 * 1024 {
                limited = true;
                break;
            }
            read_bytes += content.len();
            reads.push(((*path).clone(), sha256_hex(&content)));
            let parsed = parse_code(path, &content);
            if !parsed.supported || parsed.error_count > 0 {
                skipped += 1;
                continue;
            }
            for symbol in &parsed.symbols {
                if symbol.name != query && symbol.qualified_name != query {
                    continue;
                }
                let qualified_unique = parsed
                    .symbols
                    .iter()
                    .filter(|other| other.qualified_name == symbol.qualified_name)
                    .count()
                    == 1;
                selected.push(Candidate {
                    path: (*path).clone(),
                    content: content.clone(),
                    symbol: symbol.clone(),
                    qualified_unique,
                });
                if selected.len() > 4 {
                    limited = true;
                    break;
                }
            }
        }
        if skipped > 0 {
            limited = true;
        }
        self.signal.check()?;
        if self
            .files
            .snapshot(self.signal)?
            .revision
            .source_revision_id
            != revision
        {
            return Ok((
                Vec::new(),
                report("source_changed", visited, read_bytes, skipped, limited),
            ));
        }
        for (path, hash) in &reads {
            self.signal.check()?;
            if self
                .files
                .blob_hash(path)
                .is_ok_and(|current| current == *hash)
            {
                continue;
            }
            return Ok((
                Vec::new(),
                report("source_changed", visited, read_bytes, skipped, limited),
            ));
        }
        selected.truncate(4);
        Ok((
            selected,
            report("current", visited, read_bytes, skipped, limited),
        ))
    }
}

struct Candidate {
    path: String,
    content: Arc<Vec<u8>>,
    symbol: ParsedSymbol,
    qualified_unique: bool,
}

fn slice(values: Vec<Json>, start: usize, end: usize) -> Vec<Json> {
    values
        .into_iter()
        .skip(start)
        .take(end.saturating_sub(start))
        .collect()
}

fn text_match(
    aliases: &mut AliasRegistry,
    found: &LexicalMatch,
    source: &Source,
    request: &SearchInput,
) -> Json {
    let line = found.line_range.0;
    let before = request
        .raw
        .get("contextBefore")
        .and_then(Json::as_f64)
        .map(|value| value as usize)
        .or(request.context())
        .unwrap_or(0);
    let after = request
        .raw
        .get("contextAfter")
        .and_then(Json::as_f64)
        .map(|value| value as usize)
        .or(request.context())
        .unwrap_or(0);
    let context =
        (before > 0 || after > 0).then(|| context_excerpt(&source.text, line, before, after));
    if let Some(index) = enclosing_symbol(&source.symbols, found.range) {
        let symbol = &source.symbols[index];
        let alias = aliases.register_symbol(&found.path, &source.content, symbol);
        // The matching line replaces the declaration signature: one location, fewer tokens.
        let mut result = search_symbol_result(&alias, &found.path, symbol, "lexical_symbol");
        result.remove("signature");
        return result
            .with("matchLine", line)
            .with("snippet", found.excerpt.as_str())
            .with_opt("context", context);
    }
    obj! {
        "alias" => aliases.register_range(&found.path, &source.content, found.range),
        "kind" => "text",
        "path" => found.path.as_str(),
        "lines" => Json::from(found.line_range),
        "snippet" => found.excerpt.as_str(),
        "reason" => found.match_reason(),
    }
    .with_opt("context", context)
}

static JS_TS_PATH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\.[cm]?[jt]sx?$").expect("pattern"));
static JS_TS_SUFFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\.[cm]?[jt]sx?$").expect("pattern"));
static TEST_LIKE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)(?:^|/)(?:__tests__|tests?|specs?)(?:/|$)|\.(?:test|spec)(?:-d)?\.[cm]?[jt]sx?$",
    )
    .expect("pattern")
});

fn test_like_path(path: &str) -> bool {
    TEST_LIKE.is_match(path)
}

const IDENTIFIER: &str = r"[\p{ID_Start}_$][\p{ID_Continue}$]*";
static SUPPORTED_QUERY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"^{IDENTIFIER}(?:\.{IDENTIFIER})*$")).expect("pattern"));
static DECLARATION_PREFIX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var)\s+({IDENTIFIER})$"))
        .expect("pattern")
});

/// A literal name or a complete declaration prefix, never a regex or expression.
pub fn declaration_query(query: &str) -> Option<String> {
    let text = js_trim(query);
    if SUPPORTED_QUERY.is_match(text) {
        return Some(text.to_string());
    }
    DECLARATION_PREFIX
        .captures(text)
        .and_then(|captures| captures.get(1))
        .map(|name| name.as_str().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_declaration_queries() {
        assert_eq!(
            declaration_query(" parseCode ").as_deref(),
            Some("parseCode")
        );
        assert_eq!(
            declaration_query("export async function load").as_deref(),
            Some("load")
        );
        assert_eq!(declaration_query("a.b.c").as_deref(), Some("a.b.c"));
        assert_eq!(declaration_query("foo|bar"), None);
    }
}
