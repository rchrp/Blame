//! Folded views (`light-fold-view.ts`, `light-fold-economics.ts`).
//!
//! A folded view prints the file's own lines in order and replaces each body
//! the agent probably does not need with one marker line:
//!
//! ```text
//! export function load(path: string) {
//!   ⋯ L13–40 · 1.2k · s4 ↗ readFile, parse
//! }
//! ```
//!
//! Every other line is the file's exact line. Imports, signatures, closing
//! lines and small statements stay visible; bodies hit by a search, an edit or
//! a failing check stay whole, and so do small type declarations.

use crate::attention::FoldAttention;
use crate::coverage::Interval;
use crate::syntax::{ParseResult, ParsedSymbol, ParsedTree, SgNode, field};
use crate::text::{collapse_spaces, js_trim, utf16_len, utf16_prefix};
use regex::Regex;
use std::sync::LazyLock;

// The thresholds are break-even points of one cost model, measured on 25
// read_code sessions (November 2026); see light-fold-economics.ts for the
// derivation. The arithmetic is kept so the rounding is the same.
const REMAINING_TURNS: f64 = 90.0;
const CONTEXT_TOKENS: f64 = 86_000.0;
const OWN_TURN_SHARE: f64 = 0.5;
const TOKENS_PER_CHARACTER: f64 = 0.45;
const CACHE_WRITE: f64 = 1.25;
const CACHE_READ: f64 = 0.1;
const CALL_OUTPUT_TOKENS: f64 = 250.0;
const CALL_OVERHEAD_CHARACTERS: f64 = 250.0;

fn character_cost() -> f64 {
    TOKENS_PER_CHARACTER * (CACHE_WRITE + CACHE_READ * REMAINING_TURNS)
}

/// One extra read_code call, in stored characters (about 1,240).
pub fn fold_call_characters() -> f64 {
    let call_cost = OWN_TURN_SHARE * CACHE_READ * CONTEXT_TOKENS
        + CALL_OUTPUT_TOKENS
        + CALL_OVERHEAD_CHARACTERS * character_cost();
    (call_cost / character_cost()).round()
}

/// A body folds only when hiding it pays for the call that may unfold it (about 100).
pub fn fold_body_minimum_characters() -> usize {
    let need = 0.075;
    ((need * fold_call_characters()) / (1.0 - need)).round() as usize
}

/// A file folds only when its folds remove at least this many characters (about 2,250).
pub fn fold_file_minimum_characters() -> usize {
    let follow_up_share = 0.75;
    let whole_reread_share = 0.46;
    let fetched_share = 1.24 * 0.17;
    let header_characters = 150.0;
    ((follow_up_share * fold_call_characters() + header_characters)
        / (1.0 - whole_reread_share - (follow_up_share - whole_reread_share) * fetched_share))
        .round() as usize
}

/// An explicit outline pays as soon as it removes more than one call.
pub fn outline_minimum_characters() -> usize {
    fold_call_characters() as usize
}

/// A type declaration up to this size stays visible.
pub const VISIBLE_TYPE_CHARACTERS: usize = 2_000;
/// The most a folded view shows.
pub const FOLD_VIEW_CHARACTERS: usize = 32_000;

#[derive(Clone, Debug)]
pub struct FoldMarker {
    /// 0-based first and last hidden lines.
    pub lines: (usize, usize),
    pub hidden: Interval,
    pub characters: usize,
    /// Index into the parse's symbols.
    pub symbol: Option<usize>,
    pub names: Vec<String>,
    /// One line standing for several members of a container over the view budget.
    pub summary: Option<String>,
}

pub struct FoldPlan {
    pub markers: Vec<FoldMarker>,
    /// Characters the markers remove, net of their own length.
    pub removed: i64,
    /// Bodies that stayed whole because the session pointed at them: (lines, edited?).
    pub kept: Vec<((usize, usize), &'static str)>,
}

pub struct RenderedFold {
    pub text: String,
    pub shown: Vec<Interval>,
    pub markers: Vec<(FoldMarker, String)>,
}

struct Unit<'r> {
    node: SgNode<'r>,
    tree: usize,
    range: Interval,
    interior: Option<(usize, usize)>,
    body: Option<SgNode<'r>>,
    container: bool,
    type_like: bool,
    symbol: Option<usize>,
    depth: usize,
    members: Vec<Unit<'r>>,
}

pub struct Lines<'a> {
    starts: Vec<usize>,
    content: &'a [u8],
}

