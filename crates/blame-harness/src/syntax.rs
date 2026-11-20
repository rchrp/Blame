//! Code intelligence: symbols, bodies and syntax errors from ast-grep trees.
//! Mirrors `code-intelligence.ts` and `component-symbols.ts` node for node:
//! the same grammars produce the same trees, so the same walk yields the
//! same symbols, qualified names, signatures and diagnostics.

use crate::coverage::Interval;
use crate::identity::sha256_hex;
use crate::languages::{ParserId, language_capability};
use crate::pathx;
use crate::text::{collapse_spaces, js_trim, js_trim_end, utf16_len, utf16_prefix};
use ast_grep_core::language::Language;
use ast_grep_core::matcher::{Pattern, PatternBuilder, PatternError};
use ast_grep_core::tree_sitter::{LanguageExt, StrDoc, TSLanguage};
use ast_grep_core::{AstGrep, Node};
use regex::Regex;
use std::collections::VecDeque;
use std::sync::{Arc, LazyLock, Mutex};

/// The grammars the TypeScript harness loads: @ast-grep/napi's built-in
/// languages and the @ast-grep/lang-* packages.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Grammar {
    TypeScript,
    Tsx,
    JavaScript,
    Css,
    Html,
    Bash,
    C,
    Cpp,
    CSharp,
    Go,
    Java,
    Python,
    Rust,
}

impl Language for Grammar {
    fn kind_to_id(&self, kind: &str) -> u16 {
        self.get_ts_language().id_for_node_kind(kind, true)
    }
    fn field_to_id(&self, field: &str) -> Option<u16> {
        self.get_ts_language()
            .field_id_for_name(field)
            .map(|id| id.get())
    }
    fn build_pattern(&self, builder: &PatternBuilder) -> Result<Pattern, PatternError> {
        builder.build(|source| StrDoc::try_new(source, *self))
    }
}

impl LanguageExt for Grammar {
    fn get_ts_language(&self) -> TSLanguage {
        match self {
            Grammar::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            Grammar::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
            Grammar::JavaScript => tree_sitter_javascript::LANGUAGE.into(),
            Grammar::Css => tree_sitter_css::LANGUAGE.into(),
            Grammar::Html => tree_sitter_html::LANGUAGE.into(),
            Grammar::Bash => tree_sitter_bash::LANGUAGE.into(),
            Grammar::C => tree_sitter_c::LANGUAGE.into(),
            Grammar::Cpp => tree_sitter_cpp::LANGUAGE.into(),
            Grammar::CSharp => tree_sitter_c_sharp::LANGUAGE.into(),
            Grammar::Go => tree_sitter_go::LANGUAGE.into(),
            Grammar::Java => tree_sitter_java::LANGUAGE.into(),
            Grammar::Python => tree_sitter_python::LANGUAGE.into(),
            Grammar::Rust => tree_sitter_rust::LANGUAGE.into(),
        }
    }
}

pub type SgNode<'r> = Node<'r, StrDoc<Grammar>>;

/// One parsed source unit: a file, or a component's markup or script block.
pub struct ParsedTree {
    pub byte_offset: usize,
    pub line_offset: usize,
    pub root: AstGrep<StrDoc<Grammar>>,
}

impl ParsedTree {
    pub fn node_range(&self, node: &SgNode<'_>) -> Interval {
        let range = node.range();
        (self.byte_offset + range.start, self.byte_offset + range.end)
    }

