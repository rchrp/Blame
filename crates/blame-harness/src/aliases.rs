//! sN aliases for symbols, text ranges and paths, with what was observed of
//! each symbol. Mirrors `light-aliases.ts`; entries are journaled in the same
//! JSON shape (field order included).

use crate::coverage::Interval;
use crate::failure::{Failure, Outcome};
use crate::files::WorkspaceFiles;
use crate::identity::sha256_hex;
use crate::json::{Json, quote};
use crate::obj;
use crate::syntax::{ParseResult, ParsedSymbol, parse_code, semantic_language_name};
use std::sync::Arc;

#[derive(Clone, Debug, PartialEq)]
pub enum Alias {
    Symbol {
        alias: String,
        content_hash: Option<String>,
        end: usize,
        file_hash: String,
        language: String,
        path: String,
        qualified_name: String,
        symbol_kind: String,
        start: usize,
        observed: Option<Vec<Interval>>,
    },
    Range {
        alias: String,
        end: usize,
        file_hash: String,
        path: String,
        start: usize,
    },
    Path {
        alias: String,
        path: String,
    },
}

impl Alias {
    pub fn name(&self) -> &str {
        match self {
            Alias::Symbol { alias, .. }
            | Alias::Range { alias, .. }
            | Alias::Path { alias, .. } => alias,
        }
    }

    pub fn path(&self) -> &str {
        match self {
            Alias::Symbol { path, .. } | Alias::Range { path, .. } | Alias::Path { path, .. } => {
                path
            }
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Alias::Symbol { .. } => "symbol",
            Alias::Range { .. } => "range",
            Alias::Path { .. } => "path",
        }
    }

    pub fn to_json(&self) -> Json {
        match self {
            Alias::Symbol {
                alias,
                content_hash,
                end,
                file_hash,
                language,
                path,
                qualified_name,
                symbol_kind,
                start,
                observed,
            } => obj! {
                "alias" => alias.as_str(),
            }
            .with_opt("contentHash", content_hash.as_deref())
            .with("end", *end)
            .with("fileHash", file_hash.as_str())
            .with("kind", "symbol")
            .with("language", language.as_str())
            .with("path", path.as_str())
            .with("qualifiedName", qualified_name.as_str())
            .with("symbolKind", symbol_kind.as_str())
            .with("start", *start)
            .with_opt(
                "observed",
                observed
                    .as_ref()
                    .map(|intervals| crate::coverage::intervals_json(intervals)),
            ),
            Alias::Range {
                alias,
                end,
                file_hash,
                path,
                start,
            } => obj! {
                "alias" => alias.as_str(),
                "end" => *end,
                "fileHash" => file_hash.as_str(),
                "kind" => "range",
                "path" => path.as_str(),
                "start" => *start,
            },
            Alias::Path { alias, path } => {
                obj! { "alias" => alias.as_str(), "kind" => "path", "path" => path.as_str() }
            }
        }
    }

    pub fn from_json(value: &Json) -> Option<Alias> {
        let text = |key: &str| value.get(key).and_then(Json::as_str).map(str::to_string);
        let number = |key: &str| {
            value
                .get(key)
                .and_then(Json::as_f64)
                .map(|value| value as usize)
        };
        let alias = text("alias")?;
        Some(match value.get("kind")?.as_str()? {
            "symbol" => Alias::Symbol {
                alias,
                content_hash: text("contentHash"),
                end: number("end")?,
                file_hash: text("fileHash")?,
                language: text("language")?,
                path: text("path")?,
                qualified_name: text("qualifiedName")?,
                symbol_kind: text("symbolKind")?,
                start: number("start")?,
                observed: value
                    .get("observed")
                    .map(|observed| crate::coverage::intervals_from_json(Some(observed))),
            },
            "range" => Alias::Range {
                alias,
                end: number("end")?,
                file_hash: text("fileHash")?,
                path: text("path")?,
                start: number("start")?,
            },
            "path" => Alias::Path {
                alias,
                path: text("path")?,
            },
            _ => return None,
        })
    }
}

