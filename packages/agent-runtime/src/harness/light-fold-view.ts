import type { SgNode } from "@ast-grep/napi";
import { nodeByteRange, type ParseResult, type ParsedSymbol, type ParsedTree } from "./code-intelligence.js";
import {
  foldBodyMinimumCharacters,
  foldViewCharacters,
  visibleTypeCharacters,
} from "./light-fold-economics.js";
import type { ByteInterval } from "./read-coverage.js";

/**
 * A folded view prints the file's own lines in order and replaces each body
 * the agent probably does not need with one marker line:
 *
 *     export function load(path: string) {
 *       ⋯ L13–40 · 1.2k · s4 ↗ readFile, parse
 *     }
 *
 * Every other line is the file's exact line. Imports, signatures, closing
 * lines and small statements stay visible; bodies hit by a search, an edit or
 * a failing check stay whole, and so do small type declarations.
 */

export type FoldAttention = {
  /** 1-based lines a search hit or a failing check pointed at. */
  lines: ReadonlySet<number>;
  /** Qualified names of symbols edited in this session. */
  symbols: ReadonlySet<string>;
};

export type FoldMarker = {
  /** 0-based first and last hidden lines. */
  lines: [number, number];
  hidden: ByteInterval;
  characters: number;
  symbol?: ParsedSymbol;
  names: string[];
  /** One line standing for several members of a container over the view budget. */
  summary?: string;
};

export type FoldPlan = {
  markers: FoldMarker[];
  /** Characters the markers remove, net of their own length. */
  removed: number;
  /** Bodies that stayed whole because the session pointed at them. */
  kept: Array<{ lines: [number, number]; reason: "edited" | "pointed" }>;
};

export type RenderedFold = {
  text: string;
  shown: ByteInterval[];
  markers: Array<FoldMarker & { text: string }>;
};

type Unit = {
  node: SgNode;
  tree: ParsedTree;
  range: ByteInterval;
  /** 0-based lines hidden when the unit folds, if any. */
  interior?: [number, number];
  body?: SgNode;
  container: boolean;
  typeLike: boolean;
  symbol?: ParsedSymbol;
  depth: number;
  members: Unit[];
};

type Lines = { starts: number[]; content: Buffer; text: (line: number) => string };

/**
 * Plans the folds of `window`, a line-aligned byte range: the file, a symbol
 * or a line range. A body larger than half the window is split into its
 * statements, so a dominant component or test suite still shows its parts.
 */
export function planFold(
  content: Buffer,
  parsed: ParseResult,
  window: ByteInterval,
  attention: FoldAttention,
): FoldPlan {
  const lines = lineIndex(content);
  const imports: SgNode[] = [];
  const units = parsed.trees.flatMap((tree) => windowUnits(tree, window, lines, parsed.symbols, imports, 0));
  const windowCharacters = content.subarray(...window).toString("utf8").length;
  const markers: FoldMarker[] = [];
  const kept: FoldPlan["kept"] = [];
  const bindings = importBindings(imports);
  const visit = (unit: Unit) => {
    if (unit.container) return unit.members.forEach(visit);
    if (!unit.interior) return;
    const hidden = lineBytes(lines, unit.interior);
    const text = content.subarray(...hidden).toString("utf8");
    if (text.length > windowCharacters / 2 && unit.depth < 4) {
      const children = splitMembers(unit, window, lines, parsed.symbols, imports);
      if (children.length) return children.forEach(visit);
    }
    if (text.length < foldBodyMinimumCharacters) return;
    const reason = attentionReason(unit, attention);
    if (reason) {
      kept.push({ lines: unit.interior, reason });
      return;
    }
    if (unit.typeLike && text.length <= visibleTypeCharacters) return;
    markers.push({
      lines: unit.interior,
      hidden,
      characters: text.length,
      ...(unit.symbol ? { symbol: unit.symbol } : {}),
      names: usedNames(text, bindings),
    });
  };
  units.forEach(visit);
  const disjoint = withoutCommonNames(innermostMarkers(markers));
  return {
    markers: disjoint,
    removed: disjoint.reduce((sum, marker) => sum + marker.characters - markerLength(marker), 0),
    kept,
  };
}

