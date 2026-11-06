import bashLanguage from "@ast-grep/lang-bash";
import cLanguage from "@ast-grep/lang-c";
import cppLanguage from "@ast-grep/lang-cpp";
import csharpLanguage from "@ast-grep/lang-csharp";
import goLanguage from "@ast-grep/lang-go";
import javaLanguage from "@ast-grep/lang-java";
import pythonLanguage from "@ast-grep/lang-python";
import rustLanguage from "@ast-grep/lang-rust";
import {
  Lang,
  parse,
  registerDynamicLanguage,
  type SgNode,
} from "@ast-grep/napi";
import { packagedResourcePath } from "./packaged-resource-path.js";
import { sha256 } from "./light-identity.js";
import {
  languageCapability,
  type SemanticParserId,
} from "./language-capabilities.js";
import {
  componentElementBodyRange,
  componentElementName,
} from "./component-symbols.js";

let dynamicLanguagesRegistered = false;

export type SymbolKind =
  | "class"
  | "constructor"
  | "enum"
  | "function"
  | "interface"
  | "method"
  | "module"
  | "namespace"
  | "property"
  | "struct"
  | "trait"
  | "type"
  | "variable"
  | "css_rule"
  | "css_media"
  | "css_keyframes"
  | "css_custom_property"
  | "element";

export type CodeSymbol = {
  kind: SymbolKind;
  name: string;
  qualified_name: string;
  signature: string;
  visibility?: string;
  range_utf8_bytes: [number, number];
  line_range: [number, number];
};

export type OutlineSymbol = Pick<
  CodeSymbol,
  "kind" | "line_range" | "name" | "qualified_name"
> & {
  signature?: string;
  visibility?: string;
};

export type ParsedTree = {
  byteOffset: number;
  lineOffset: number;
  root: SgNode;
  utf8Offsets: Uint32Array;
};

export type ParsedNode = ParsedTree & { node: SgNode };

export type ParsedSymbol = Omit<CodeSymbol, "symbol_ref"> & ParsedNode;

export type ParseResult = {
  language: string;
  supported: boolean;
  symbols: ParsedSymbol[];
  errorCount: number;
  trees: ParsedTree[];
};

type LanguageSpec = {
  lang: Lang | string;
  name: string;
};

type SourceUnit = ParsedTree & {
  source: string;
};

const maximumCachedParses = 64;
const parseCache = new Map<string, ParseResult>();

export function parseCode(path: string, content: Buffer): ParseResult {
  const cacheKey = `${extension(path)}\0${sha256(content)}`;
  const cached = parseCache.get(cacheKey);
  if (cached) {
    parseCache.delete(cacheKey);
    parseCache.set(cacheKey, cached);
    return cached;
  }
  const parsed = parseCodeUncached(path, content);
  parseCache.set(cacheKey, parsed);
  trimParseCache();
  return parsed;
}

export function syntaxBoundaryRange(
  path: string,
  content: Buffer,
  target: [number, number],
): [number, number] {
  const parsed = parseCode(path, content);
  const candidate = parsed.trees
    .map((tree) => boundaryCandidate(tree, target))
    .filter((value): value is ParsedNode => Boolean(value))
    .sort((left, right) => nodeSize(left) - nodeSize(right))[0];
  if (!candidate) return target;
  const node = outerInsertionNode(candidate.node);
  const range = byteRange(node, candidate);
  // TS member separators are siblings of method_signature, not part of it.
  // Keep the complete member boundary without consuming a following member.
  const separator = parsed.language === "typescript" && String(node.kind()) === "method_signature"
    ? node.next() : undefined;
  if (separator && [";", ","].includes(String(separator.kind()))) {
    const [start, end] = byteRange(separator, candidate);
    if (!content.subarray(range[1], start).toString("utf8").trim())
      range[1] = end;
  }
  return range;
}

function boundaryCandidate(
  tree: ParsedTree,
  target: [number, number],
): ParsedNode | undefined {
  let selected: SgNode | undefined;
  walk(tree.root, (node) => {
    const range = byteRange(node, tree);
    if (range[0] > target[0] || range[1] < target[1]) return;
    if (!selected || node.text().length < selected.text().length)
      selected = node;
  });
  return selected ? { ...tree, node: selected } : undefined;
}