/// A symbol resolved in the current content of its file.
pub struct ResolvedSymbol {
    pub alias: Option<String>,
    pub content: Arc<Vec<u8>>,
    pub parsed: Arc<ParseResult>,
    pub symbol: ParsedSymbol,
    pub path: String,
}

#[derive(Default)]
pub struct AliasRegistry {
    aliases: Vec<Alias>,
    observations: Vec<(String, String, Vec<Interval>)>,
    sequence: usize,
}

impl AliasRegistry {
    pub fn register_symbol(&mut self, path: &str, content: &[u8], symbol: &ParsedSymbol) -> String {
        if let Some(existing) = self.reusable_symbol(path, content, symbol) {
            self.update_symbol(&existing, path, content, symbol);
            return existing;
        }
        let alias = self.next_alias();
        self.update_symbol(&alias, path, content, symbol);
        alias
    }

    pub fn register_path(&mut self, path: &str) -> String {
        if let Some(existing) = self
            .aliases
            .iter()
            .find(|entry| matches!(entry, Alias::Path { path: known, .. } if known == path))
        {
            return existing.name().into();
        }
        let alias = self.next_alias();
        self.aliases.push(Alias::Path {
            alias: alias.clone(),
            path: path.into(),
        });
        alias
    }

    pub fn register_range(&mut self, path: &str, content: &[u8], range: Interval) -> String {
        let hash = sha256_hex(content);
        let existing = self.aliases.iter().find(|entry| {
            matches!(entry, Alias::Range { path: known, file_hash, start, end, .. }
                if known == path && *file_hash == hash && *start == range.0 && *end == range.1)
        });
        if let Some(existing) = existing {
            return existing.name().into();
        }
        let alias = self.next_alias();
        self.aliases.push(Alias::Range {
            alias: alias.clone(),
            end: range.1,
            file_hash: hash,
            path: path.into(),
            start: range.0,
        });
        alias
    }

    pub fn get(&self, alias: &str) -> Option<&Alias> {
        self.aliases.iter().find(|entry| entry.name() == alias)
    }

    pub fn entries(&self) -> Vec<Json> {
        self.aliases.iter().map(Alias::to_json).collect()
    }

    pub fn observe(&mut self, path: &str, content: &[u8], intervals: &[Interval]) {
        let hash = sha256_hex(content);
        self.remember_observation(path, &hash, intervals);
        for entry in &mut self.aliases {
            if let Alias::Symbol {
                path: known,
                file_hash,
                start,
                end,
                observed,
                ..
            } = entry
            {
                if known != path || *file_hash != hash {
                    continue;
                }
                let mut merged = observed.clone().unwrap_or_default();
                merged.extend(
                    intervals
                        .iter()
                        .map(|(from, to)| relative_interval((*from, *to), *start, *end)),
                );
                *observed = Some(
                    merged_intervals(merged)
                        .into_iter()
                        .filter(|(from, to)| to > from)
                        .collect(),
                );
            }
        }
    }

    pub fn remember_observation(&mut self, path: &str, hash: &str, intervals: &[Interval]) {
        let previous = self
            .observations
            .iter()
            .position(|(known, _, _)| known == path);
        let mut merged = match previous {
            Some(index) if self.observations[index].1 == hash => self.observations[index].2.clone(),
            _ => Vec::new(),
        };
        merged.extend_from_slice(intervals);
        let entry = (path.to_string(), hash.to_string(), merged_intervals(merged));
        match previous {
            Some(index) => self.observations[index] = entry,
            None => self.observations.push(entry),
        }
        if self.observations.len() > 500 {
            self.observations.remove(0);
        }
    }

    pub fn hydrate(&mut self, entries: &[Json]) {
        self.aliases.clear();
        for entry in entries.iter().filter_map(Alias::from_json) {
            match self
                .aliases
                .iter_mut()
                .find(|known| known.name() == entry.name())
            {
                Some(slot) => *slot = entry,
                None => self.aliases.push(entry),
            }
        }
        self.sequence = self
            .aliases
            .iter()
            .map(|entry| alias_sequence(entry.name()))
            .max()
            .unwrap_or(0);
    }

    /// Resolves an alias or `path#qualifiedName` in the file's current content.
    pub fn resolve_symbol(
        &mut self,
        target: &str,
        files: &WorkspaceFiles,
    ) -> Outcome<ResolvedSymbol> {
        self.resolve(target, files, false)
    }

