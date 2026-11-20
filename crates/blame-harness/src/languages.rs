//! Which parser and validator a path gets, and the capability levels the
//! model is told about (`language-capabilities.ts`, `light-capabilities.ts`).

use crate::json::Json;
use crate::obj;
use crate::pathx::dotted_suffix_lower;
use crate::syntax::parse_code;
use std::sync::LazyLock;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ParserId {
    Bash,
    C,
    Cpp,
    Csharp,
    Css,
    Go,
    Html,
    Java,
    Javascript,
    Python,
    Rust,
    Svelte,
    Typescript,
    Tsx,
    Vue,
}

impl ParserId {
    pub fn as_str(self) -> &'static str {
        match self {
            ParserId::Bash => "bash",
            ParserId::C => "c",
            ParserId::Cpp => "cpp",
            ParserId::Csharp => "csharp",
            ParserId::Css => "css",
            ParserId::Go => "go",
            ParserId::Html => "html",
            ParserId::Java => "java",
            ParserId::Javascript => "javascript",
            ParserId::Python => "python",
            ParserId::Rust => "rust",
            ParserId::Svelte => "svelte",
            ParserId::Typescript => "typescript",
            ParserId::Tsx => "tsx",
            ParserId::Vue => "vue",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ValidatorId {
    Jsonc,
    Prisma,
    SemanticParser,
    Typescript,
}

pub struct LanguageCapability {
    pub parser_id: Option<ParserId>,
    pub validator_id: Option<ValidatorId>,
}

fn parser_for_extension(extension: &str) -> Option<ParserId> {
    Some(match extension {
        ".bash" | ".bats" | ".sh" => ParserId::Bash,
        ".c" | ".h" => ParserId::C,
        ".cc" | ".cpp" | ".cxx" | ".hpp" => ParserId::Cpp,
        ".cjs" | ".js" | ".mjs" => ParserId::Javascript,
        ".cs" => ParserId::Csharp,
        ".cts" | ".mts" | ".ts" => ParserId::Typescript,
        ".css" => ParserId::Css,
        ".go" => ParserId::Go,
        ".htm" | ".html" => ParserId::Html,
        ".java" => ParserId::Java,
        ".jsx" | ".tsx" => ParserId::Tsx,
        ".py" => ParserId::Python,
        ".rs" => ParserId::Rust,
        ".svelte" => ParserId::Svelte,
        ".vue" => ParserId::Vue,
        _ => return None,
    })
}

pub fn language_capability(path: &str, content: Option<&[u8]>) -> LanguageCapability {
    if content.is_some_and(|content| content.contains(&0)) {
        return LanguageCapability {
            parser_id: None,
            validator_id: None,
        };
    }
    let extension = dotted_suffix_lower(path);
    let parser_id = parser_for_extension(&extension);
    let validator_id = if [".json", ".jsonc"].contains(&extension.as_str()) {
        Some(ValidatorId::Jsonc)
    } else if extension == ".prisma" {
        Some(ValidatorId::Prisma)
    } else if matches!(
        parser_id,
        Some(ParserId::Javascript | ParserId::Typescript | ParserId::Tsx)
    ) {
        Some(ValidatorId::Typescript)
    } else {
        parser_id.map(|_| ValidatorId::SemanticParser)
    };
    LanguageCapability {
        parser_id,
        validator_id,
    }
}

#[derive(Clone, Debug)]
pub struct LoadedCapability {
    pub extensions: &'static [&'static str],
    pub language: &'static str,
    /// "symbol" or "structural".
    pub level: &'static str,
    pub loaded: bool,
}

impl LoadedCapability {
    pub fn to_json(&self) -> Json {
        obj! {
            "extensions" => Json::Arr(self.extensions.iter().map(|extension| Json::from(*extension)).collect()),
            "language" => self.language,
            "level" => self.level,
            "loaded" => self.loaded,
            "parse" => if self.loaded { "available" } else { "unavailable" },
        }
    }
}

type Adapter = (
    &'static str,
    &'static [&'static str],
    &'static str,
    &'static str,
    &'static str,
);

