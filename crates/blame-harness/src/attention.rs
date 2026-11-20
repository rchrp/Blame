//! What the session pointed at in a file: search hits and failing-check lines
//! since its last change, and edited symbols. Bodies the session already
//! pointed at are needed far more often than others (33% against 7.8% after a
//! search hit), so folded views keep them. Mirrors `light-attention.ts`.

use crate::json::Json;
use crate::obj;
use std::collections::HashSet;

const MAXIMUM_PATHS: usize = 200;
const MAXIMUM_LINES: usize = 64;
const MAXIMUM_SYMBOLS: usize = 64;

#[derive(Default, Clone)]
pub struct FoldAttention {
    /// 1-based lines a search hit or a failing check pointed at.
    pub lines: Vec<usize>,
    /// Qualified names of symbols edited in this session.
    pub symbols: HashSet<String>,
}

#[derive(Default)]
pub struct LightAttention {
    pointed: Vec<(String, Vec<usize>)>,
    edited: Vec<(String, Vec<String>)>,
}

/// `[...new Set([...old, ...added])]`: first occurrence order.
fn unique<T: PartialEq + Clone>(values: impl IntoIterator<Item = T>) -> Vec<T> {
    let mut output: Vec<T> = Vec::new();
    for value in values {
        if !output.contains(&value) {
            output.push(value);
        }
    }
    output
}

fn keep_last<T>(mut values: Vec<T>, limit: usize) -> Vec<T> {
    if values.len() > limit {
        values.drain(..values.len() - limit);
    }
    values
}

impl LightAttention {
    pub fn point(&mut self, path: &str, lines: &[usize]) {
        let previous = take(&mut self.pointed, path).unwrap_or_default();
        let merged = unique(
            previous
                .into_iter()
                .chain(lines.iter().copied().filter(|line| *line > 0)),
        );
        self.pointed
            .push((path.into(), keep_last(merged, MAXIMUM_LINES)));
        trim(&mut self.pointed);
    }

    /// The file changed: its lines no longer point where they did.
    pub fn changed(&mut self, path: &str) {
        take(&mut self.pointed, path);
    }

    pub fn edit(&mut self, path: &str, symbols: &[String]) {
        if symbols.is_empty() {
            return;
        }
        let previous = take(&mut self.edited, path).unwrap_or_default();
        let merged = unique(previous.into_iter().chain(symbols.iter().cloned()));
        self.edited
            .push((path.into(), keep_last(merged, MAXIMUM_SYMBOLS)));
        trim(&mut self.edited);
    }

    pub fn for_file(&self, path: &str) -> FoldAttention {
        FoldAttention {
            lines: self
                .pointed
                .iter()
                .find(|(name, _)| name == path)
                .map(|(_, lines)| lines.clone())
                .unwrap_or_default(),
            symbols: self
                .edited
                .iter()
                .find(|(name, _)| name == path)
                .map(|(_, symbols)| symbols.iter().cloned().collect())
                .unwrap_or_default(),
        }
    }

    pub fn snapshot(&self) -> Json {
        obj! {
            "pointed" => Json::Arr(self.pointed.iter().map(|(path, lines)| obj! {
                "path" => path.as_str(),
                "lines" => Json::Arr(lines.iter().map(|line| Json::from(*line)).collect()),
            }).collect()),
            "edited" => Json::Arr(self.edited.iter().map(|(path, symbols)| obj! {
                "path" => path.as_str(),
                "symbols" => Json::Arr(symbols.iter().map(Json::from).collect()),
            }).collect()),
        }
    }

    pub fn hydrate(&mut self, state: Option<&Json>) {
        self.pointed.clear();
        self.edited.clear();
        let Some(state) = state else { return };
        for entry in state
            .get("pointed")
            .and_then(Json::as_array)
            .into_iter()
            .flatten()
        {
            let Some(path) = entry.get("path").and_then(Json::as_str) else {
                continue;
            };
            let lines = entry
                .get("lines")
                .and_then(Json::as_array)
                .map(|lines| {
                    lines
                        .iter()
                        .filter_map(|line| line.as_f64().map(|value| value as usize))
                        .collect()
                })
                .unwrap_or_default();
            set(&mut self.pointed, path, lines);
        }
        for entry in state
            .get("edited")
            .and_then(Json::as_array)
            .into_iter()
            .flatten()
        {
            let Some(path) = entry.get("path").and_then(Json::as_str) else {
                continue;
            };
            let symbols = entry
                .get("symbols")
                .and_then(Json::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(|value| value.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            set(&mut self.edited, path, symbols);
        }
    }
}

fn take<T>(entries: &mut Vec<(String, T)>, path: &str) -> Option<T> {
    let index = entries.iter().position(|(name, _)| name == path)?;
    Some(entries.remove(index).1)
}

fn set<T>(entries: &mut Vec<(String, T)>, path: &str, value: T) {
    match entries.iter_mut().find(|(name, _)| name == path) {
        Some(entry) => entry.1 = value,
        None => entries.push((path.into(), value)),
    }
}

fn trim<T>(entries: &mut Vec<(String, T)>) {
    while entries.len() > MAXIMUM_PATHS {
        entries.remove(0);
    }
}