impl<'a> Lines<'a> {
    pub fn new(content: &'a [u8]) -> Lines<'a> {
        let mut starts = vec![0];
        for (index, byte) in content.iter().enumerate() {
            if *byte == b'\n' && index + 1 < content.len() {
                starts.push(index + 1);
            }
        }
        Lines { starts, content }
    }

    fn text(&self, line: usize) -> String {
        let start = self.starts[line];
        let end = self
            .starts
            .get(line + 1)
            .copied()
            .unwrap_or(self.content.len());
        let text = String::from_utf8_lossy(&self.content[start..end]);
        crate::text::strip_crlf_end(&text).to_string()
    }

    fn line_of(&self, byte: usize) -> usize {
        let (mut low, mut high) = (0usize, self.starts.len() - 1);
        while low < high {
            let middle = (low + high).div_ceil(2);
            if self.starts[middle] <= byte {
                low = middle;
            } else {
                high = middle - 1;
            }
        }
        low
    }

    fn bytes(&self, (first, last): (usize, usize)) -> Interval {
        (
            self.starts[first],
            self.starts
                .get(last + 1)
                .copied()
                .unwrap_or(self.content.len()),
        )
    }

    fn decoded_len(&self, range: Interval) -> usize {
        utf16_len(&String::from_utf8_lossy(&self.content[range.0..range.1]))
    }
}

/// Plans the folds of `window`, a line-aligned byte range: the file, a symbol
/// or a line range. A body larger than half the window is split into its
/// statements, so a dominant component or test suite still shows its parts.
pub fn plan_fold(
    content: &[u8],
    parsed: &ParseResult,
    window: Interval,
    attention: &FoldAttention,
) -> FoldPlan {
    let lines = Lines::new(content);
    let mut imports: Vec<SgNode<'_>> = Vec::new();
    let mut units = Vec::new();
    for (index, tree) in parsed.trees.iter().enumerate() {
        units.extend(window_units(
            tree,
            index,
            window,
            &lines,
            parsed,
            &mut imports,
            0,
        ));
    }
    let window_characters = lines.decoded_len(window);
    let bindings = import_bindings(&imports);
    let mut context = PlanContext {
        content,
        parsed,
        window,
        lines: &lines,
        attention,
        bindings,
        window_characters,
        markers: Vec::new(),
        kept: Vec::new(),
        imports,
    };
    for unit in &units {
        context.visit(unit);
    }
    let disjoint = without_common_names(innermost_markers(context.markers));
    let removed = disjoint
        .iter()
        .map(|marker| marker.characters as i64 - marker_length(marker) as i64)
        .sum();
    FoldPlan {
        markers: disjoint,
        removed,
        kept: context.kept,
    }
}

struct PlanContext<'a, 'r> {
    content: &'a [u8],
    parsed: &'r ParseResult,
    window: Interval,
    lines: &'a Lines<'a>,
    attention: &'a FoldAttention,
    bindings: Vec<String>,
    window_characters: usize,
    markers: Vec<FoldMarker>,
    kept: Vec<((usize, usize), &'static str)>,
    /// Imports split members find after the bindings were taken: kept, unused, as in TypeScript.
    imports: Vec<SgNode<'r>>,
}

impl<'r> PlanContext<'_, 'r> {
    fn visit(&mut self, unit: &Unit<'r>) {
        if unit.container {
            for member in &unit.members {
                self.visit(member);
            }
            return;
        }
        let Some(interior) = unit.interior else {
            return;
        };
        let hidden = self.lines.bytes(interior);
        let text = String::from_utf8_lossy(&self.content[hidden.0..hidden.1]).into_owned();
        let length = utf16_len(&text);
        if 2 * length > self.window_characters && unit.depth < 4 {
            let children = split_members(
                unit,
                self.window,
                self.lines,
                self.parsed,
                &mut self.imports,
            );
            if !children.is_empty() {
                for child in &children {
                    self.visit(child);
                }
                return;
            }
        }
        if length < fold_body_minimum_characters() {
            return;
        }
        if let Some(reason) = attention_reason(unit, interior, self.parsed, self.attention) {
            self.kept.push((interior, reason));
            return;
        }
        if unit.type_like && length <= VISIBLE_TYPE_CHARACTERS {
            return;
        }
        self.markers.push(FoldMarker {
            lines: interior,
            hidden,
            characters: length,
            symbol: unit.symbol,
            names: used_names(&text, &self.bindings),
            summary: None,
        });
    }
}

/// Renders a plan. When the view exceeds the budget, the containers holding
/// the most shown text list one line per member, largest first.
pub fn render_fold(
    content: &[u8],
    parsed: &ParseResult,
    window: Interval,
    plan: &FoldPlan,
    alias: &mut dyn FnMut(&ParsedSymbol) -> Option<String>,
) -> RenderedFold {
    let lines = Lines::new(content);
    let budget = FOLD_VIEW_CHARACTERS;
    let mut markers = plan.markers.clone();
    let mut rendered = render(&lines, window, &markers, parsed, alias);
    if utf16_len(&rendered.text) <= budget {
        return rendered;
    }
    let mut imports = Vec::new();
    let mut top_level = Vec::new();
    for (index, tree) in parsed.trees.iter().enumerate() {
        top_level.extend(window_units(
            tree,
            index,
            window,
            &lines,
            parsed,
            &mut imports,
            0,
        ));
    }
    let mut containers: Vec<&Unit<'_>> = Vec::new();
    fn collect<'u, 'r>(unit: &'u Unit<'r>, output: &mut Vec<&'u Unit<'r>>) {
        if unit.container {
            output.push(unit);
            for member in &unit.members {
                collect(member, output);
            }
        }
    }
    for unit in &top_level {
        collect(unit, &mut containers);
    }
    containers.sort_by_key(|container| std::cmp::Reverse(size(container.range)));
    for container in &containers {
        markers = summarized_members(
            &lines,
            &container.members.iter().collect::<Vec<_>>(),
            markers,
        );
        rendered = render(&lines, window, &markers, parsed, alias);
        if utf16_len(&rendered.text) <= budget {
            return rendered;
        }
    }
    // A long flat file: one line per top-level declaration, containers last.
    let mut imports = Vec::new();
    let mut top = Vec::new();
    for (index, tree) in parsed.trees.iter().enumerate() {
        top.extend(window_units(
            tree,
            index,
            window,
            &lines,
            parsed,
            &mut imports,
            0,
        ));
    }
    let leaves: Vec<&Unit<'_>> = top.iter().filter(|unit| !unit.container).collect();
    markers = summarized_members(&lines, &leaves, markers);
    rendered = render(&lines, window, &markers, parsed, alias);
    // Members still too many: one line per run of members.
    for container in &containers {
        if utf16_len(&rendered.text) <= budget {
            return rendered;
        }
        let runs = runs_for(&rendered, container.range, budget);
        let count = container.members.len().div_ceil(runs);
        markers = grouped_members(
            &lines,
            &container.members.iter().collect::<Vec<_>>(),
            markers,
            count,
            parsed,
        );
        rendered = render(&lines, window, &markers, parsed, alias);
    }
    if utf16_len(&rendered.text) > budget && !top.is_empty() {
        let runs = runs_for(&rendered, window, budget);
        let count = top.len().div_ceil(runs);
        markers = grouped_members(
            &lines,
            &top.iter().collect::<Vec<_>>(),
            markers,
            count,
            parsed,
        );
        rendered = render(&lines, window, &markers, parsed, alias);
    }
    let mut top_containers: Vec<&Unit<'_>> = top.iter().filter(|unit| unit.container).collect();
    top_containers.sort_by_key(|container| size(container.range));
    for container in top_containers {
        if utf16_len(&rendered.text) <= budget {
            break;
        }
        markers = summarized_members(&lines, &[container], markers);
        rendered = render(&lines, window, &markers, parsed, alias);
    }
    rendered
}

/// `Math.max(1, Math.floor((budget - (length - shownIn(range))) / 160))`.
fn runs_for(rendered: &RenderedFold, range: Interval, budget: usize) -> usize {
    let outside = utf16_len(&rendered.text) as f64 - shown_in(rendered, range) as f64;
    (((budget as f64 - outside) / 160.0).floor()).max(1.0) as usize
}

/// Line-aligned byte range covering `range`.
pub fn line_aligned_window(content: &[u8], range: Interval) -> Interval {
    let search_from = range
        .0
        .saturating_sub(1)
        .min(content.len().saturating_sub(1));
    let start = if content.is_empty() {
        None
    } else {
        content[..=search_from]
            .iter()
            .rposition(|byte| *byte == b'\n')
    };
    let start_byte = if range.0 == 0 {
        0
    } else {
        start.map_or(0, |index| index + 1)
    };
    let newline = if range.1 > 0 && content.get(range.1 - 1) == Some(&b'\n') {
        Some(range.1 - 1)
    } else {
        content
            .get(range.1..)
            .and_then(|rest| rest.iter().position(|byte| *byte == b'\n'))
            .map(|index| index + range.1)
    };
    (start_byte, newline.map_or(content.len(), |index| index + 1))
}

/// Markers this renderer prints, to recognise one copied into an edit.
pub static FOLD_MARKER_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*(?:\S.*\s)?⋯ L\d+–\d+ · ").expect("marker pattern"));

fn render(
    lines: &Lines<'_>,
    window: Interval,
    markers: &[FoldMarker],
    parsed: &ParseResult,
    alias: &mut dyn FnMut(&ParsedSymbol) -> Option<String>,
) -> RenderedFold {
    let mut ordered: Vec<&FoldMarker> = markers.iter().collect();
    ordered.sort_by_key(|marker| marker.hidden.0);
    let mut text = String::new();
    let mut shown = Vec::new();
    let mut printed = Vec::new();
    let mut cursor = window.0;
    for marker in ordered {
        if marker.hidden.0 < cursor || marker.hidden.1 > window.1 {
            continue;
        }
        if marker.hidden.0 > cursor {
            shown.push((cursor, marker.hidden.0));
            text.push_str(&String::from_utf8_lossy(
                &lines.content[cursor..marker.hidden.0],
            ));
        }
        let line = marker_text(lines, marker, parsed, alias);
        text.push_str(&line);
        text.push('\n');
        printed.push((marker.clone(), line));
        cursor = marker.hidden.1;
    }
    if cursor < window.1 {
        shown.push((cursor, window.1));
        text.push_str(&String::from_utf8_lossy(&lines.content[cursor..window.1]));
    }
    RenderedFold {
        text,
        shown,
        markers: printed,
    }
}

fn marker_text(
    lines: &Lines<'_>,
    marker: &FoldMarker,
    parsed: &ParseResult,
    alias: &mut dyn FnMut(&ParsedSymbol) -> Option<String>,
) -> String {
    let first = lines.text(marker.lines.0);
    let indent: String = first
        .chars()
        .take_while(|character| *character == ' ' || *character == '\t')
        .collect();
    let target = marker
        .symbol
        .and_then(|index| alias(&parsed.symbols[index]));
    let names = if marker.names.len() > 4 {
        format!(
            "{} +{}",
            marker.names[..4].join(", "),
            marker.names.len() - 4
        )
    } else {
        marker.names.join(", ")
    };
    let head = match &marker.summary {
        Some(summary) => format!("{indent}{summary} "),
        None => indent,
    };
    let mut output = format!(
        "{head}⋯ L{}–{} · {}",
        marker.lines.0 + 1,
        marker.lines.1 + 1,
        compact_size(marker.characters)
    );
    if let Some(target) = target.filter(|target| !target.is_empty()) {
        output.push_str(" · ");
        output.push_str(&target);
    }
    if !names.is_empty() {
        output.push_str(" ↗ ");
        output.push_str(&names);
    }
    output
}

fn marker_length(marker: &FoldMarker) -> usize {
    24 + utf16_len(&marker.names.join(", "))
}

/// `characters < 1000 ? String(n) : (n / 1000).toFixed(n < 10000 ? 1 : 0) + "k"`.
pub fn compact_size(characters: usize) -> String {
    if characters < 1_000 {
        return characters.to_string();
    }
    let digits = if characters < 10_000 { 1 } else { 0 };
    format!("{}k", to_fixed(characters as f64 / 1_000.0, digits))
}

/// `Number.prototype.toFixed` for non-negative values: the nearest decimal
/// of the double's exact value, the larger one on an exact tie, so the first
/// dropped digit of the exact expansion decides.
pub fn to_fixed(value: f64, digits: usize) -> String {
    let exact = format!("{value:.80}");
    let (whole, fraction) = exact.split_once('.').unwrap_or((&exact, ""));
    let mut kept: Vec<u8> = whole.bytes().chain(fraction.bytes().take(digits)).collect();
    if fraction
        .as_bytes()
        .get(digits)
        .is_some_and(|digit| *digit >= b'5')
    {
        let mut index = kept.len();
        loop {
            if index == 0 {
                kept.insert(0, b'1');
                break;
            }
            index -= 1;
            if kept[index] == b'9' {
                kept[index] = b'0';
            } else {
                kept[index] += 1;
                break;
            }
        }
    }
    let split = kept.len() - digits;
    let (integer, decimals) = kept.split_at(split);
    let integer = String::from_utf8_lossy(integer);
    if digits == 0 {
        integer.into_owned()
    } else {
        format!("{integer}.{}", String::from_utf8_lossy(decimals))
    }
}

fn summarized_members(
    lines: &Lines<'_>,
    members: &[&Unit<'_>],
    markers: Vec<FoldMarker>,
) -> Vec<FoldMarker> {
    let mut result = markers;
    // Comment lines just above a member belong to it.
    let mut floor: i64 = -1;
    for member in members {
        let last = lines.line_of(member.range.0.max(member.range.1.saturating_sub(1)));
        let first = leading_line(lines, lines.line_of(member.range.0), floor);
        floor = last as i64;
        if last <= first {
            continue;
        }
        let hidden = lines.bytes((first, last));
        result.retain(|marker| marker.hidden.1 <= hidden.0 || marker.hidden.0 >= hidden.1);
        result.push(FoldMarker {
            lines: (first, last),
            hidden,
            characters: lines.decoded_len(hidden),
            symbol: member.symbol,
            names: Vec::new(),
            summary: Some(compact_line(&lines.text(lines.line_of(member.range.0)))),
        });
    }
    result
}

/// Runs of `count` consecutive members, each on one line naming its first members.
fn grouped_members(
    lines: &Lines<'_>,
    members: &[&Unit<'_>],
    markers: Vec<FoldMarker>,
    count: usize,
    parsed: &ParseResult,
) -> Vec<FoldMarker> {
    let mut result = markers;
    let mut floor: i64 = -1;
    if count == 0 {
        return result;
    }
    for run in members.chunks(count) {
        let first = leading_line(lines, lines.line_of(run[0].range.0), floor);
        let tail = run[run.len() - 1];
        let last = lines.line_of(tail.range.0.max(tail.range.1.saturating_sub(1)));
        floor = last as i64;
        let hidden = lines.bytes((first, last));
        result.retain(|marker| marker.hidden.1 <= hidden.0 || marker.hidden.0 >= hidden.1);
        let names: Vec<String> = run
            .iter()
            .take(3)
            .map(|member| match member.symbol {
                Some(index) => parsed.symbols[index].name.clone(),
                None => utf16_prefix(
                    &compact_line(&lines.text(lines.line_of(member.range.0))),
                    30,
                )
                .to_string(),
            })
            .collect();
        result.push(FoldMarker {
            lines: (first, last),
            hidden,
            characters: lines.decoded_len(hidden),
            symbol: None,
            names: Vec::new(),
            summary: Some(format!(
                "{} members: {}{}",
                run.len(),
                names.join(", "),
                if run.len() > 3 { ", …" } else { "" }
            )),
        });
    }
    result
}

static COMMENT_OR_BLANK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*(?:$|//|/\*|\*|#)").expect("pattern"));

/// The first line of a member with the comments and blank lines just above it, after `floor`.
fn leading_line(lines: &Lines<'_>, first: usize, floor: i64) -> usize {
    let mut line = first;
    while line as i64 - 1 > floor && COMMENT_OR_BLANK.is_match(&lines.text(line - 1)) {
        line -= 1;
    }
    line
}

fn shown_in(rendered: &RenderedFold, range: Interval) -> usize {
    let shown: usize = rendered
        .shown
        .iter()
        .map(|(start, end)| (*end).min(range.1).saturating_sub((*start).max(range.0)))
        .sum();
    let markers: usize = rendered
        .markers
        .iter()
        .filter(|(marker, _)| marker.hidden.0 >= range.0 && marker.hidden.1 <= range.1)
        .map(|(_, text)| utf16_len(text) + 1)
        .sum();
    shown + markers
}

fn compact_line(line: &str) -> String {
    let collapsed = collapse_spaces(js_trim(line));
    if utf16_len(&collapsed) > 120 {
        format!("{}…", utf16_prefix(&collapsed, 119))
    } else {
        collapsed
    }
}

/// A name most folded bodies use (assert, React, a logger) tells nothing about any one of them.
fn without_common_names(markers: Vec<FoldMarker>) -> Vec<FoldMarker> {
    if markers.len() < 4 {
        return markers;
    }
    let mut counts: Vec<(String, usize)> = Vec::new();
    for marker in &markers {
        for name in &marker.names {
            match counts.iter_mut().find(|(known, _)| known == name) {
                Some(entry) => entry.1 += 1,
                None => counts.push((name.clone(), 1)),
            }
        }
    }
    let total = markers.len();
    markers
        .into_iter()
        .map(|mut marker| {
            marker.names.retain(|name| {
                counts
                    .iter()
                    .find(|(known, _)| known == name)
                    .map_or(0, |entry| entry.1)
                    * 2
                    <= total
            });
            marker
        })
        .collect()
}

/// Folds never nest: an outer fold containing another one gives way to it.
fn innermost_markers(markers: Vec<FoldMarker>) -> Vec<FoldMarker> {
    let inner: Vec<FoldMarker> = markers
        .iter()
        .enumerate()
        .filter(|(index, marker)| {
            !markers.iter().enumerate().any(|(other_index, other)| {
                other_index != *index
                    && other.hidden.0 >= marker.hidden.0
                    && other.hidden.1 <= marker.hidden.1
                    && (other.hidden.0 != marker.hidden.0 || other.hidden.1 != marker.hidden.1)
            })
        })
        .map(|(_, marker)| marker.clone())
        .collect();
    let mut output: Vec<FoldMarker> = Vec::new();
    for (index, marker) in inner.iter().enumerate() {
        if !inner[..index]
            .iter()
            .any(|other| other.hidden.0 < marker.hidden.1 && marker.hidden.0 < other.hidden.1)
        {
            output.push(marker.clone());
        }
    }
    output
}

fn attention_reason(
    unit: &Unit<'_>,
    interior: (usize, usize),
    parsed: &ParseResult,
    attention: &FoldAttention,
) -> Option<&'static str> {
    if let Some(index) = unit.symbol
        && attention
            .symbols
            .contains(&parsed.symbols[index].qualified_name)
    {
        return Some("edited");
    }
    let (first, last) = interior;
    // `line - 1` is the 0-based line; lines are 1-based, never 0.
    attention
        .lines
        .iter()
        .any(|line| *line > first && line - 1 <= last)
        .then_some("pointed")
}

fn window_units<'r>(
    tree: &'r ParsedTree,
    tree_index: usize,
    window: Interval,
    lines: &Lines<'_>,
    parsed: &'r ParseResult,
    imports: &mut Vec<SgNode<'r>>,
    depth: usize,
) -> Vec<Unit<'r>> {
    let mut units = Vec::new();
    // The walk's state is passed along, as the closure it ports captured it.
    #[allow(clippy::too_many_arguments)]
    fn visit<'r>(
        node: &SgNode<'r>,
        tree: &'r ParsedTree,
        tree_index: usize,
        window: Interval,
        lines: &Lines<'_>,
        parsed: &'r ParseResult,
        imports: &mut Vec<SgNode<'r>>,
        depth: usize,
        units: &mut Vec<Unit<'r>>,
    ) {
        for child in node.children() {
            if !child.is_named() {
                continue;
            }
            let range = tree.node_range(&child);
            if range.1 <= window.0 || range.0 >= window.1 {
                continue;
            }
            if range.0 < window.0 || range.1 > window.1 {
                visit(
                    &child, tree, tree_index, window, lines, parsed, imports, depth, units,
                );
                continue;
            }
            if IMPORT_KINDS.contains(&child.kind().as_ref()) {
                imports.push(child);
                continue;
            }
            if let Some(unit) = node_unit(child, tree, tree_index, lines, parsed, imports, depth) {
                units.push(unit);
            }
        }
    }
    let root = tree.root.root();
    visit(
        &root, tree, tree_index, window, lines, parsed, imports, depth, &mut units,
    );
    units
}