/**
 * Renders a plan. When the view exceeds the budget, the containers holding
 * the most shown text list one line per member, largest first.
 */
export function renderFold(
  content: Buffer,
  parsed: ParseResult,
  window: ByteInterval,
  plan: FoldPlan,
  alias: (symbol: ParsedSymbol) => string | undefined,
): RenderedFold {
  const lines = lineIndex(content);
  let markers = plan.markers;
  let rendered = render(lines, window, markers, alias);
  if (rendered.text.length <= foldViewCharacters) return rendered;
  const imports: SgNode[] = [];
  const containers = parsed.trees
    .flatMap((tree) => windowUnits(tree, window, lines, parsed.symbols, imports, 0))
    .flatMap(function collect(unit): Unit[] {
      return unit.container ? [unit, ...unit.members.flatMap(collect)] : [];
    })
    .sort((left, right) => size(right.range) - size(left.range));
  for (const container of containers) {
    markers = summarizedContainer(lines, container, markers);
    rendered = render(lines, window, markers, alias);
    if (rendered.text.length <= foldViewCharacters) return rendered;
  }
  // A long flat file: one line per top-level declaration, containers last.
  const top = parsed.trees.flatMap((tree) => windowUnits(tree, window, lines, parsed.symbols, imports, 0));
  markers = summarizedMembers(lines, top.filter((unit) => !unit.container), markers);
  rendered = render(lines, window, markers, alias);
  // Members still too many: one line per run of members.
  for (const container of containers) {
    if (rendered.text.length <= foldViewCharacters) return rendered;
    const runs = Math.max(1, Math.floor((foldViewCharacters - (rendered.text.length - shownIn(rendered, container.range))) / 160));
    markers = groupedMembers(lines, container.members, markers, Math.ceil(container.members.length / runs));
    rendered = render(lines, window, markers, alias);
  }
  if (rendered.text.length > foldViewCharacters && top.length) {
    const runs = Math.max(1, Math.floor((foldViewCharacters - (rendered.text.length - shownIn(rendered, window))) / 160));
    markers = groupedMembers(lines, top, markers, Math.ceil(top.length / runs));
    rendered = render(lines, window, markers, alias);
  }
  for (const container of top.filter((unit) => unit.container).sort((left, right) => size(left.range) - size(right.range))) {
    if (rendered.text.length <= foldViewCharacters) break;
    markers = summarizedMembers(lines, [container], markers);
    rendered = render(lines, window, markers, alias);
  }
  return rendered;
}

/** Line-aligned byte range covering `range`. */
export function lineAlignedWindow(content: Buffer, range: ByteInterval): ByteInterval {
  const start = content.lastIndexOf(10, Math.max(0, range[0] - 1));
  const startByte = range[0] === 0 ? 0 : start < 0 ? 0 : start + 1;
  const newline = range[1] > 0 && content[range[1] - 1] === 10 ? range[1] - 1 : content.indexOf(10, range[1]);
  return [startByte, newline < 0 ? content.byteLength : newline + 1];
}

/** Markers this renderer prints, to recognise one copied into an edit. */
export const foldMarkerPattern = /^\s*(?:\S.*\s)?⋯ L\d+–\d+ · /u;

function render(
  lines: Lines,
  window: ByteInterval,
  markers: FoldMarker[],
  alias: (symbol: ParsedSymbol) => string | undefined,
): RenderedFold {
  const ordered = [...markers].sort((left, right) => left.hidden[0] - right.hidden[0]);
  const parts: string[] = [];
  const shown: ByteInterval[] = [];
  const printed: RenderedFold["markers"] = [];
  let cursor = window[0];
  for (const marker of ordered) {
    if (marker.hidden[0] < cursor || marker.hidden[1] > window[1]) continue;
    if (marker.hidden[0] > cursor) {
      shown.push([cursor, marker.hidden[0]]);
      parts.push(lines.content.subarray(cursor, marker.hidden[0]).toString("utf8"));
    }
    const text = markerText(lines, marker, alias);
    printed.push({ ...marker, text });
    parts.push(`${text}\n`);
    cursor = marker.hidden[1];
  }
  if (cursor < window[1]) {
    shown.push([cursor, window[1]]);
    parts.push(lines.content.subarray(cursor, window[1]).toString("utf8"));
  }
  return { text: parts.join(""), shown, markers: printed };
}