    fn line_range(&self, node: &SgNode<'_>) -> (usize, usize) {
        (
            self.line_offset + node.start_pos().line() + 1,
            self.line_offset + node.end_pos().line() + 1,
        )
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ParsedSymbol {
    pub kind: &'static str,
    pub name: String,
    pub qualified_name: String,
    pub signature: String,
    pub visibility: Option<&'static str>,
    pub range: Interval,
    pub line_range: (usize, usize),
    /// The tree the symbol's node belongs to.
    pub tree: usize,
    /// `bodyNode(node)`: the declaration's body, if it has one.
    pub body: Option<Interval>,
    /// A component element's content between its start and end tags.
    pub element_body: Option<Interval>,
}

pub struct ParseResult {
    pub language: String,
    pub supported: bool,
    pub symbols: Vec<ParsedSymbol>,
    pub error_count: usize,
    pub trees: Vec<ParsedTree>,
}

const MAXIMUM_CACHED_PARSES: usize = 64;

type ParseCache = Mutex<VecDeque<(String, Arc<ParseResult>)>>;

static PARSE_CACHE: LazyLock<ParseCache> = LazyLock::new(|| Mutex::new(VecDeque::new()));

/// Parses `content` as `path`'s language, from a cache of the last 64 parses.
pub fn parse_code(path: &str, content: &[u8]) -> Arc<ParseResult> {
    let key = format!(
        "{}\0{}",
        pathx::dotted_suffix_lower(path),
        sha256_hex(content)
    );
    {
        let mut cache = PARSE_CACHE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(index) = cache.iter().position(|(known, _)| *known == key) {
            let entry = cache.remove(index).expect("cached parse");
            let parsed = entry.1.clone();
            cache.push_back(entry);
            return parsed;
        }
    }
    let parsed = Arc::new(parse_uncached(path, content));
    let mut cache = PARSE_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    cache.push_back((key, parsed.clone()));
    while cache.len() > MAXIMUM_CACHED_PARSES {
        cache.pop_front();
    }
    parsed
}

fn parse_uncached(path: &str, content: &[u8]) -> ParseResult {
    let language = semantic_language_name(path);
    let source = String::from_utf8_lossy(content);
    let Some(units) = source_units(path, &source) else {
        return ParseResult {
            language: "unknown".into(),
            supported: false,
            symbols: Vec::new(),
            error_count: 0,
            trees: Vec::new(),
        };
    };
    let mut symbols = Vec::new();
    let utf8 = source.as_bytes();
    for (index, unit) in units.iter().enumerate() {
        let root = unit.root.root();
        collect_symbols(&root, utf8, unit, index, &mut Vec::new(), &mut symbols);
    }
    let error_count = units
        .iter()
        .map(|unit| syntax_error_nodes(&unit.root.root()).len())
        .sum();
    ParseResult {
        language,
        supported: true,
        symbols,
        error_count,
        trees: units,
    }
}

fn source_units(path: &str, source: &str) -> Option<Vec<ParsedTree>> {
    let extension = pathx::dotted_suffix_lower(path);
    if extension == ".svelte" || extension == ".vue" {
        return Some(component_source_units(source));
    }
    let grammar = direct_grammar(path)?;
    Some(vec![ParsedTree {
        byte_offset: 0,
        line_offset: 0,
        root: AstGrep::new(source, grammar),
    }])
}

static SCRIPT_BLOCK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)<script(?-u:\b)([^>]*)>([\s\S]*?)</script\s*>").expect("script block pattern")
});
static TYPESCRIPT_LANG: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)(?-u:\b)lang\s*=\s*["'](?:ts|tsx)["']"#).expect("lang pattern")
});

/// A component file: its markup as HTML, then each script block on its own.
fn component_source_units(source: &str) -> Vec<ParsedTree> {
    let mut units = vec![ParsedTree {
        byte_offset: 0,
        line_offset: 0,
        root: AstGrep::new(source, Grammar::Html),
    }];
    for captures in SCRIPT_BLOCK.captures_iter(source) {
        let whole = captures.get(0).expect("match");
        let attributes = captures.get(1).map(|group| group.as_str()).unwrap_or("");
        let content = captures.get(2).map(|group| group.as_str()).unwrap_or("");
        let content_index = whole.start() + whole.as_str().find('>').expect("opening tag end") + 1;
        let prefix = &source[..content_index];
        let grammar = if TYPESCRIPT_LANG.is_match(attributes) {
            Grammar::TypeScript
        } else {
            Grammar::JavaScript
        };
        units.push(ParsedTree {
            byte_offset: prefix.len(),
            line_offset: prefix.bytes().filter(|byte| *byte == b'\n').count(),
            root: AstGrep::new(content, grammar),
        });
    }
    units
}