fn split_members<'r>(
    unit: &Unit<'r>,
    window: Interval,
    lines: &Lines<'_>,
    parsed: &'r ParseResult,
    imports: &mut Vec<SgNode<'r>>,
) -> Vec<Unit<'r>> {
    let tree = &parsed.trees[unit.tree];
    let body = unit.body.clone().unwrap_or_else(|| unit.node.clone());
    body.children()
        .filter(|child| child.is_named())
        .filter_map(|child| {
            let range = tree.node_range(&child);
            if range.1 <= window.0 || range.0 >= window.1 {
                return None;
            }
            node_unit(
                child,
                tree,
                unit.tree,
                lines,
                parsed,
                imports,
                unit.depth + 1,
            )
        })
        .collect()
}

fn node_unit<'r>(
    node: SgNode<'r>,
    tree: &'r ParsedTree,
    tree_index: usize,
    lines: &Lines<'_>,
    parsed: &'r ParseResult,
    imports: &mut Vec<SgNode<'r>>,
    depth: usize,
) -> Option<Unit<'r>> {
    if node.kind() == "comment" {
        return None;
    }
    let range = tree.node_range(&node);
    let declaration = declaration_of(node.clone());
    let declaration_kind = declaration.kind().into_owned();
    let symbol = declaring_symbol(parsed, range, &declaration, tree);
    let container_body = if CONTAINER_KINDS.contains(&declaration_kind.as_str())
        || element_container(&declaration)
    {
        container_body_of(&declaration)
    } else {
        None
    };
    if let Some(container_body) = container_body {
        let mut members = Vec::new();
        for child in container_body.children() {
            if !child.is_named() || ["start_tag", "end_tag"].contains(&child.kind().as_ref()) {
                continue;
            }
            if IMPORT_KINDS.contains(&child.kind().as_ref()) {
                imports.push(child);
                continue;
            }
            if let Some(member) =
                node_unit(child, tree, tree_index, lines, parsed, imports, depth + 1)
            {
                members.push(member);
            }
        }
        return Some(Unit {
            node,
            tree: tree_index,
            range,
            interior: None,
            body: None,
            container: true,
            type_like: false,
            symbol,
            depth,
            members,
        });
    }
    let body = leaf_body(&declaration);
    let body_start = body
        .as_ref()
        .map_or(range.0, |body| tree.node_range(body).0);
    Some(Unit {
        interior: interior_of(lines, range, body_start),
        node,
        tree: tree_index,
        range,
        body,
        container: false,
        type_like: TYPE_KINDS.contains(&declaration_kind.as_str()),
        symbol,
        depth,
        members: Vec::new(),
    })
}

