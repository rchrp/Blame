//! The roles of helper agents and the session each one runs in.
//!
//! The engine fixes every role: its tools, its prompt, its reasoning and its
//! limits. The lead only chooses one and writes the brief, so nothing it read
//! on a page or in a file can give a helper more than the role has.
//!
//! The prompts are short and say what the role does, not who it is: what
//! makes a helper useful is a fresh context, running beside the others, and a
//! compact report.

use super::Lead;
use blame_engine_protocol::{
    CompletionContract, Limits, REPORT, ReasoningEffort, ResultTool, SUB_AGENT_PURPOSE,
    SessionConfig, SessionKind, SubAgentOrigin, SubAgentRole, ToolSpec, UserBlock,
};
use serde_json::{Value, json};

/// Tools a helper reads the code with.
pub(super) const CODE_TOOLS: [&str; 2] = ["search_code", "read_code"];
/// Tools a helper reads the web with.
pub(super) const WEB_TOOLS: [&str; 2] = ["search_web", "read_web_page"];

/// Requests one helper may make. A search, a read and a report are three;
/// sixteen is a careful survey of a large question, and a helper that needs
/// more is asking for what the lead should split.
const MAX_REQUESTS: u32 = 16;
/// Wall time of one helper. Reading and searching take seconds, a rendered
/// web page up to a few; four minutes is long past a useful answer.
const MAX_MS: u64 = 4 * 60 * 1000;
/// Tokens of every request counted, cache reads included: sixteen requests
/// over a context that grows to about thirty thousand tokens.
const MAX_TOKENS: u64 = 500_000;
/// The report is short; the rest of the allowance is the helper's reasoning.
const MAX_OUTPUT_TOKENS: u32 = 8192;

const EXPLORE: &str = "\
You answer one question about a codebase for another agent, which cannot see what you read. You can only read: search_code finds, read_code reads. You cannot edit files, run commands or ask questions.
Search before you read, read only what you need, and stop as soon as the brief is answered.
Finish with `report`: a summary of at most 150 words that answers the brief, and one reference (`path:line`) for each fact the other agent should check or use. Say what you looked for and did not find.";

const RESEARCH: &str = "\
You answer one question from the web for another agent, which cannot see what you read. You can only read: search_web finds pages, read_web_page reads one. You cannot edit files, run commands or ask questions.
Prefer official documentation, changelogs and source code to articles. Give versions and dates when they matter, and say when sources disagree.
Finish with `report`: a summary of at most 150 words that answers the brief, and one reference (the URL) for each fact the other agent should check or use. Say what you looked for and did not find.";

const REVIEW: &str = "\
You review the current changes of a workspace for another agent. They come with the brief; the rest of the code is yours to read: search_code finds, read_code reads. You cannot edit files, run commands or ask questions.
Look for what a careful reviewer would stop a merge for: wrong behaviour, cases the change forgets, callers it breaks, security problems, and anything the brief asked for that is missing. Check the surrounding code before you report a problem. Leave style alone.
Finish with `report`: a summary of at most 150 words that says whether the changes hold, and one reference (`path:line`) per finding, its note starting with `blocker`, `issue` or `nit`. An empty list of references means you found nothing.";

fn prompt(role: SubAgentRole) -> &'static str {
    match role {
        SubAgentRole::Explore => EXPLORE,
        SubAgentRole::Research => RESEARCH,
        SubAgentRole::Review => REVIEW,
    }
}

/// How much a helper reasons: it searches and summarises, and the lead does
/// the thinking, so a little; a review weighs what it reads, so more. Never
/// more than the lead's own effort.
fn effort(lead: Option<ReasoningEffort>, role: SubAgentRole) -> ReasoningEffort {
    let wanted = match role {
        SubAgentRole::Explore | SubAgentRole::Research => ReasoningEffort::Low,
        SubAgentRole::Review => ReasoningEffort::Medium,
    };
    match lead {
        Some(lead) if rank(lead) < rank(wanted) => lead,
        _ => wanted,
    }
}

fn rank(effort: ReasoningEffort) -> u8 {
    match effort {
        ReasoningEffort::Off => 0,
        ReasoningEffort::Minimal => 1,
        ReasoningEffort::Low => 2,
        ReasoningEffort::Medium => 3,
        ReasoningEffort::High => 4,
        ReasoningEffort::Xhigh => 5,
        ReasoningEffort::Max => 6,
    }
}

/// The tools of a role, by name: the whole of what the helper is offered
/// besides its `report`.
pub(super) fn tools(role: SubAgentRole) -> &'static [&'static str] {
    match role {
        SubAgentRole::Explore | SubAgentRole::Review => &CODE_TOOLS,
        SubAgentRole::Research => &WEB_TOOLS,
    }
}