fn direct_grammar(path: &str) -> Option<Grammar> {
    Some(match language_capability(path, None).parser_id? {
        ParserId::Svelte | ParserId::Vue => return None,
        ParserId::Bash => Grammar::Bash,
        ParserId::C => Grammar::C,
        ParserId::Cpp => Grammar::Cpp,
        ParserId::Csharp => Grammar::CSharp,
        ParserId::Css => Grammar::Css,
        ParserId::Go => Grammar::Go,
        ParserId::Html => Grammar::Html,
        ParserId::Java => Grammar::Java,
        ParserId::Javascript => Grammar::JavaScript,
        ParserId::Python => Grammar::Python,
        ParserId::Rust => Grammar::Rust,
        ParserId::Tsx => Grammar::Tsx,
        ParserId::Typescript => Grammar::TypeScript,
    })
}

pub fn semantic_language_name(path: &str) -> String {
    let Some(parser) = language_capability(path, None).parser_id else {
        return "unknown".into();
    };
    let extension = pathx::dotted_suffix_lower(path);
    if [".js", ".jsx", ".mjs", ".cjs"].contains(&extension.as_str()) {
        return "javascript".into();
    }
    if [".ts", ".tsx", ".mts", ".cts"].contains(&extension.as_str()) {
        return "typescript".into();
    }
    parser.as_str().into()
}

fn collect_symbols(
    node: &SgNode<'_>,
    source: &[u8],
    tree: &ParsedTree,
    tree_index: usize,
    containers: &mut Vec<String>,
    output: &mut Vec<ParsedSymbol>,
) {
    let symbol = symbol_from_node(node, source, tree, tree_index, containers);
    let pushed = symbol.is_some();
    if let Some(symbol) = symbol {
        containers.push(symbol.name.clone());
        output.push(symbol);
    }
    for child in node.children() {
        collect_symbols(&child, source, tree, tree_index, containers, output);
    }
    if pushed {
        containers.pop();
    }
}

fn symbol_from_node(
    node: &SgNode<'_>,
    source: &[u8],
    tree: &ParsedTree,
    tree_index: usize,
    containers: &[String],
) -> Option<ParsedSymbol> {
    let kind = symbol_kind(node)?;
    let name = symbol_name(node, kind)?;
    let separator = if kind.starts_with("css_") { "::" } else { "." };
    let mut qualified = containers.to_vec();
    qualified.push(name.clone());
    Some(ParsedSymbol {
        kind,
        qualified_name: qualified.join(separator),
        signature: signature(node, source, tree),
        visibility: visibility(node),
        range: tree.node_range(node),
        line_range: tree.line_range(node),
        tree: tree_index,
        body: body_node(node).map(|body| tree.node_range(&body)),
        element_body: component_element_body_range(node, tree),
        name,
    })
}