/// Lines strictly between the header (up to the body's opening) and a closing line.
fn interior_of(lines: &Lines<'_>, range: Interval, body_start: usize) -> Option<(usize, usize)> {
    let mut header = lines.line_of(body_start) as i64;
    let before = String::from_utf8_lossy(&lines.content[lines.starts[header as usize]..body_start])
        .into_owned();
    if js_trim(&before).is_empty() && body_start > range.0 {
        header -= 1;
    }
    let last = lines.line_of(range.0.max(range.1.saturating_sub(1))) as i64;
    let tail = if closing_line(&lines.text(last as usize)) {
        last - 1
    } else {
        last
    };
    (tail > header).then(|| ((header + 1) as usize, tail as usize))
}

static CLOSING_KEYWORD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:end|fi|done|esac)(?-u:\b)").expect("pattern"));

fn closing_line(line: &str) -> bool {
    let trimmed = js_trim(line);
    trimmed.starts_with(['}', ']', ')', '>'])
        || CLOSING_KEYWORD.is_match(trimmed)
        || trimmed.starts_with("</")
}

fn declaration_of(node: SgNode<'_>) -> SgNode<'_> {
    let kind = node.kind().into_owned();
    if kind == "export_statement" {
        let inner = node.children().find(|child| {
            child.is_named() && !["comment", "decorator"].contains(&child.kind().as_ref())
        });
        return match inner {
            Some(inner) => declaration_of(inner),
            None => node,
        };
    }
    if kind == "decorated_definition" {
        return field(&node, "definition").unwrap_or(node);
    }
    if kind == "lexical_declaration" || kind == "variable_declaration" {
        let declarators: Vec<SgNode<'_>> = node
            .children()
            .filter(|child| child.kind() == "variable_declarator")
            .collect();
        return if declarators.len() == 1 {
            declarators.into_iter().next().expect("one declarator")
        } else {
            node
        };
    }
    if kind == "expression_statement" {
        let first = node.children().find(|child| child.is_named());
        return first.unwrap_or(node);
    }
    node
}

fn leaf_body<'r>(node: &SgNode<'r>) -> Option<SgNode<'r>> {
    let kind = node.kind();
    let kind = kind.as_ref();
    if [
        "variable_declarator",
        "public_field_definition",
        "field_definition",
        "pair",
        "assignment_expression",
    ]
    .contains(&kind)
    {
        let value = field(node, "value").or_else(|| field(node, "right"))?;
        return Some(if FUNCTION_KINDS.contains(&value.kind().as_ref()) {
            field(&value, "body").unwrap_or(value)
        } else {
            value
        });
    }
    if kind == "call_expression" {
        let args = field(node, "arguments");
        let last = args
            .as_ref()
            .and_then(|args| args.children().filter(|child| child.is_named()).last());
        if let Some(last) = last.filter(|last| FUNCTION_KINDS.contains(&last.kind().as_ref())) {
            return Some(field(&last, "body").unwrap_or(last));
        }
        return args;
    }
    if ["element", "script_element", "style_element"].contains(&kind) {
        let start = node.children().find(|child| child.kind() == "start_tag")?;
        return start.next();
    }
    field(node, "body").or_else(|| {
        node.children()
            .find(|child| BODY_KINDS.contains(&child.kind().as_ref()))
    })
}