function markerText(lines: Lines, marker: FoldMarker, alias: (symbol: ParsedSymbol) => string | undefined) {
  const first = lines.text(marker.lines[0]);
  const indent = /^[ \t]*/u.exec(first)?.[0] ?? "";
  const target = marker.symbol ? alias(marker.symbol) : undefined;
  const names = marker.names.length > 4
    ? `${marker.names.slice(0, 4).join(", ")} +${marker.names.length - 4}`
    : marker.names.join(", ");
  const head = marker.summary ? `${indent}${marker.summary} ` : indent;
  return `${head}⋯ L${marker.lines[0] + 1}–${marker.lines[1] + 1} · ${compactSize(marker.characters)}` +
    `${target ? ` · ${target}` : ""}${names ? ` ↗ ${names}` : ""}`;
}

function markerLength(marker: FoldMarker) {
  return 24 + marker.names.join(", ").length;
}

function compactSize(characters: number) {
  return characters < 1_000 ? String(characters) : `${(characters / 1_000).toFixed(characters < 10_000 ? 1 : 0)}k`;
}

/** Container members, each on one line, replacing their folds. */
function summarizedContainer(lines: Lines, container: Unit, markers: FoldMarker[]) {
  return summarizedMembers(lines, container.members, markers);
}

function summarizedMembers(lines: Lines, members: Unit[], markers: FoldMarker[]) {
  let result = markers;
  // Comment lines just above a member belong to it.
  let floor = -1;
  for (const member of members) {
    const last = lineOf(lines, Math.max(member.range[0], member.range[1] - 1));
    const first = leadingLine(lines, lineOf(lines, member.range[0]), floor);
    floor = last;
    if (last <= first) continue;
    const hidden = lineBytes(lines, [first, last]);
    result = result.filter((marker) => marker.hidden[1] <= hidden[0] || marker.hidden[0] >= hidden[1]);
    result.push({
      lines: [first, last],
      hidden,
      characters: lines.content.subarray(...hidden).toString("utf8").length,
      ...(member.symbol ? { symbol: member.symbol } : {}),
      names: [],
      summary: compactLine(lines.text(lineOf(lines, member.range[0]))),
    });
  }
  return result;
}

/** Runs of `count` consecutive members, each on one line naming its first members. */
function groupedMembers(lines: Lines, members: Unit[], markers: FoldMarker[], count: number) {
  let result = markers;
  // Comment lines just above a member belong to it.
  let floor = -1;
  for (let index = 0; index < members.length; index += count) {
    const run = members.slice(index, index + count);
    const first = leadingLine(lines, lineOf(lines, run[0]!.range[0]), floor);
    const last = lineOf(lines, Math.max(run.at(-1)!.range[0], run.at(-1)!.range[1] - 1));
    floor = last;
    const hidden = lineBytes(lines, [first, last]);
    result = result.filter((marker) => marker.hidden[1] <= hidden[0] || marker.hidden[0] >= hidden[1]);
    const names = run.slice(0, 3).map((member) => member.symbol?.name ?? compactLine(lines.text(lineOf(lines, member.range[0]))).slice(0, 30));
    result.push({
      lines: [first, last],
      hidden,
      characters: lines.content.subarray(...hidden).toString("utf8").length,
      names: [],
      summary: `${run.length} members: ${names.join(", ")}${run.length > 3 ? ", …" : ""}`,
    });
  }
  return result;
}