    /// For an edit: a changed symbol must have been read again, and a
    /// `path#name` target gets its alias.
    pub fn resolve_for_edit(
        &mut self,
        target: &str,
        files: &WorkspaceFiles,
    ) -> Outcome<ResolvedSymbol> {
        self.resolve(target, files, true)
    }

    fn resolve(
        &mut self,
        target: &str,
        files: &WorkspaceFiles,
        for_edit: bool,
    ) -> Outcome<ResolvedSymbol> {
        if let Some(entry) = self.target_alias(target, files)?.cloned() {
            return self.resolve_alias(&entry, files, for_edit);
        }
        let mut resolved = self.resolve_qualified_target(target, files)?;
        if for_edit {
            resolved.alias =
                Some(self.register_symbol(&resolved.path, &resolved.content, &resolved.symbol));
        }
        Ok(resolved)
    }

    /// `assertObserved`: `range`, relative to the symbol, was read.
    pub fn assert_observed(&self, alias: Option<&str>, range: (usize, usize)) -> Outcome<()> {
        let entry = alias.and_then(|alias| self.get(alias));
        let Some(Alias::Symbol { observed, .. }) = entry else {
            return Err(Failure::symbol(
                "Read the target before replacing it.",
                Vec::new(),
            ));
        };
        let mut intervals = observed.clone().unwrap_or_default();
        intervals.sort_by_key(|interval| interval.0);
        let mut cursor = range.0;
        for (start, end) in intervals {
            if start > cursor {
                break;
            }
            cursor = cursor.max(end);
        }
        if cursor < range.1 {
            return Err(Failure::symbol(
                format!(
                    "Read {} before replacing unobserved source.",
                    alias.unwrap_or("undefined")
                ),
                Vec::new(),
            ));
        }
        Ok(())
    }

    fn target_alias(&self, target: &str, files: &WorkspaceFiles) -> Outcome<Option<&Alias>> {
        if let Some(direct) = self.get(target) {
            return Ok(Some(direct));
        }
        let Some(separator) = target.rfind('#').filter(|index| *index >= 1) else {
            return Ok(None);
        };
        let path = files.normalize_path(&target[..separator])?;
        let name = &target[separator + 1..];
        if let Some(entry @ Alias::Symbol { path: known, .. }) = self.get(name)
            && *known == path
        {
            return Ok(Some(entry));
        }
        let matching: Vec<&Alias> = self
            .aliases
            .iter()
            .filter(|entry| matches!(entry, Alias::Symbol { path: known, qualified_name, .. } if *known == path && qualified_name == name))
            .collect();
        Ok(if matching.len() == 1 {
            Some(matching[0])
        } else {
            None
        })
    }

    fn resolve_alias(
        &mut self,
        entry: &Alias,
        files: &WorkspaceFiles,
        for_edit: bool,
    ) -> Outcome<ResolvedSymbol> {
        let Alias::Symbol {
            alias,
            file_hash,
            path,
            qualified_name,
            ..
        } = entry
        else {
            return Err(Failure::symbol(
                format!(
                    "{} is a {} target, not a symbol.",
                    entry.name(),
                    entry.kind()
                ),
                Vec::new(),
            ));
        };
        let content = Arc::new(files.read(path)?.content);
        let parsed = parse_code(path, &content);
        let exact = sha256_hex(&content) == *file_hash;
        let candidates: Vec<&ParsedSymbol> = parsed
            .symbols
            .iter()
            .filter(|symbol| {
                if exact {
                    same_range(symbol, entry)
                } else {
                    same_identity(symbol, entry)
                }
            })
            .collect();
        if candidates.len() != 1 {
            return Err(resolution_conflict(qualified_name, &candidates));
        }
        let symbol = candidates[0].clone();
        if for_edit && !exact {
            let Alias::Symbol {
                content_hash,
                alias: name,
                qualified_name,
                ..
            } = entry
            else {
                unreachable!("a symbol alias")
            };
            if content_hash.as_deref()
                != Some(sha256_hex(&content[symbol.range.0..symbol.range.1]).as_str())
            {
                let current =
                    String::from_utf8_lossy(&content[symbol.range.0..symbol.range.1]).into_owned();
                return Err(Failure::symbol(
                    format!(
                        "Symbol {qualified_name} changed since it was observed. Read {name} to refresh before editing. Current target:\n{}",
                        crate::text::utf16_prefix(&current, 4_000)
                    ),
                    Vec::new(),
                ));
            }
        }
        if !for_edit {
            self.update_symbol(alias, path, &content, &symbol);
        }
        Ok(ResolvedSymbol {
            alias: Some(alias.clone()),
            content,
            parsed: parsed.clone(),
            symbol,
            path: path.clone(),
        })
    }