fn container_body_of<'r>(node: &SgNode<'r>) -> Option<SgNode<'r>> {
    if element_container(node) {
        return Some(node.clone());
    }
    field(node, "body").or_else(|| {
        node.children()
            .find(|child| BODY_KINDS.contains(&child.kind().as_ref()))
    })
}

fn element_container(node: &SgNode<'_>) -> bool {
    node.kind() == "element" && node.children().any(|child| child.kind() == "element")
}

fn declaring_symbol(
    parsed: &ParseResult,
    range: Interval,
    declaration: &SgNode<'_>,
    tree: &ParsedTree,
) -> Option<usize> {
    let start = tree.node_range(declaration).0;
    let mut candidates: Vec<usize> = parsed
        .symbols
        .iter()
        .enumerate()
        .filter(|(_, symbol)| {
            symbol.range.0 >= range.0
                && symbol.range.1 <= range.1
                && symbol.range.0 <= start + 1
                && symbol.kind != "css_custom_property"
        })
        .map(|(index, _)| index)
        .collect();
    candidates.sort_by(|left, right| {
        size(parsed.symbols[*right].range).cmp(&size(parsed.symbols[*left].range))
    });
    candidates.first().copied()
}

/// Local names an import statement binds.
fn import_bindings(imports: &[SgNode<'_>]) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    let add = |names: &mut Vec<String>, name: String| {
        if !names.contains(&name) {
            names.push(name);
        }
    };
    for statement in imports {
        let kind = statement.kind().into_owned();
        // Types say little about what a body does.
        if kind == "import_statement" && statement.children().any(|child| child.kind() == "type") {
            continue;
        }
        let clause = statement
            .children()
            .find(|child| child.kind() == "import_clause");
        if kind == "import_statement"
            && let Some(clause) = &clause
        {
            walk_nodes(clause, &mut |node| {
                let node_kind = node.kind();
                if node_kind == "import_specifier" {
                    if node.children().any(|child| child.kind() == "type") {
                        return false;
                    }
                    if let Some(local) = field(node, "alias").or_else(|| field(node, "name")) {
                        add(&mut names, local.text().into_owned());
                    }
                    return false;
                }
                if node_kind == "identifier" {
                    add(&mut names, node.text().into_owned());
                }
                true
            });
        } else if kind == "import_from_statement" || kind == "import_statement" {
            let module = field(statement, "module_name").map(|module| module.range().start);
            for child in statement.children() {
                if !child.is_named() || module == Some(child.range().start) {
                    continue;
                }
                if child.kind() == "aliased_import" {
                    if let Some(alias) = field(&child, "alias") {
                        add(&mut names, alias.text().into_owned());
                    }
                } else if child.kind() == "dotted_name" {
                    let text = child.text();
                    let parts: Vec<&str> = text.split('.').collect();
                    let name = if kind == "import_statement" {
                        parts[0]
                    } else {
                        parts[parts.len() - 1]
                    };
                    add(&mut names, name.to_string());
                }
            }
        } else if kind == "use_declaration" {
            walk_nodes(statement, &mut |node| {
                if node.kind() == "identifier" && node.next().is_none_or(|next| next.kind() != "::")
                {
                    add(&mut names, node.text().into_owned());
                }
                true
            });
        }
    }
    names.retain(|name| !name.is_empty());
    names
}