/** The first line of a member with the comments and blank lines just above it, after `floor`. */
function leadingLine(lines: Lines, first: number, floor: number) {
  let line = first;
  while (line - 1 > floor && /^\s*(?:$|\/\/|\/\*|\*|#)/u.test(lines.text(line - 1))) line -= 1;
  return line;
}

function shownIn(rendered: RenderedFold, range: ByteInterval) {
  return rendered.shown.reduce((sum, [start, end]) => sum + Math.max(0, Math.min(end, range[1]) - Math.max(start, range[0])), 0) +
    rendered.markers.filter((marker) => marker.hidden[0] >= range[0] && marker.hidden[1] <= range[1])
      .reduce((sum, marker) => sum + marker.text.length + 1, 0);
}

function compactLine(line: string) {
  const trimmed = line.trim().replace(/\s+/gu, " ");
  return trimmed.length > 120 ? `${trimmed.slice(0, 119)}…` : trimmed;
}

/** A name most folded bodies use (assert, React, a logger) tells nothing about any one of them. */
function withoutCommonNames(markers: FoldMarker[]) {
  if (markers.length < 4) return markers;
  const counts = new Map<string, number>();
  for (const marker of markers) for (const name of marker.names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return markers.map((marker) => ({
    ...marker,
    names: marker.names.filter((name) => counts.get(name)! * 2 <= markers.length),
  }));
}

/** Folds never nest: an outer fold containing another one gives way to it. */
function innermostMarkers(markers: FoldMarker[]) {
  return markers.filter((marker) => !markers.some((other) => other !== marker &&
    other.hidden[0] >= marker.hidden[0] && other.hidden[1] <= marker.hidden[1] &&
    (other.hidden[0] !== marker.hidden[0] || other.hidden[1] !== marker.hidden[1])))
    .filter((marker, index, all) => !all.slice(0, index).some((other) =>
      other.hidden[0] < marker.hidden[1] && marker.hidden[0] < other.hidden[1]));
}

function attentionReason(unit: Unit, attention: FoldAttention): FoldPlan["kept"][number]["reason"] | undefined {
  if (unit.symbol && attention.symbols.has(unit.symbol.qualified_name)) return "edited";
  const [first, last] = unit.interior!;
  for (const line of attention.lines) if (line - 1 >= first && line - 1 <= last) return "pointed";
  return undefined;
}

function windowUnits(
  tree: ParsedTree,
  window: ByteInterval,
  lines: Lines,
  symbols: ParsedSymbol[],
  imports: SgNode[],
  depth: number,
): Unit[] {
  const units: Unit[] = [];
  const visit = (node: SgNode) => {
    for (const child of node.children()) {
      if (!child.isNamed()) continue;
      const range = nodeByteRange(child, tree);
      if (range[1] <= window[0] || range[0] >= window[1]) continue;
      if (range[0] < window[0] || range[1] > window[1]) {
        visit(child);
        continue;
      }
      if (importKinds.has(String(child.kind()))) {
        imports.push(child);
        continue;
      }
      const unit = nodeUnit(child, tree, lines, symbols, imports, depth);
      if (unit) units.push(unit);
    }
  };
  visit(tree.root);
  return units;
}

function splitMembers(unit: Unit, window: ByteInterval, lines: Lines, symbols: ParsedSymbol[], imports: SgNode[]) {
  const body = unit.body ?? unit.node;
  return body.children()
    .filter((child) => child.isNamed())
    .flatMap((child) => {
      const range = nodeByteRange(child, unit.tree);
      if (range[1] <= window[0] || range[0] >= window[1]) return [];
      const member = nodeUnit(child, unit.tree, lines, symbols, imports, unit.depth + 1);
      return member ? [member] : [];
    });
}

function nodeUnit(
  node: SgNode,
  tree: ParsedTree,
  lines: Lines,
  symbols: ParsedSymbol[],
  imports: SgNode[],
  depth: number,
): Unit | undefined {
  const kind = String(node.kind());
  if (kind === "comment") return undefined;
  const range = nodeByteRange(node, tree);
  const declaration = declarationOf(node);
  const declarationKind = String(declaration.kind());
  const symbol = declaringSymbol(symbols, range, declaration, tree);
  const containerBody = containerKinds.has(declarationKind) || elementContainer(declaration)
    ? containerBodyOf(declaration)
    : undefined;
  if (containerBody) {
    const members = containerBody.children()
      .filter((child) => child.isNamed() && !["start_tag", "end_tag"].includes(String(child.kind())))
      .flatMap((child) => {
        if (importKinds.has(String(child.kind()))) {
          imports.push(child);
          return [];
        }
        const member = nodeUnit(child, tree, lines, symbols, imports, depth + 1);
        return member ? [member] : [];
      });
    return { node, tree, range, container: true, typeLike: false, ...(symbol ? { symbol } : {}), depth, members };
  }
  const body = leafBody(declaration);
  const bodyStart = body ? nodeByteRange(body, tree)[0] : range[0];
  return {
    node,
    tree,
    range,
    ...(body ? { body } : {}),
    container: false,
    typeLike: typeKinds.has(declarationKind),
    ...(symbol ? { symbol } : {}),
    depth,
    members: [],
    ...interiorOf(lines, range, bodyStart),
  };
}

/** Lines strictly between the header (up to the body's opening) and a closing line. */
function interiorOf(lines: Lines, range: ByteInterval, bodyStart: number) {
  let header = lineOf(lines, bodyStart);
  const before = lines.content.subarray(lines.starts[header]!, bodyStart).toString("utf8");
  if (!before.trim() && bodyStart > range[0]) header -= 1;
  const last = lineOf(lines, Math.max(range[0], range[1] - 1));
  const tail = closingLine(lines.text(last)) ? last - 1 : last;
  return tail > header ? { interior: [header + 1, tail] as [number, number] } : {};
}

function closingLine(line: string) {
  const trimmed = line.trim();
  return /^[}\])>]/u.test(trimmed) || /^(?:end|fi|done|esac)\b/u.test(trimmed) || /^<\//u.test(trimmed);
}