    fn resolve_qualified_target(
        &self,
        target: &str,
        files: &WorkspaceFiles,
    ) -> Outcome<ResolvedSymbol> {
        let separator = target.rfind('#');
        let Some(separator) = separator.filter(|index| *index >= 1 && *index != target.len() - 1)
        else {
            return Err(Failure::symbol(
                "Use a symbol alias or path#qualifiedName.",
                Vec::new(),
            ));
        };
        let path = files.normalize_path(&target[..separator])?;
        let qualified_name = &target[separator + 1..];
        let content = Arc::new(files.read(&path)?.content);
        let parsed = parse_code(&path, &content);
        let candidates: Vec<&ParsedSymbol> = parsed
            .symbols
            .iter()
            .filter(|symbol| symbol.qualified_name == qualified_name)
            .collect();
        if candidates.is_empty() {
            let trimmed = crate::text::js_trim(qualified_name);
            let canonical = format!("{path}#{trimmed}");
            let alternatives: Vec<&ParsedSymbol> =
                if !trimmed.is_empty() && trimmed != qualified_name {
                    parsed
                        .symbols
                        .iter()
                        .filter(|symbol| symbol.qualified_name == trimmed)
                        .collect()
                } else {
                    Vec::new()
                };
            let entry = if alternatives.len() == 1 {
                self.target_alias(&canonical, files)?
            } else {
                None
            };
            let safe = match entry {
                None => true,
                Some(Alias::Symbol {
                    qualified_name,
                    file_hash,
                    ..
                }) => qualified_name == trimmed && *file_hash == sha256_hex(&content),
                Some(_) => false,
            };
            let suggestion = if alternatives.len() == 1 && safe {
                format!(
                    " Whitespace around the qualified name prevents an exact match. Suggested read_code input: {}",
                    obj! { "target" => canonical.as_str() }.stringify()
                )
            } else {
                " Use a text search or short file range for source not indexed here.".into()
            };
            return Err(Failure::symbol(
                format!(
                    "No indexed declaration matches {} in {path}.{suggestion}",
                    quote(qualified_name)
                ),
                Vec::new(),
            ));
        }
        if candidates.len() != 1 {
            return Err(resolution_conflict(qualified_name, &candidates));
        }
        let symbol = candidates[0].clone();
        Ok(ResolvedSymbol {
            alias: None,
            content,
            parsed: parsed.clone(),
            symbol,
            path,
        })
    }

    fn next_alias(&mut self) -> String {
        self.sequence += 1;
        format!("s{}", self.sequence)
    }

    fn exact_symbol(&self, path: &str, hash: &str, symbol: &ParsedSymbol) -> Option<String> {
        self.aliases
            .iter()
            .find(|entry| matches!(entry, Alias::Symbol { path: known, file_hash, .. } if known == path && file_hash == hash) && same_range(symbol, entry))
            .map(|entry| entry.name().to_string())
    }

    fn reusable_symbol(&self, path: &str, content: &[u8], symbol: &ParsedSymbol) -> Option<String> {
        let hash = sha256_hex(content);
        if let Some(exact) = self.exact_symbol(path, &hash, symbol) {
            return Some(exact);
        }
        // A same-name declaration is not a unique identity when overloads or
        // other duplicate indexed declarations coexist in the current source.
        let parsed = parse_code(path, content);
        let current = parsed
            .symbols
            .iter()
            .filter(|candidate| {
                candidate.kind == symbol.kind && candidate.qualified_name == symbol.qualified_name
            })
            .count();
        if current != 1 {
            return None;
        }
        let matches: Vec<&Alias> = self
            .aliases
            .iter()
            .filter(|entry| {
                matches!(entry, Alias::Symbol { path: known, .. } if known == path)
                    && same_identity(symbol, entry)
            })
            .collect();
        (matches.len() == 1).then(|| matches[0].name().to_string())
    }