fn walk_nodes<'r>(node: &SgNode<'r>, visit: &mut dyn FnMut(&SgNode<'r>) -> bool) {
    for child in node.children() {
        if visit(&child) {
            walk_nodes(&child, visit);
        }
    }
}

fn is_word(character: char) -> bool {
    character.is_ascii_alphanumeric() || character == '_' || character == '$'
}

/// Bindings used as whole words: `(?<![\w$])name(?![\w$])`.
fn used_names(text: &str, bindings: &[String]) -> Vec<String> {
    bindings
        .iter()
        .filter(|name| {
            text.match_indices(name.as_str()).any(|(index, found)| {
                let before = text[..index].chars().next_back();
                let after = text[index + found.len()..].chars().next();
                !before.is_some_and(is_word) && !after.is_some_and(is_word)
            })
        })
        .cloned()
        .collect()
}

fn size((start, end): Interval) -> usize {
    end - start
}

const IMPORT_KINDS: [&str; 10] = [
    "import_statement",
    "import_declaration",
    "import_from_statement",
    "future_import_statement",
    "use_declaration",
    "extern_crate_declaration",
    "preproc_include",
    "package_clause",
    "package_declaration",
    "using_directive",
];

const CONTAINER_KINDS: [&str; 16] = [
    "class_declaration",
    "abstract_class_declaration",
    "class",
    "class_definition",
    "class_specifier",
    "struct_specifier",
    "impl_item",
    "trait_item",
    "mod_item",
    "namespace_declaration",
    "namespace_definition",
    "file_scoped_namespace_declaration",
    "internal_module",
    "module",
    "media_statement",
    "object_declaration",
];