function declarationOf(node: SgNode): SgNode {
  const kind = String(node.kind());
  if (kind === "export_statement") {
    const inner = node.children().find((child) => child.isNamed() && !["comment", "decorator"].includes(String(child.kind())));
    return inner ? declarationOf(inner) : node;
  }
  if (kind === "decorated_definition") return field(node, "definition") ?? node;
  if (["lexical_declaration", "variable_declaration"].includes(kind)) {
    const declarators = node.children().filter((child) => child.kind() === "variable_declarator");
    return declarators.length === 1 ? declarators[0]! : node;
  }
  if (kind === "expression_statement") return node.children().find((child) => child.isNamed()) ?? node;
  return node;
}

function leafBody(node: SgNode): SgNode | undefined {
  const kind = String(node.kind());
  if (["variable_declarator", "public_field_definition", "field_definition", "pair", "assignment_expression"].includes(kind)) {
    const value = field(node, "value") ?? field(node, "right");
    return value ? (functionKinds.has(String(value.kind())) ? field(value, "body") ?? value : value) : undefined;
  }
  if (kind === "call_expression") {
    const args = field(node, "arguments");
    const last = args?.children().filter((child) => child.isNamed()).at(-1);
    if (last && functionKinds.has(String(last.kind()))) return field(last, "body") ?? last;
    return args;
  }
  if (["element", "script_element", "style_element"].includes(kind)) {
    const start = node.children().find((child) => child.kind() === "start_tag");
    return start?.next() ?? undefined;
  }
  return field(node, "body") ??
    node.children().find((child) => bodyKinds.has(String(child.kind())));
}

function containerBodyOf(node: SgNode): SgNode | undefined {
  if (elementContainer(node)) return node;
  return field(node, "body") ?? node.children().find((child) => bodyKinds.has(String(child.kind())));
}

function elementContainer(node: SgNode) {
  return String(node.kind()) === "element" && node.children().some((child) => child.kind() === "element");
}