fn symbol_kind(node: &SgNode<'_>) -> Option<&'static str> {
    let kind = node.kind();
    let kind = kind.as_ref();
    if [
        "element",
        "script_element",
        "self_closing_tag",
        "style_element",
    ]
    .contains(&kind)
    {
        return Some("element");
    }
    match kind {
        "rule_set" => return Some("css_rule"),
        "media_statement" => return Some("css_media"),
        "keyframes_statement" => return Some("css_keyframes"),
        _ => {}
    }
    if kind == "declaration"
        && node
            .children()
            .find(|child| child.kind() == "property_name")
            .is_some_and(|child| child.text().starts_with("--"))
    {
        return Some("css_custom_property");
    }
    if kind == "variable_declarator" {
        return is_relevant_variable(node).then_some("variable");
    }
    if kind == "function_definition" {
        return Some(
            if has_any_ancestor(node, &["class_definition", "class_specifier"]) {
                "method"
            } else {
                "function"
            },
        );
    }
    if kind == "function_item" {
        return Some(if has_any_ancestor(node, &["impl_item"]) {
            "method"
        } else {
            "function"
        });
    }
    if kind == "type_spec" {
        return Some(
            match field(node, "type")
                .map(|value| value.kind().into_owned())
                .as_deref()
            {
                Some("struct_type") => "struct",
                Some("interface_type") => "interface",
                _ => "type",
            },
        );
    }
    Some(match kind {
        "abstract_class_declaration"
        | "class_definition"
        | "class_declaration"
        | "class_specifier"
        | "record_declaration" => "class",
        "abstract_method_signature"
        | "method_declaration"
        | "method_definition"
        | "method_signature" => "method",
        "constructor_declaration" => "constructor",
        "enum_declaration" | "enum_specifier" | "enum_item" => "enum",
        "file_scoped_namespace_declaration" | "namespace_declaration" | "namespace_definition" => {
            "namespace"
        }
        "function_declaration" | "generator_function_declaration" => "function",
        "interface_declaration" => "interface",
        "mod_item" | "module_declaration" => "module",
        "property_declaration" => "property",
        "struct_declaration" | "struct_specifier" | "struct_item" => "struct",
        "trait_item" => "trait",
        "type_alias_declaration" => "type",
        _ => return None,
    })
}

fn symbol_name(node: &SgNode<'_>, kind: &str) -> Option<String> {
    if kind == "element" {
        return component_element_name(node);
    }
    if kind.starts_with("css_") {
        return css_symbol_name(node, kind);
    }
    if let Some(named) = field(node, "name")
        .map(|name| js_trim(&name.text()).to_string())
        .filter(|name| !name.is_empty())
    {
        return Some(named);
    }
    if let Some(declared) = declarator_name(field(node, "declarator"))
        && !declared.is_empty()
    {
        return Some(declared);
    }
    if kind == "variable" {
        return node
            .child(0)
            .map(|child| js_trim(&child.text()).to_string());
    }
    let identifier = Regex::new("(?:identifier|name)$").expect("name kind pattern");
    node.children()
        .find(|child| identifier.is_match(&child.kind()))
        .map(|child| js_trim(&child.text()).to_string())
}

fn declarator_name(node: Option<SgNode<'_>>) -> Option<String> {
    let node = node?;
    if ["identifier", "field_identifier"].contains(&node.kind().as_ref()) {
        return Some(js_trim(&node.text()).to_string());
    }
    declarator_name(field(&node, "declarator"))
}

const FUNCTION_LIKE_KINDS: [&str; 7] = [
    "arrow_function",
    "function_declaration",
    "function_definition",
    "function_expression",
    "function_item",
    "method_declaration",
    "method_definition",
];

fn is_relevant_variable(node: &SgNode<'_>) -> bool {
    if is_function_variable(node) {
        return true;
    }
    node.ancestors()
        .all(|ancestor| !FUNCTION_LIKE_KINDS.contains(&ancestor.kind().as_ref()))
}

fn is_function_variable(node: &SgNode<'_>) -> bool {
    field(node, "value").is_some_and(|value| {
        ["arrow_function", "function_expression"].contains(&value.kind().as_ref())
    })
}

fn signature(node: &SgNode<'_>, source: &[u8], tree: &ParsedTree) -> String {
    let range = tree.node_range(node);
    let end = component_element_body_range(node, tree)
        .map(|body| body.0)
        .or_else(|| body_node(node).map(|body| tree.node_range(&body).0))
        .unwrap_or(range.1);
    let text = String::from_utf8_lossy(&source[range.0..end.max(range.0)]);
    compact(js_trim_end(&text), 500)
}

/// `bodyNode`: the `body` field, a value's body (or the value), or a block child.
pub fn body_node<'r>(node: &SgNode<'r>) -> Option<SgNode<'r>> {
    if let Some(direct) = field(node, "body") {
        return Some(direct);
    }
    if let Some(value) = field(node, "value") {
        return Some(field(&value, "body").unwrap_or(value));
    }
    node.children()
        .find(|child| ["block", "keyframe_block_list"].contains(&child.kind().as_ref()))
}

/// `node.field(name)`; a grammar without the field has none.
pub fn field<'r>(node: &SgNode<'r>, name: &str) -> Option<SgNode<'r>> {
    node.lang().field_to_id(name)?;
    node.field(name)
}

static PRIVATE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?-u:\b)private(?-u:\b)").expect("pattern"));
static PROTECTED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?-u:\b)protected(?-u:\b)").expect("pattern"));
static PUBLIC: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?-u:\b)public(?-u:\b)").expect("pattern"));
static PUB: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?-u:\b)pub(?:\([^)]*\))?(?-u:\b)").expect("pattern"));