function outerInsertionNode(initial: SgNode) {
  let node = initial;
  for (let parent = node.parent(); parent; parent = node.parent()) {
    if (!parent.parent() || isSyntaxContainer(String(parent.kind()))) break;
    node = parent;
  }
  return node;
}

function isSyntaxContainer(kind: string) {
  return (
    syntaxContainerKinds.has(kind) ||
    kind.startsWith("preproc_") ||
    /(?:^|_)(?:body|block|list)$/u.test(kind)
  );
}

function nodeSize(node: ParsedNode) {
  const range = byteRange(node.node, node);
  return range[1] - range[0];
}

const syntaxContainerKinds = new Set([
  "arguments",
  "array",
  "document",
  "formal_parameters",
  "jsx_element",
  "module",
  "object",
  "object_type",
  "program",
  "source_file",
  "stylesheet",
]);

export function materializeSymbol(input: {
  symbol: ParsedSymbol;
  path: string;
  revision: string;
  content: Buffer;
  neighborNames?: string[];
  ordinal?: number;
}): CodeSymbol {
  const { symbol } = input;
  const { byteOffset, lineOffset, node, root, utf8Offsets, ...publicSymbol } =
    symbol;
  void byteOffset;
  void lineOffset;
  void node;
  void root;
  void utf8Offsets;
  return publicSymbol;
}

export function symbolEditRange(
  symbol: ParsedSymbol,
  view: "body" | "signature" | "symbol",
) {
  const range = byteRange(symbol.node, symbol);
  if (view === "symbol") return range;
  const elementBody = componentElementBodyRange(symbol.node, symbol);
  if (view === "body" && elementBody) return elementBody;
  if (view === "signature" && elementBody)
    return [range[0], elementBody[0]] as [number, number];
  const body = bodyNode(symbol.node);
  if (view === "body") return body ? byteRange(body, symbol) : range;
  return [range[0], body ? byteRange(body, symbol)[0] : range[1]] as [
    number,
    number,
  ];
}

export function outlineSymbol(
  symbol: CodeSymbol,
  include: Array<"signature" | "visibility"> = ["signature"],
): OutlineSymbol {
  return {
    kind: symbol.kind,
    name: symbol.name,
    qualified_name: symbol.qualified_name,
    line_range: symbol.line_range,
    ...(include.includes("signature") ? { signature: symbol.signature } : {}),
    ...(include.includes("visibility") && symbol.visibility
      ? { visibility: symbol.visibility }
      : {}),
  };
}

function parseCodeUncached(path: string, content: Buffer): ParseResult {
  const language = languageName(path);
  try {
    const units = sourceUnits(path, content.toString("utf8"));
    if (!units) return unsupportedParse();
    const symbols: ParsedSymbol[] = [];
    for (const unit of units)
      collectSymbols(unit.root, content, unit, [], symbols);
    return {
      language,
      supported: true,
      symbols,
      errorCount: units.reduce(
        (count, unit) => count + countErrorNodes(unit.root),
        0,
      ),
      trees: units,
    };
  } catch {
    return {
      language,
      supported: false,
      symbols: [],
      errorCount: 1,
      trees: [],
    };
  }
}

function unsupportedParse(): ParseResult {
  return {
    language: "unknown",
    supported: false,
    symbols: [],
    errorCount: 0,
    trees: [],
  };
}

function sourceUnits(path: string, source: string): SourceUnit[] | undefined {
  if ([".svelte", ".vue"].includes(extension(path)))
    return componentSourceUnits(source);
  const language = directLanguage(path);
  if (!language) return undefined;
  return [parseSourceUnit(language, source, 0, 0)];
}

