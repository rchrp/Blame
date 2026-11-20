//! The tool surface: names, descriptions, input schemas and effects of the
//! harness tools, exactly as the model reads them (`light-tools.ts`,
//! `finish-task.ts`, `engine-tools.ts`). Everything a tool server needs to
//! offer the tools lives here; executing them is `harness.rs`.
//!
//! The descriptions and schemas were tuned by experiments: they are copied
//! byte for byte from the TypeScript harness (`schemas/*.json` are its zod
//! schemas as JSON Schema), and the conformance suite compares them.

use crate::json::Json;
use crate::obj;
use std::sync::LazyLock;

const SEARCH_CODE_DESCRIPTION: &str = "The workspace grep, ripgrep-backed: use it instead of grep, rg or find in run_task. Find source by path, text, regex, symbol, or references. text: whitespace-separated terms match any term, punctuation stays literal, and files containing more terms rank first. regex: one ripgrep regex such as foo|bar or \\bLineSelection\\b. auto picks symbol for a bare identifier. For JS/TS semantic references, set mode to references and query to a symbol sN alias or path#qualifiedName; results state compiler project scope and any lexical fallback. Bare-name fallback proposes nextSearches; choose the intended declaration. output files lists every matching file with its matching-line count; count returns totals. context adds surrounding lines to text matches. A match inside a declaration returns that declaration's sN alias with matchLine. Results come in pages (8 matches or 50 files by default); a limited result carries nextSearch. Case is ignored unless caseSensitive. Search results do not authorize edits: read the target first. Scope accepts paths and *, **, ?, or {a,b} globs; multiple scopes use an array such as [\"src\",\"spec\"]. Spaces in a scope string are literal. Generated outputs and node_modules are excluded.";
const READ_CODE_DESCRIPTION: &str = "Read a text file or local image, compact directory, sN alias, path#qualifiedName, @changes, @checks, or @capabilities. @checks lists current-source check observations without running them; unknown counts stay null. A line range selects those lines; range also takes an array of up to 8 ranges in one call. Without a view, a file comes back whole when that is cheaper, otherwise folded, and that is a complete answer: every line shown is exact, and each body you probably do not need is one line such as `⋯ L82–118 · 2.2k · s9 ↗ parseCode` (hidden lines, size, alias, imported names it uses). Bodies your searches, edits or failing checks hit stay whole. To unfold, read the alias or the line ranges; view raw reads the whole file, and right after a folded view returns only the hidden lines. View outline folds everything it can. Truncated reads propose nextRead without granting unseen coverage. Use view signature on a symbol to inspect its declaration header without its body; read the symbol body before behavioral edits or rename. Symbol outlines list contained declarations. Results state the lines they hold and expose editTargets and containedBy relationships. Generated outputs and ordinary node_modules reads are excluded. For installed dependency types, use view declaration with localFile#importBinding or localFile#importBinding.exportedMember: the configured JS/TS compiler resolves a bounded read-only declaration with package/version identity. This grants no edit coverage and does not establish dependency runtime behavior; follow nextRead for continuation.";
const EDIT_CODE_DESCRIPTION: &str = "Atomically apply symbol operations or focused Cline patches. Each operation uses kind \"symbol\" or \"patch\"; symbol edits put the edit action in action. Example: {\"operations\":[{\"kind\":\"symbol\",\"target\":\"s1\",\"action\":\"replace_body\",\"content\":\"return 2;\"}]}. For configured JS/TS, action \"rename\" with content containing only the new identifier computes related edits via the compiler, preserving existing aliases; first read the complete target declaration. Rename must be the sole operation in a batch; unavailable/incomplete projects or name capture are blocked. Its static guard is not test evidence; run required checks after editing. Set patch target to an observed sN alias to restrict one Update File to that symbol; the header must match its file. Choose the smaller precise edit: replace_body replaces the entire observed body. For a brace-delimited body, unbraced content inherits existing indentation; one-line content becomes inline. Include the outer braces to preserve explicit layout, or use a file patch. For a new file, patch may contain complete raw text; existing files require Cline patch syntax. Do not combine a parent with its containedBy child. The runtime handles freshness, overlaps, and supported syntax checks.";
const RUN_TASK_DESCRIPTION_HEAD: &str = "Run project tasks, validations, generators, formatters, or requested setup. Source inspection belongs to search_code and read_code; simple grep, rg, cat, head, tail and sed -n commands are answered by them. A command still running after the initial wait returns a session-bound rN id: kind inspect with that id waits until it ends (up to 4 minutes) and returns its result; with until set to output it returns at the next output instead. You can read and search code meanwhile. Output comes in pages: follow nextOutput, or fullOutput when a finished command's output was cut. Source changes are journaled and require a subsequent check. Explicit calls execute; finish_task reuses fresh validation. Use the dependency operation for Node packages and native commands for other ecosystems. ";
const RUN_TASK_MANAGED: &str = "Use the managed preview for services. ";
const RUN_TASK_UNMANAGED: &str = "For requested services, detach the process and redirect its input/output so the command can finish. ";
const RUN_TASK_DESCRIPTION_TAIL: &str = "Prettier on explicit files uses atomic edits. Test results include reporting counters; null is unknown and pending is distinct from skipped. Returns bounded output and code/environment diagnostics.";
const FINISH_TASK_DESCRIPTION: &str = "Finish with the final reply the user reads. For a question, conversation, analysis or review, the summary is the answer itself, in the user's language, not a note that no change was needed. For code work, give a concise factual summary. Use run_task reporting or read_code @checks for test counts: null is unknown, pending is distinct from skipped, and unreported categories must not become zero. Separate commands run, passing tests, admitted verification and user criteria. Mention a non-obvious durable implementation decision only when it helps future work. The runtime checks known changes, reuses current checks, and refreshes relevant checks already requested in this session. Work without a current check is reported as unverified. Do not provide receipts or internal state. When the work changed something visible, attach the most useful screenshots you took in this run in images (before/after, each state that was asked for, light and dark when relevant), each with a one-line caption saying what it shows; refer to them as screenshot:<id>, exactly as the screenshot result named them. Do not attach screenshots that show nothing new.";