const TYPE_KINDS: [&str; 8] = [
    "interface_declaration",
    "type_alias_declaration",
    "enum_declaration",
    "enum_item",
    "struct_item",
    "type_declaration",
    "type_spec",
    "enum_specifier",
];

const FUNCTION_KINDS: [&str; 5] = [
    "arrow_function",
    "function_expression",
    "function",
    "generator_function",
    "lambda",
];

const BODY_KINDS: [&str; 9] = [
    "block",
    "statement_block",
    "class_body",
    "declaration_list",
    "interface_body",
    "enum_body",
    "object_type",
    "field_declaration_list",
    "keyframe_block_list",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn economics_match_the_typescript_constants() {
        assert_eq!(fold_call_characters(), 1236.0);
        assert_eq!(fold_body_minimum_characters(), 100);
        assert_eq!(fold_file_minimum_characters(), 2249);
    }

    #[test]
    fn to_fixed_rounds_ties_up_like_javascript() {
        assert_eq!(to_fixed(1.25, 1), "1.3");
        assert_eq!(to_fixed(1.15, 1), "1.1");
        assert_eq!(to_fixed(12.5, 0), "13");
        assert_eq!(compact_size(2_249), "2.2k");
        assert_eq!(compact_size(999), "999");
        assert_eq!(to_fixed(9.96, 1), "10.0");
        assert_eq!(to_fixed(1.05, 1), "1.1");
    }

    #[test]
    fn aligns_windows_to_lines() {
        let content = b"ab\ncd\nef";
        assert_eq!(line_aligned_window(content, (4, 5)), (3, 6));
        assert_eq!(line_aligned_window(content, (0, 8)), (0, 8));
        assert_eq!(line_aligned_window(content, (3, 6)), (3, 6));
    }
}