function componentSourceUnits(source: string) {
  const units: SourceUnit[] = [
    parseSourceUnit({ lang: Lang.Html, name: "component" }, source, 0, 0),
  ];
  const expression = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu;
  for (const match of source.matchAll(expression)) {
    const content = match[2] ?? "";
    const contentIndex = (match.index ?? 0) + (match[0].indexOf(">") + 1);
    const prefix = source.slice(0, contentIndex);
    const language = /\blang\s*=\s*["'](?:ts|tsx)["']/iu.test(match[1] ?? "")
      ? { lang: Lang.TypeScript, name: "vue" }
      : { lang: Lang.JavaScript, name: "vue" };
    units.push(
      parseSourceUnit(
        language,
        content,
        Buffer.byteLength(prefix),
        lineCount(prefix) - 1,
      ),
    );
  }
  return units;
}

function parseSourceUnit(
  language: LanguageSpec,
  source: string,
  byteOffset: number,
  lineOffset: number,
): SourceUnit {
  ensureDynamicLanguages(language.lang);
  return {
    byteOffset,
    lineOffset,
    root: parse(language.lang, source).root(),
    utf8Offsets: sourceUtf8Offsets(source),
    source,
  };
}

function ensureDynamicLanguages(language: Lang | string) {
  if (dynamicLanguagesRegistered || !dynamicLanguageNames.has(String(language)))
    return;
  registerDynamicLanguage({
    bash: loadableLanguage(bashLanguage),
    c: loadableLanguage(cLanguage),
    cpp: loadableLanguage(cppLanguage),
    csharp: loadableLanguage(csharpLanguage),
    go: loadableLanguage(goLanguage),
    java: loadableLanguage(javaLanguage),
    python: loadableLanguage(pythonLanguage),
    rust: loadableLanguage(rustLanguage),
  });
  dynamicLanguagesRegistered = true;
}

function loadableLanguage(language: typeof bashLanguage) {
  return {
    ...language,
    libraryPath: packagedResourcePath(language.libraryPath),
  };
}

function collectSymbols(
  node: SgNode,
  source: Buffer,
  tree: ParsedTree,
  containers: string[],
  output: ParsedSymbol[],
) {
  const symbol = symbolFromNode(node, source, tree, containers);
  const nextContainers = symbol ? [...containers, symbol.name] : containers;
  if (symbol) output.push(symbol);
  for (const child of node.children())
    collectSymbols(child, source, tree, nextContainers, output);
}

function symbolFromNode(
  node: SgNode,
  source: Buffer,
  tree: ParsedTree,
  containers: string[],
): ParsedSymbol | undefined {
  const kind = symbolKind(node);
  if (!kind) return undefined;
  const name = symbolName(node, kind);
  if (!name) return undefined;
  return {
    ...tree,
    node,
    kind,
    name,
    qualified_name: qualifiedName(kind, containers, name),
    signature: signature(node, source, tree),
    ...(visibility(node) ? { visibility: visibility(node) } : {}),
    range_utf8_bytes: byteRange(node, tree),
    line_range: lineRange(node, tree.lineOffset),
  };
}

function symbolKind(node: SgNode): SymbolKind | undefined {
  if (
    ["element", "script_element", "self_closing_tag", "style_element"].includes(
      String(node.kind()),
    )
  )
    return "element";
  if (node.kind() === "rule_set") return "css_rule";
  if (node.kind() === "media_statement") return "css_media";
  if (node.kind() === "keyframes_statement") return "css_keyframes";
  if (
    node.kind() === "declaration" &&
    node
      .children()
      .find((child) => child.kind() === "property_name")
      ?.text()
      .startsWith("--")
  )
    return "css_custom_property";
  if (node.kind() === "variable_declarator")
    return isRelevantVariable(node) ? "variable" : undefined;
  if (node.kind() === "function_definition")
    return hasAnyAncestor(node, ["class_definition", "class_specifier"])
      ? "method"
      : "function";
  if (node.kind() === "function_item")
    return hasAncestor(node, "impl_item") ? "method" : "function";
  if (node.kind() === "type_spec") return goTypeKind(node);
  return symbolKindByNode[node.kind()];
}

function goTypeKind(node: SgNode): SymbolKind {
  const type = fieldNode(node, "type")?.kind();
  if (type === "struct_type") return "struct";
  if (type === "interface_type") return "interface";
  return "type";
}

function symbolName(node: SgNode, kind: SymbolKind) {
  if (kind === "element") return componentElementName(node);
  if (kind.startsWith("css_")) return cssSymbolName(node, kind);
  const named = fieldNode(node, "name")?.text().trim();
  if (named) return named;
  const declarator = fieldNode(node, "declarator");
  const declared = declaratorName(declarator);
  if (declared) return declared;
  if (kind === "variable") return node.child(0)?.text().trim();
  return node
    .children()
    .find((child) => /(?:identifier|name)$/u.test(String(child.kind())))
    ?.text()
    .trim();
}

function declaratorName(node?: SgNode): string | undefined {
  if (!node) return undefined;
  if (["identifier", "field_identifier"].includes(String(node.kind())))
    return node.text().trim();
  return declaratorName(fieldNode(node, "declarator"));
}

function isRelevantVariable(node: SgNode) {
  if (isFunctionVariable(node)) return true;
  return node
    .ancestors()
    .every((ancestor) => !functionLikeKinds.has(String(ancestor.kind())));
}

function isFunctionVariable(node: SgNode) {
  const value = fieldNode(node, "value");
  return (
    value?.kind() === "arrow_function" ||
    value?.kind() === "function_expression"
  );
}

function signature(node: SgNode, source: Buffer, tree: ParsedTree) {
  const range = byteRange(node, tree);
  const body = bodyNode(node);
  const elementBody = componentElementBodyRange(node, tree);
  const end = elementBody?.[0] ?? (body ? byteRange(body, tree)[0] : range[1]);
  return compact(
    source.subarray(range[0], end).toString("utf8").trimEnd(),
    500,
  );
}

function bodyNode(node: SgNode) {
  const direct = fieldNode(node, "body");
  if (direct) return direct;
  const value = fieldNode(node, "value");
  if (value) return fieldNode(value, "body") ?? value;
  return node
    .children()
    .find((child) =>
      ["block", "keyframe_block_list"].includes(String(child.kind())),
    );
}

function qualifiedName(kind: SymbolKind, containers: string[], name: string) {
  const separator = kind.startsWith("css_") ? "::" : ".";
  return [...containers, name].join(separator);
}

function fieldNode(node: SgNode, name: string): SgNode | undefined {
  try {
    return node.field(name as never) ?? undefined;
  } catch {
    return undefined;
  }
}

function visibility(node: SgNode) {
  const prefix = node.text().slice(0, 100);
  if (/\bprivate\b/u.test(prefix)) return "private";
  if (/\bprotected\b/u.test(prefix)) return "protected";
  if (/\bpublic\b/u.test(prefix)) return "public";
  if (/\bpub(?:\([^)]*\))?\b/u.test(prefix)) return "exported";
  if (hasAncestor(node, "export_statement")) return "exported";
  return undefined;
}