function declaringSymbol(symbols: ParsedSymbol[], range: ByteInterval, declaration: SgNode, tree: ParsedTree) {
  const [start] = nodeByteRange(declaration, tree);
  return symbols
    .filter((symbol) => symbol.range_utf8_bytes[0] >= range[0] && symbol.range_utf8_bytes[1] <= range[1] &&
      symbol.range_utf8_bytes[0] <= start + 1 && symbol.kind !== "css_custom_property")
    .sort((left, right) => size(right.range_utf8_bytes) - size(left.range_utf8_bytes))[0];
}

/** Local names an import statement binds. */
function importBindings(imports: SgNode[]) {
  const names = new Set<string>();
  for (const statement of imports) {
    const kind = String(statement.kind());
    // Types say little about what a body does.
    if (kind === "import_statement" && statement.children().some((child) => child.kind() === "type")) continue;
    if (kind === "import_statement" && statement.children().some((child) => child.kind() === "import_clause")) {
      const clause = statement.children().find((child) => child.kind() === "import_clause")!;
      walkNodes(clause, (node) => {
        const nodeKind = String(node.kind());
        if (nodeKind === "import_specifier") {
          if (node.children().some((child) => child.kind() === "type")) return false;
          const local = field(node, "alias") ?? field(node, "name");
          if (local) names.add(local.text());
          return false;
        }
        if (nodeKind === "identifier") names.add(node.text());
        return true;
      });
    } else if (kind === "import_from_statement" || kind === "import_statement") {
      const module = field(statement, "module_name");
      for (const child of statement.children()) {
        if (!child.isNamed() || (module && child.range().start.index === module.range().start.index)) continue;
        if (child.kind() === "aliased_import") {
          const alias = field(child, "alias");
          if (alias) names.add(alias.text());
        } else if (child.kind() === "dotted_name") names.add(child.text().split(".").at(kind === "import_statement" ? 0 : -1)!);
      }
    } else if (kind === "use_declaration") {
      walkNodes(statement, (node) => {
        if (node.kind() === "identifier" && node.next()?.kind() !== "::") names.add(node.text());
        return true;
      });
    }
  }
  names.delete("");
  return [...names];
}

function usedNames(text: string, bindings: string[]) {
  return bindings.filter((name) => new RegExp(`(?<![\\w$])${escapeRegex(name)}(?![\\w$])`, "u").test(text));
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function walkNodes(node: SgNode, visit: (node: SgNode) => boolean) {
  for (const child of node.children()) if (visit(child)) walkNodes(child, visit);
}

function field(node: SgNode, name: string): SgNode | undefined {
  try {
    return node.field(name as never) ?? undefined;
  } catch {
    return undefined;
  }
}

function lineIndex(content: Buffer): Lines {
  const starts = [0];
  for (let index = content.indexOf(10); index >= 0; index = content.indexOf(10, index + 1))
    if (index + 1 < content.byteLength) starts.push(index + 1);
  return {
    starts,
    content,
    text: (line) => content.subarray(starts[line]!, starts[line + 1] ?? content.byteLength).toString("utf8").replace(/\r?\n$/u, ""),
  };
}

function lineOf(lines: Lines, byte: number) {
  let low = 0;
  let high = lines.starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (lines.starts[middle]! <= byte) low = middle;
    else high = middle - 1;
  }
  return low;
}

function lineBytes(lines: Lines, [first, last]: [number, number]): ByteInterval {
  return [lines.starts[first]!, lines.starts[last + 1] ?? lines.content.byteLength];
}

function size([start, end]: ByteInterval) {
  return end - start;
}

const importKinds = new Set([
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
]);

const containerKinds = new Set([
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
]);

const typeKinds = new Set([
  "interface_declaration",
  "type_alias_declaration",
  "enum_declaration",
  "enum_item",
  "struct_item",
  "type_declaration",
  "type_spec",
  "enum_specifier",
]);

const functionKinds = new Set(["arrow_function", "function_expression", "function", "generator_function", "lambda"]);

const bodyKinds = new Set([
  "block",
  "statement_block",
  "class_body",
  "declaration_list",
  "interface_body",
  "enum_body",
  "object_type",
  "field_declaration_list",
  "keyframe_block_list",
]);