const ADAPTERS: [Adapter; 15] = [
    (
        "typescript",
        &[".ts", ".mts", ".cts"],
        "symbol",
        "sample.ts",
        "export function sample() { return 1 }",
    ),
    (
        "tsx",
        &[".tsx"],
        "symbol",
        "sample.tsx",
        "export function Sample() { return <div /> }",
    ),
    (
        "javascript",
        &[".js", ".mjs", ".cjs"],
        "symbol",
        "sample.js",
        "export function sample() { return 1 }",
    ),
    (
        "jsx",
        &[".jsx"],
        "symbol",
        "sample.jsx",
        "export function Sample() { return <div /> }",
    ),
    (
        "python",
        &[".py"],
        "symbol",
        "sample.py",
        "def sample():\n    return 1\n",
    ),
    (
        "rust",
        &[".rs"],
        "symbol",
        "sample.rs",
        "fn sample() -> i32 { 1 }",
    ),
    (
        "go",
        &[".go"],
        "symbol",
        "sample.go",
        "package sample\nfunc Sample() int { return 1 }",
    ),
    (
        "java",
        &[".java"],
        "symbol",
        "Sample.java",
        "class Sample { int value() { return 1; } }",
    ),
    (
        "csharp",
        &[".cs"],
        "symbol",
        "Sample.cs",
        "class Sample { int Value() { return 1; } }",
    ),
    (
        "c",
        &[".c", ".h"],
        "symbol",
        "sample.c",
        "int sample(void) { return 1; }",
    ),
    (
        "cpp",
        &[".cpp", ".cc", ".cxx", ".hpp"],
        "symbol",
        "sample.cpp",
        "class Sample { public: int value() { return 1; } };",
    ),
    (
        "html",
        &[".html", ".htm"],
        "structural",
        "sample.html",
        "<main id=\"sample\"><p>value</p></main>",
    ),
    (
        "css",
        &[".css"],
        "structural",
        "sample.css",
        ".sample { color: red; }",
    ),
    (
        "vue",
        &[".vue"],
        "structural",
        "sample.vue",
        "<template><main /></template><script>export function sample() { return 1 }</script>",
    ),
    (
        "svelte",
        &[".svelte"],
        "structural",
        "sample.svelte",
        "<main>value</main><script>function sample() { return 1 }</script>",
    ),
];

const RAW_EXTENSIONS: [&str; 9] = [
    ".prisma", ".json", ".jsonc", ".yaml", ".yml", ".toml", ".sql", ".md", ".env",
];

/// Each adapter is loaded when its sample parses without errors into symbols.
static REGISTRY: LazyLock<Vec<LoadedCapability>> = LazyLock::new(|| {
    ADAPTERS
        .iter()
        .map(|(language, extensions, level, sample_path, sample)| {
            let parsed = parse_code(sample_path, sample.as_bytes());
            LoadedCapability {
                extensions,
                language,
                level,
                loaded: parsed.supported && parsed.error_count == 0 && !parsed.symbols.is_empty(),
            }
        })
        .collect()
});

pub fn runtime_capability_registry() -> &'static [LoadedCapability] {
    &REGISTRY
}

pub fn capability_for_path(path: &str) -> Option<&'static LoadedCapability> {
    let extension = dotted_suffix_lower(path);
    REGISTRY
        .iter()
        .find(|capability| capability.extensions.contains(&extension.as_str()))
}

/// A path read and edited by symbols: a loaded adapter above the raw level.
pub fn symbolic_path(path: &str) -> bool {
    capability_for_path(path).is_some_and(|capability| capability.loaded)
}

fn loaded_extensions(level: &str) -> Vec<&'static str> {
    REGISTRY
        .iter()
        .filter(|capability| capability.level == level && capability.loaded)
        .flat_map(|capability| capability.extensions.iter().copied())
        .collect()
}

pub fn light_capability_description() -> String {
    let symbolic = loaded_extensions("symbol");
    let structural = loaded_extensions("structural");
    let or_unavailable = |extensions: Vec<&str>| {
        if extensions.is_empty() {
            "unavailable".to_string()
        } else {
            extensions.join(" ")
        }
    };
    [
        format!("Symbol read/edit: {}", or_unavailable(symbolic)),
        format!("Structural read/edit: {}", or_unavailable(structural)),
        format!("Raw/range/patch: {} and all unsupported formats", RAW_EXTENSIONS.join(" ")),
        "JS/TS references: configured TypeScript project; query a symbol alias or path#qualifiedName with mode references. Other languages/unavailable projects use labeled lexical candidates.".to_string(),
        "JS/TS rename: edit_code symbol action \"rename\", content = new identifier; fully read target, configured complete project, one operation, up to 50 files. Compiler-derived edits use guarded commit; static guards are not validation evidence.".to_string(),
    ]
    .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_adapter_loads() {
        for capability in runtime_capability_registry() {
            assert!(capability.loaded, "{} failed to load", capability.language);
        }
    }
}