/// What a call can change, in the engine's vocabulary (`ToolEffect`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Effect {
    ReadOnly,
    WorkspaceWrite,
    Command,
}

impl Effect {
    pub fn as_str(self) -> &'static str {
        match self {
            Effect::ReadOnly => "read_only",
            Effect::WorkspaceWrite => "workspace_write",
            Effect::Command => "command",
        }
    }
}

pub struct ToolDefinition {
    pub name: &'static str,
    pub description: String,
    pub input_schema: Json,
    pub effect: Effect,
    /// The turn ends when this call succeeds.
    pub ends_turn: bool,
    /// Ported in this crate; the others answer that they are not available yet.
    pub available: bool,
}

pub const TOOL_NAMES: [&str; 5] = [
    "search_code",
    "read_code",
    "edit_code",
    "run_task",
    "finish_task",
];

static SCHEMAS: LazyLock<Vec<Json>> = LazyLock::new(|| {
    [
        include_str!("../schemas/search_code.json"),
        include_str!("../schemas/read_code.json"),
        include_str!("../schemas/edit_code.json"),
        include_str!("../schemas/run_task.json"),
        include_str!("../schemas/finish_task.json"),
    ]
    .iter()
    .map(|text| Json::parse(text.trim()).expect("embedded tool schema"))
    .collect()
});

/// The tools offered to a model; `run_task`'s text depends on whether the
/// session has a managed preview.
pub fn tool_definitions(task_contract: Option<&Json>) -> Vec<ToolDefinition> {
    let managed_preview = task_contract
        .and_then(|contract| contract.get("environment"))
        .and_then(|environment| environment.get("managedPreview"));
    let services = if managed_preview == Some(&Json::Bool(false)) {
        RUN_TASK_UNMANAGED
    } else {
        RUN_TASK_MANAGED
    };
    let run_task = format!("{RUN_TASK_DESCRIPTION_HEAD}{services}{RUN_TASK_DESCRIPTION_TAIL}");
    let descriptions = [
        SEARCH_CODE_DESCRIPTION.to_string(),
        READ_CODE_DESCRIPTION.to_string(),
        EDIT_CODE_DESCRIPTION.to_string(),
        run_task,
        FINISH_TASK_DESCRIPTION.to_string(),
    ];
    let effects = [
        Effect::ReadOnly,
        Effect::ReadOnly,
        Effect::WorkspaceWrite,
        Effect::Command,
        Effect::Command,
    ];
    TOOL_NAMES
        .iter()
        .zip(descriptions)
        .zip(effects)
        .enumerate()
        .map(|(index, ((name, description), effect))| ToolDefinition {
            name,
            description,
            input_schema: SCHEMAS[index].clone(),
            effect,
            ends_turn: *name == "finish_task",
            available: index < 3,
        })
        .collect()
}

/// The `describe` answer: `[{name, description, inputSchema, effect, endsTurn}]`.
pub fn describe(request: &Json) -> Json {
    Json::Arr(
        tool_definitions(request.get("taskContract"))
            .into_iter()
            .map(|tool| {
                obj! {
                    "name" => tool.name,
                    "description" => tool.description,
                    "inputSchema" => tool.input_schema,
                    "effect" => tool.effect.as_str(),
                    "endsTurn" => tool.ends_turn,
                }
            })
            .collect(),
    )
}

/// A scope sent as a JSON array in a string, which no real path looks like.
pub fn normalize_search_input(value: &Json) -> Json {
    let Some(Json::Str(scope)) = value.get("scope") else {
        return value.clone();
    };
    let trimmed = crate::text::js_trim(scope);
    if !(trimmed.starts_with('[') && trimmed.ends_with(']')) {
        return value.clone();
    }
    match Json::parse(scope) {
        Ok(Json::Arr(items)) if items.iter().all(|item| matches!(item, Json::Str(_))) => {
            let mut normalized = value.clone();
            normalized.set("scope", Json::Arr(items));
            normalized
        }
        _ => value.clone(),
    }
}