function cssSymbolName(node: SgNode, kind: SymbolKind) {
  if (kind === "css_rule") return namedChildText(node, "selectors");
  if (kind === "css_media") {
    const query = namedChildText(node, "feature_query");
    return query ? `@media${query}` : "@media";
  }
  if (kind === "css_keyframes") {
    const name = namedChildText(node, "keyframes_name");
    return name ? `@keyframes(${name})` : "@keyframes";
  }
  return namedChildText(node, "property_name");
}

function namedChildText(node: SgNode, kind: string) {
  return node
    .children()
    .find((child) => child.kind() === kind)
    ?.text()
    .trim();
}

function directLanguage(path: string): LanguageSpec | undefined {
  const parserId = languageCapability(path).parserId;
  if (!parserId || parserId === "svelte" || parserId === "vue")
    return undefined;
  return languageByParserId[parserId];
}

export function semanticLanguageName(path: string) {
  const parserId = languageCapability(path).parserId;
  if (!parserId) return "unknown";
  if ([".js", ".jsx", ".mjs", ".cjs"].includes(extension(path)))
    return "javascript";
  if ([".ts", ".tsx", ".mts", ".cts"].includes(extension(path)))
    return "typescript";
  return parserId;
}

function languageName(path: string) {
  return semanticLanguageName(path);
}

function extension(path: string) {
  return path.toLowerCase().match(/\.[^.]+$/u)?.[0] ?? "";
}

function countErrorNodes(root: SgNode) {
  return syntaxErrorNodes(root).length;
}

function syntaxErrorNodes(root: SgNode) {
  const errors: SgNode[] = [];
  walk(root, (node) => {
    if (node.kind() === "ERROR" || node.kind() === "MISSING" || missingSyntaxToken(node))
      errors.push(node);
  });
  return errors;
}

function missingSyntaxToken(node: SgNode) {
  if (!node.isLeaf() || node.isNamed()) return false;
  const range = node.range();
  return range.start.index === range.end.index;
}

export function parseSyntaxDiagnostics(parsed: ParseResult, content: Buffer) {
  return parsed.trees.flatMap((tree) =>
    syntaxErrorNodes(tree.root).slice(0, 20).map((node) => {
      const prefix = content.subarray(0, byteRange(node, tree)[0]).toString("utf8");
      const location = `${prefix.split("\n").length}:${prefix.length - prefix.lastIndexOf("\n")}`;
      const detail = node.kind() === "ERROR"
        ? `Unexpected syntax ${JSON.stringify(node.text().slice(0, 120))}`
        : `Expected ${JSON.stringify(node.kind())}`;
      return `${location} ${detail}`;
    }),
  ).slice(0, 20);
}