    fn update_symbol(&mut self, alias: &str, path: &str, content: &[u8], symbol: &ParsedSymbol) {
        let previous = self.get(alias).cloned();
        let content_hash = sha256_hex(&content[symbol.range.0..symbol.range.1]);
        let file_hash = sha256_hex(content);
        let mut observed: Option<Vec<Interval>> = None;
        if let Some(Alias::Symbol {
            content_hash: previous_hash,
            observed: previous_observed,
            ..
        }) = &previous
            && previous_hash.as_deref() == Some(content_hash.as_str())
        {
            observed = previous_observed.clone();
        }
        if let Some((_, hash, intervals)) =
            self.observations.iter().find(|(known, _, _)| known == path)
            && *hash == file_hash
        {
            let mut merged = observed.clone().unwrap_or_default();
            merged.extend(
                intervals
                    .iter()
                    .map(|interval| relative_interval(*interval, symbol.range.0, symbol.range.1)),
            );
            observed = Some(merged_intervals(
                merged.into_iter().filter(|(from, to)| to > from).collect(),
            ));
        }
        let next = Alias::Symbol {
            alias: alias.into(),
            content_hash: Some(content_hash),
            end: symbol.range.1,
            file_hash,
            language: semantic_language_name(path),
            path: path.into(),
            qualified_name: symbol.qualified_name.clone(),
            symbol_kind: symbol.kind.into(),
            start: symbol.range.0,
            observed,
        };
        match self.aliases.iter_mut().find(|entry| entry.name() == alias) {
            Some(slot) => *slot = next,
            None => self.aliases.push(next),
        }
    }
}

fn relative_interval((from, to): Interval, start: usize, end: usize) -> Interval {
    let low = from.saturating_sub(start);
    let high = (end - start).min(to.saturating_sub(start));
    // An interval before the symbol ends up empty and is dropped by the caller.
    if to < start { (0, 0) } else { (low, high) }
}

/// Sorted, with overlapping or touching intervals joined (`start <= previous[1]`).
fn merged_intervals(mut intervals: Vec<Interval>) -> Vec<Interval> {
    intervals.sort_by_key(|interval| interval.0);
    let mut output: Vec<Interval> = Vec::new();
    for (start, end) in intervals {
        match output.last_mut() {
            Some(previous) if start <= previous.1 => previous.1 = previous.1.max(end),
            _ => output.push((start, end)),
        }
    }
    output
}

fn alias_sequence(alias: &str) -> usize {
    // `Number.parseInt(alias.slice(1), 10)`: leading digits only.
    let digits: String = alias
        .chars()
        .skip(1)
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse().unwrap_or(0)
}

fn same_identity(symbol: &ParsedSymbol, entry: &Alias) -> bool {
    matches!(entry, Alias::Symbol { symbol_kind, qualified_name, path, language, .. }
        if symbol.kind == symbol_kind && symbol.qualified_name == *qualified_name && semantic_language_name(path) == *language)
}

fn same_range(symbol: &ParsedSymbol, entry: &Alias) -> bool {
    matches!(entry, Alias::Symbol { symbol_kind, start, end, .. }
        if symbol.kind == symbol_kind && symbol.range.0 == *start && symbol.range.1 == *end)
}

fn resolution_conflict(name: &str, candidates: &[&ParsedSymbol]) -> Failure {
    let message = if candidates.is_empty() {
        format!("Symbol {name} no longer exists in its original file.")
    } else {
        format!("Symbol {name} is ambiguous in its original file.")
    };
    Failure::symbol(
        message,
        candidates
            .iter()
            .take(5)
            .map(|symbol| obj! { "kind" => symbol.kind, "line" => symbol.line_range.0, "qualifiedName" => symbol.qualified_name.as_str() })
            .collect(),
    )
}