fn visibility(node: &SgNode<'_>) -> Option<&'static str> {
    let text = node.text();
    let prefix = utf16_prefix(&text, 100);
    if PRIVATE.is_match(prefix) {
        return Some("private");
    }
    if PROTECTED.is_match(prefix) {
        return Some("protected");
    }
    if PUBLIC.is_match(prefix) {
        return Some("public");
    }
    if PUB.is_match(prefix) {
        return Some("exported");
    }
    if has_any_ancestor(node, &["export_statement"]) {
        return Some("exported");
    }
    None
}

fn css_symbol_name(node: &SgNode<'_>, kind: &str) -> Option<String> {
    match kind {
        "css_rule" => named_child_text(node, "selectors"),
        "css_media" => Some(match named_child_text(node, "feature_query") {
            Some(query) if !query.is_empty() => format!("@media{query}"),
            _ => "@media".into(),
        }),
        "css_keyframes" => Some(match named_child_text(node, "keyframes_name") {
            Some(name) if !name.is_empty() => format!("@keyframes({name})"),
            _ => "@keyframes".into(),
        }),
        _ => named_child_text(node, "property_name"),
    }
    .filter(|name| !name.is_empty())
}

fn named_child_text(node: &SgNode<'_>, kind: &str) -> Option<String> {
    node.children()
        .find(|child| child.kind() == kind)
        .map(|child| js_trim(&child.text()).to_string())
}

fn has_any_ancestor(node: &SgNode<'_>, kinds: &[&str]) -> bool {
    node.ancestors()
        .any(|ancestor| kinds.contains(&ancestor.kind().as_ref()))
}

/// `compact`: white space collapsed, at most `maximum` UTF-16 units with an ellipsis.
pub fn compact(value: &str, maximum: usize) -> String {
    let normalized = collapse_spaces(value);
    let normalized = js_trim(&normalized);
    if utf16_len(normalized) > maximum {
        format!("{}…", utf16_prefix(normalized, maximum - 1))
    } else {
        normalized.to_string()
    }
}

fn is_container_element(node: &SgNode<'_>) -> bool {
    ["element", "script_element", "style_element"].contains(&node.kind().as_ref())
}

/// A container element's content: from the end of its start tag to the start of its end tag.
pub fn component_element_body_range(node: &SgNode<'_>, tree: &ParsedTree) -> Option<Interval> {
    if !is_container_element(node) {
        return None;
    }
    let children: Vec<SgNode<'_>> = node.children().collect();
    let start = children.iter().find(|child| {
        ["start_tag", "script_start_tag", "style_start_tag"].contains(&child.kind().as_ref())
    })?;
    let end = children.iter().rev().find(|child| {
        ["end_tag", "script_end_tag", "style_end_tag"].contains(&child.kind().as_ref())
    })?;
    Some((tree.node_range(start).1, tree.node_range(end).0))
}

static ELEMENT_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?-u:\b)id\s*=\s*["']([^"']+)["']"#).expect("id pattern"));

fn component_element_name(node: &SgNode<'_>) -> Option<String> {
    let tag = node
        .children()
        .flat_map(|child| {
            let mut nodes = vec![child.clone()];
            nodes.extend(child.children());
            nodes
        })
        .find(|child| child.kind() == "tag_name")
        .map(|child| js_trim(&child.text()).to_string())
        .filter(|tag| !tag.is_empty())?;
    let opening = node
        .children()
        .next()
        .map(|child| child.text().into_owned())
        .unwrap_or_default();
    Some(
        match ELEMENT_ID
            .captures(&opening)
            .and_then(|captures| captures.get(1))
        {
            Some(id) => format!("{tag}#{}", id.as_str()),
            None => tag,
        },
    )
}

fn walk<'r>(node: &SgNode<'r>, visit: &mut impl FnMut(&SgNode<'r>)) {
    visit(node);
    for child in node.children() {
        walk(&child, visit);
    }
}

fn syntax_error_nodes<'r>(root: &SgNode<'r>) -> Vec<SgNode<'r>> {
    let mut errors = Vec::new();
    walk(root, &mut |node| {
        let kind = node.kind();
        if kind == "ERROR" || kind == "MISSING" || missing_syntax_token(node) {
            errors.push(node.clone());
        }
    });
    errors
}

fn missing_syntax_token(node: &SgNode<'_>) -> bool {
    if !node.is_leaf() || node.is_named() {
        return false;
    }
    let range = node.range();
    range.start == range.end
}

