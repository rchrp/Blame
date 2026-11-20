//! Symbol navigation helpers (`light-navigation.ts`).

use crate::coverage::Interval;
use crate::syntax::ParsedSymbol;

/// The read_code input after validation.
#[derive(Clone, Debug, Default)]
pub struct ReadInput {
    pub target: String,
    pub view: Option<String>,
    pub offset: Option<u64>,
    /// 1-based inclusive line ranges; `range` given as one object or an array.
    pub ranges: Vec<(usize, usize)>,
}

/// The smallest symbol containing `range`.
pub fn enclosing_symbol(symbols: &[ParsedSymbol], range: Interval) -> Option<usize> {
    let mut candidates: Vec<usize> = symbols
        .iter()
        .enumerate()
        .filter(|(_, symbol)| symbol.range.0 <= range.0 && symbol.range.1 >= range.1)
        .map(|(index, _)| index)
        .collect();
    candidates.sort_by_key(|index| size(&symbols[*index]));
    candidates.first().copied()
}

pub fn outline_candidates(symbols: &[ParsedSymbol]) -> Vec<usize> {
    let structural: Vec<usize> = symbols
        .iter()
        .enumerate()
        .filter(|(_, symbol)| symbol.kind != "css_custom_property")
        .map(|(index, _)| index)
        .collect();
    if structural.is_empty() {
        (0..symbols.len()).collect()
    } else {
        structural
    }
}

/// Up to three symbols a read offers as edit targets.
pub fn edit_target_symbols(symbols: &[ParsedSymbol], intervals: Option<&[Interval]>) -> Vec<usize> {
    let candidates = outline_candidates(symbols);
    if let Some(intervals) = intervals.filter(|intervals| !intervals.is_empty()) {
        return interval_edit_targets(symbols, &candidates, intervals);
    }
    let roots: Vec<usize> = candidates
        .into_iter()
        .filter(|index| symbols[*index].qualified_name == symbols[*index].name)
        .collect();
    let mut chosen: Vec<Option<usize>> = roots.iter().take(2).map(|index| Some(*index)).collect();
    chosen.push(append_symbol(symbols, &roots));
    let mut unique = unique_symbols(symbols, chosen);
    unique.truncate(3);
    unique
}

fn interval_edit_targets(
    symbols: &[ParsedSymbol],
    candidates: &[usize],
    intervals: &[Interval],
) -> Vec<usize> {
    let mut overlapping: Vec<usize> = candidates
        .iter()
        .copied()
        .filter(|index| {
            intervals
                .iter()
                .any(|range| overlaps(symbols[*index].range, *range))
        })
        .collect();
    overlapping.sort_by_key(|index| size(&symbols[*index]));
    let mut fully_read: Vec<usize> = overlapping
        .iter()
        .copied()
        .filter(|index| {
            intervals.iter().any(|(start, end)| {
                *start <= symbols[*index].range.0 && *end >= symbols[*index].range.1
            })
        })
        .collect();
    fully_read.sort_by(|left, right| size(&symbols[*right]).cmp(&size(&symbols[*left])));
    let ranked = unique_symbols(
        symbols,
        fully_read
            .into_iter()
            .chain(overlapping)
            .map(Some)
            .collect(),
    );
    let mut selected: Vec<usize> = Vec::new();
    for index in ranked {
        if !selected
            .iter()
            .any(|chosen| overlaps(symbols[*chosen].range, symbols[index].range))
        {
            selected.push(index);
        }
    }
    selected.truncate(3);
    selected
}

/// The root symbol that ends last: where an append would go.
fn append_symbol(symbols: &[ParsedSymbol], roots: &[usize]) -> Option<usize> {
    let mut sorted = roots.to_vec();
    sorted.sort_by(|left, right| symbols[*right].range.1.cmp(&symbols[*left].range.1));
    sorted.first().copied()
}

fn unique_symbols(symbols: &[ParsedSymbol], chosen: Vec<Option<usize>>) -> Vec<usize> {
    let mut seen: Vec<Interval> = Vec::new();
    let mut output = Vec::new();
    for index in chosen.into_iter().flatten() {
        let range = symbols[index].range;
        if seen.contains(&range) {
            continue;
        }
        seen.push(range);
        output.push(index);
    }
    output
}

fn overlaps(left: Interval, right: Interval) -> bool {
    left.0 < right.1 && right.0 < left.1
}

fn size(symbol: &ParsedSymbol) -> usize {
    symbol.range.1 - symbol.range.0
}

/// `query` is already lower-cased.
pub fn symbol_matches(symbol: &ParsedSymbol, query: &str) -> bool {
    symbol.name.to_lowercase().contains(query)
        || symbol.qualified_name.to_lowercase().contains(query)
}

pub fn qualified_target(value: &str) -> bool {
    value.contains('#') && !value.starts_with('#')
}

/// "auto" folds a file when its folds repay their cost, whatever its size.
pub fn routed_view(input: &ReadInput) -> String {
    if requested_line_range(input) {
        return "range".into();
    }
    input.view.clone().unwrap_or_else(|| "auto".into())
}

pub fn requested_line_range(input: &ReadInput) -> bool {
    input.view.as_deref() == Some("range")
        || (!input.ranges.is_empty()
            && input
                .view
                .as_deref()
                .is_none_or(|view| view == "auto" || view == "raw"))
}