function walk(node: SgNode, visit: (node: SgNode) => void) {
  visit(node);
  for (const child of node.children()) walk(child, visit);
}

/** UTF-8 byte range of a syntax node of a parsed tree. */
export function nodeByteRange(node: SgNode, tree: ParsedTree): [number, number] {
  return byteRange(node, tree);
}

function byteRange(node: SgNode, tree: ParsedTree): [number, number] {
  return [
    tree.byteOffset + tree.utf8Offsets[node.range().start.index]!,
    tree.byteOffset + tree.utf8Offsets[node.range().end.index]!,
  ];
}

function sourceUtf8Offsets(source: string) {
  const offsets = new Uint32Array(source.length + 1);
  let byteOffset = 0;
  for (let index = 0; index < source.length; index += 1) {
    offsets[index] = byteOffset;
    const codePoint = source.codePointAt(index)!;
    if (codePoint > 0xffff) offsets[++index] = byteOffset;
    byteOffset += utf8CodePointWidth(codePoint);
  }
  offsets[source.length] = byteOffset;
  return offsets;
}

function utf8CodePointWidth(codePoint: number) {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

function lineRange(node: SgNode, lineOffset = 0): [number, number] {
  return [
    lineOffset + node.range().start.line + 1,
    lineOffset + node.range().end.line + 1,
  ];
}

function hasAncestor(node: SgNode, kind: string) {
  return node.ancestors().some((ancestor) => ancestor.kind() === kind);
}

function hasAnyAncestor(node: SgNode, kinds: string[]) {
  return node
    .ancestors()
    .some((ancestor) => kinds.includes(String(ancestor.kind())));
}

function lineCount(value: string) {
  return value.split("\n").length;
}

function trimParseCache() {
  while (parseCache.size > maximumCachedParses) {
    const oldest = parseCache.keys().next().value;
    if (typeof oldest !== "string") return;
    parseCache.delete(oldest);
  }
}

function compact(value: string, maximum: number) {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > maximum
    ? `${normalized.slice(0, maximum - 1)}…`
    : normalized;
}

const functionLikeKinds = new Set([
  "arrow_function",
  "function_declaration",
  "function_definition",
  "function_expression",
  "function_item",
  "method_declaration",
  "method_definition",
]);

const symbolKindByNode: Record<string, SymbolKind> = {
  abstract_class_declaration: "class",
  abstract_method_signature: "method",
  class_definition: "class",
  class_declaration: "class",
  class_specifier: "class",
  constructor_declaration: "constructor",
  enum_declaration: "enum",
  enum_specifier: "enum",
  enum_item: "enum",
  file_scoped_namespace_declaration: "namespace",
  function_declaration: "function",
  generator_function_declaration: "function",
  interface_declaration: "interface",
  method_declaration: "method",
  method_definition: "method",
  method_signature: "method",
  mod_item: "module",
  module_declaration: "module",
  namespace_declaration: "namespace",
  namespace_definition: "namespace",
  property_declaration: "property",
  record_declaration: "class",
  struct_declaration: "struct",
  struct_specifier: "struct",
  struct_item: "struct",
  trait_item: "trait",
  type_alias_declaration: "type",
};

const languageByParserId: Record<
  Exclude<SemanticParserId, "svelte" | "vue">,
  LanguageSpec
> = {
  bash: { lang: "bash", name: "bash" },
  c: { lang: "c", name: "c" },
  cpp: { lang: "cpp", name: "cpp" },
  csharp: { lang: "csharp", name: "csharp" },
  css: { lang: Lang.Css, name: "css" },
  go: { lang: "go", name: "go" },
  html: { lang: Lang.Html, name: "html" },
  java: { lang: "java", name: "java" },
  javascript: { lang: Lang.JavaScript, name: "javascript" },
  python: { lang: "python", name: "python" },
  rust: { lang: "rust", name: "rust" },
  tsx: { lang: Lang.Tsx, name: "typescript" },
  typescript: { lang: Lang.TypeScript, name: "typescript" },
};

const dynamicLanguageNames = new Set([
  "bash",
  "c",
  "cpp",
  "csharp",
  "go",
  "java",
  "python",
  "rust",
]);