/// `line:column detail` for up to 20 syntax errors, as content validation reports them.
pub fn parse_syntax_diagnostics(parsed: &ParseResult, content: &[u8]) -> Vec<String> {
    let mut output = Vec::new();
    for tree in &parsed.trees {
        for node in syntax_error_nodes(&tree.root.root()).into_iter().take(20) {
            let prefix = String::from_utf8_lossy(&content[..tree.node_range(&node).0]);
            let line = prefix.split('\n').count();
            // `prefix.length - prefix.lastIndexOf("\n")`, in UTF-16 units.
            let column = match prefix.rfind('\n') {
                Some(index) => utf16_len(&prefix) - utf16_len(&prefix[..index]),
                None => utf16_len(&prefix) + 1,
            };
            let detail = if node.kind() == "ERROR" {
                format!(
                    "Unexpected syntax {}",
                    crate::json::quote(utf16_prefix(&node.text(), 120))
                )
            } else {
                format!("Expected {}", crate::json::quote(&node.kind()))
            };
            output.push(format!("{line}:{column} {detail}"));
        }
    }
    output.truncate(20);
    output
}

/// `symbolEditRange`: the whole symbol, its signature or its body.
pub fn symbol_edit_range(symbol: &ParsedSymbol, view: &str) -> Interval {
    let range = symbol.range;
    if view == "symbol" {
        return range;
    }
    if let Some(element) = symbol.element_body {
        if view == "body" {
            return element;
        }
        if view == "signature" {
            return (range.0, element.0);
        }
    }
    if view == "body" {
        return symbol.body.unwrap_or(range);
    }
    (range.0, symbol.body.map_or(range.1, |body| body.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(path: &str, source: &str) -> Vec<(String, String)> {
        parse_code(path, source.as_bytes())
            .symbols
            .iter()
            .map(|symbol| (symbol.kind.to_string(), symbol.qualified_name.clone()))
            .collect()
    }

    #[test]
    fn finds_typescript_symbols() {
        let source = "export class Box {\n  private size = 1;\n  grow(n: number) { return n; }\n}\nexport const make = () => new Box();\n";
        assert_eq!(
            names("a.ts", source),
            [
                ("class".into(), "Box".into()),
                ("method".into(), "Box.grow".into()),
                ("variable".into(), "make".into())
            ]
        );
        let parsed = parse_code("a.ts", source.as_bytes());
        // The first 100 characters of the class mention `private`, as in TypeScript.
        assert_eq!(parsed.symbols[0].visibility, Some("private"));
        assert_eq!(parsed.symbols[2].visibility, Some("exported"));
        assert_eq!(parsed.symbols[1].signature, "grow(n: number)");
        assert_eq!(parsed.error_count, 0);
    }

    #[test]
    fn finds_python_rust_and_css_symbols() {
        assert_eq!(
            names("a.py", "class A:\n    def f(self):\n        return 1\n"),
            [
                ("class".into(), "A".into()),
                ("method".into(), "A.f".into())
            ]
        );
        assert_eq!(
            names("a.rs", "impl A { pub fn f() {} }\nfn g() {}"),
            [
                ("method".into(), "f".into()),
                ("function".into(), "g".into())
            ]
        );
        assert_eq!(
            names(
                "a.css",
                ".a { --x: 1; }\n@media (max-width: 1px) { .b { color: red; } }"
            ),
            [
                ("css_rule".into(), ".a".into()),
                ("css_custom_property".into(), ".a::--x".into()),
                ("css_media".into(), "@media(max-width: 1px)".into()),
                ("css_rule".into(), "@media(max-width: 1px)::.b".into())
            ]
        );
    }

    #[test]
    fn parses_component_script_blocks() {
        let source = "<template><main id=\"app\"/></template>\n<script lang=\"ts\">\nexport function load(): number { return 1 }\n</script>\n";
        let parsed = parse_code("a.vue", source.as_bytes());
        let function = parsed
            .symbols
            .iter()
            .find(|symbol| symbol.name == "load")
            .expect("script symbol");
        assert_eq!(function.line_range, (3, 3));
        assert!(source[function.range.0..].starts_with("function load"));
    }

    #[test]
    fn counts_syntax_errors() {
        let parsed = parse_code("a.ts", b"function f( {");
        assert!(parsed.error_count > 0);
        assert!(!parse_syntax_diagnostics(&parsed, b"function f( {").is_empty());
    }
}