/// Why the lead's session cannot serve `role`, when it cannot.
pub(super) fn unavailable(lead: &Lead, role: SubAgentRole) -> Option<&'static str> {
    match role {
        SubAgentRole::Explore | SubAgentRole::Review if !lead.code => {
            Some("the code tools are not connected to this conversation")
        }
        SubAgentRole::Research if lead.web.len() < WEB_TOOLS.len() => {
            Some("web research is not connected to this conversation")
        }
        _ => None,
    }
}

/// The input schema of a helper's `report`: its result.
pub(super) fn report_schema(role: SubAgentRole) -> Value {
    let what = match role {
        SubAgentRole::Explore | SubAgentRole::Review => "`path:line` in the workspace",
        SubAgentRole::Research => "a URL",
    };
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["summary", "references"],
        "properties": {
            "summary": {
                "type": "string",
                "minLength": 1,
                "maxLength": 3000,
                "description": "The answer to the brief, in at most 150 words."
            },
            "references": {
                "type": "array",
                "maxItems": 12,
                "description": "What the answer rests on, most important first.",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["ref", "note"],
                    "properties": {
                        "ref": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 300,
                            "description": what
                        },
                        "note": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 300,
                            "description": "What it shows, in a sentence."
                        }
                    }
                }
            }
        }
    })
}

/// The configuration of the helper `origin` names: a task of the lead's model
/// and workspace, offered the role's tools and nothing else.
pub(super) fn config(lead: &Lead, origin: SubAgentOrigin) -> SessionConfig {
    let role = origin.role;
    let mut tool_options = serde_json::Map::new();
    if role != SubAgentRole::Research
        && let Some(harness) = &lead.harness
    {
        // The lead's workspace: the harness keeps one per task contract, so
        // the helper reads what the lead's searches already indexed. Its
        // reads count for itself (the harness keys them by session).
        tool_options.insert("harness".into(), harness.clone());
    }
    tool_options.insert(
        blame_engine_protocol::SUBAGENTS.into(),
        serde_json::to_value(&origin).expect("an origin serializes"),
    );
    let web: Vec<ToolSpec> = if role == SubAgentRole::Research {
        lead.web.clone()
    } else {
        Vec::new()
    };
    SessionConfig {
        purpose: format!("{SUB_AGENT_PURPOSE}:{}", role.as_str()),
        workspace_root: lead.workspace_root.clone(),
        model: lead.model.clone(),
        reasoning: Some(effort(lead.reasoning, role)),
        system_prompt: format!(
            "{}\n\nThe workspace is {}.",
            prompt(role),
            lead.workspace_root
        ),
        max_output_tokens: Some(MAX_OUTPUT_TOKENS),
        engine_tools: if role == SubAgentRole::Research {
            Vec::new()
        } else {
            vec![super::HARNESS.into()]
        },
        client_tools: web,
        tool_options,
        limits: Limits {
            max_requests_per_turn: Some(MAX_REQUESTS),
            max_turn_ms: Some(MAX_MS),
            max_turn_tokens: Some(MAX_TOKENS),
            ..Limits::default()
        },
        checkpoints: false,
        kind: SessionKind::Task { replicate: false },
        contract: Some(CompletionContract {
            result: ResultTool::Submit {
                name: REPORT.into(),
                description: "Hand your result to the agent that asked. Call it once, when the brief is answered.".into(),
                input_schema: report_schema(role),
            },
            required: Vec::new(),
            // The tool list is the permission: a helper reads and reports,
            // and is offered nothing else, `run_agents` included.
            allowed: Some(tools(role).iter().map(|name| (*name).to_owned()).collect()),
            max_corrections: 2,
        }),
    }
}

/// What the helper is told: the brief, and for a review the changes.
pub(super) fn instruction(brief: &str, changes: Option<&str>) -> Vec<UserBlock> {
    let mut blocks = vec![UserBlock::Text {
        text: brief.to_owned(),
    }];
    if let Some(changes) = changes {
        blocks.push(UserBlock::Text {
            text: changes.to_owned(),
        });
    }
    blocks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_helper_never_reasons_more_than_its_lead() {
        assert_eq!(
            effort(Some(ReasoningEffort::Off), SubAgentRole::Review),
            ReasoningEffort::Off
        );
        assert_eq!(
            effort(Some(ReasoningEffort::Low), SubAgentRole::Review),
            ReasoningEffort::Low
        );
        assert_eq!(
            effort(Some(ReasoningEffort::Max), SubAgentRole::Explore),
            ReasoningEffort::Low
        );
        assert_eq!(effort(None, SubAgentRole::Review), ReasoningEffort::Medium);
    }
}
