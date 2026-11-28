//! Helper agents ("ultra mode"): the lead's `run_agents` tool.
//!
//! A call starts one to four read-only helpers, runs them side by side as
//! tasks of their own, waits for all of them and answers with what each
//! reported. What makes a helper useful is not who it is but that it starts
//! with a fresh context, runs beside the others and hands back a short,
//! referenced report; so roles are few and plain (`roles.rs`), and the lead
//! only picks one and writes the brief.
//!
//! - **Rights.** The engine builds each helper's configuration: its tools are
//!   the role's, named in its completion contract, and `run_agents` is never
//!   among them, so a helper cannot start helpers and nothing the lead read
//!   can give it more than the role has.
//! - **Cost.** Per call, per turn, per session and per engine
//!   ([`gate`]); every helper has its own request, time and token limits.
//! - **Cache.** The tool is part of the tool list of every session that may
//!   use it, whatever a message asks for: a list that changed with the
//!   message would change the cached prefix at every toggle. Whether a call
//!   may run is read from the log instead (`UserBlock::Ultra` in a message of
//!   the turn, see `ToolInvocation::ultra`), and a call made while it is off
//!   is refused with the reason.
//! - **Stopping.** The call is the lead's: an interrupt, a rewind or the
//!   engine stopping cancels it, and it interrupts its helpers before it
//!   answers.

mod gate;
mod outcome;
mod review;
mod roles;
#[cfg(test)]
mod tests;

pub use gate::{Caps, Gate};

use async_trait::async_trait;
use blame_engine_core::EngineError;
use blame_engine_core::Session;
use blame_engine_core::contract;
use blame_engine_core::ports::{
    ModelProvider, ModelRequest, ModelStream, ProviderError, ToolInvocation, ToolOutput,
    ToolProgress,
};
use blame_engine_protocol::{
    MAX_AGENTS_PER_CALL, ModelRef, RUN_AGENTS, ReasoningEffort, RunAgentsInput, RunAgentsProgress,
    RunAgentsResult, SessionConfig, SessionId, SubAgentBrief, SubAgentOrigin, SubAgentResult,
    SubAgentRole, SubAgentStatus, ToolCallId, ToolEffect, ToolOutcome, ToolSpec, UserBlock,
    sub_agent_session,
};
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashSet};
use std::sync::{Arc, Mutex, OnceLock, PoisonError, Weak};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

/// The harness's name in `SessionConfig::engine_tools`.
const HARNESS: &str = "harness";
/// The provider whose sessions are whole processes: no helpers there.
const CLAUDE_CODE: &str = "claude-code";
/// How long an interrupted helper may take to end.
const STOP_GRACE: Duration = Duration::from_secs(10);

/// What the engine does for the tool: starts a helper as a task, and lets go
/// of it once it ended. The engine implements it; a test brings its own.
#[async_trait]
pub trait Fleet: Send + Sync {
    /// Starts the task `id`, which asks the model and the client as `lead`
    /// does (its credential, its prompt cache), and runs it.
    async fn start(
        &self,
        lead: &SessionId,
        id: SessionId,
        config: SessionConfig,
        instruction: Vec<UserBlock>,
    ) -> Result<Session, EngineError>;

    /// Drops the copy in memory of a helper that ended, unless somebody
    /// follows it. Its records stay.
    fn release(&self, id: &SessionId);
}

/// What the lead's configuration lets its helpers have, taken when the
/// session's tools are listed.
#[derive(Clone, Debug)]
pub struct Lead {
    model: ModelRef,
    reasoning: Option<ReasoningEffort>,
    workspace_root: String,
    /// `tool_options.harness`, with the lead's session id in its contract:
    /// the helpers read the workspace the lead's searches indexed.
    harness: Option<Value>,
    /// The harness serves `search_code` and `read_code`.
    code: bool,
    /// `search_web` and `read_web_page`, as the lead has them.
    web: Vec<ToolSpec>,
}

impl Lead {
    pub fn new(
        config: &SessionConfig,
        harness_options: Option<&Value>,
        harness_tools: &HashSet<String>,
    ) -> Self {
        Self {
            model: config.model.clone(),
            reasoning: config.reasoning,
            workspace_root: config.workspace_root.clone(),
            harness: harness_options.cloned(),
            code: roles::CODE_TOOLS
                .iter()
                .all(|name| harness_tools.contains(*name)),
            web: config
                .client_tools
                .iter()
                .filter(|spec| roles::WEB_TOOLS.contains(&spec.name.as_str()))
                .cloned()
                .collect(),
        }
    }
}

/// The tool, as the model is offered it. Its text never changes (it is part
/// of the cached prefix): the refusals say what a session cannot do.
pub fn spec() -> ToolSpec {
    ToolSpec {
        name: RUN_AGENTS.into(),
        description: "\
Start 1 to 4 read-only helper agents side by side, wait for all of them and read what each reports. Only when the person's message says ultra mode is on; otherwise the call is refused.
Roles: `explore` reads the code (search_code, read_code); `research` reads the web (search_web, read_web_page); `review` reads the workspace's current changes and the code around them, and reports findings.
A helper starts with a fresh context and sees only its brief: say what to find out, where to look and what you need back. It cannot edit files, run commands or ask you anything. Each returns a summary and references (`path:line` or URLs).
Use it for independent questions you would otherwise answer one after the other. Do not use it for what one or two tool calls answer, or to repeat what a helper already found.".into(),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["agents"],
            "properties": {
                "agents": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": MAX_AGENTS_PER_CALL,
                    "items": {
                        "type": "object",
                        "additionalProperties": false,
                        "required": ["role", "title", "brief"],
                        "properties": {
                            "role": { "enum": ["explore", "research", "review"] },
                            "title": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 80,
                                "description": "A few words naming the question, shown to the person."
                            },
                            "brief": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 4000,
                                "description": "Everything the helper knows: the question, where to look, what to hand back."
                            }
                        }
                    }
                }
            }
        }),
        effect: ToolEffect::ReadOnly,
        ends_turn: false,
        needs_approval: false,
    }
}

/// The engine's helpers: one per engine, shared by every session's router.
pub struct SubAgents {
    fleet: OnceLock<Weak<dyn Fleet>>,
    gate: Gate,
}

impl SubAgents {
    pub fn new(caps: Caps) -> Self {
        Self {
            fleet: OnceLock::new(),
            gate: Gate::new(caps),
        }
    }

    /// Where helpers are started; set once the engine exists.
    pub fn attach(&self, fleet: Weak<dyn Fleet>) {
        let _ = self.fleet.set(fleet);
    }

    #[cfg(test)]
    fn gate(&self) -> &Gate {
        &self.gate
    }

    /// Runs one `run_agents` call of `lead_session`.
    pub async fn run(
        &self,
        lead_session: &SessionId,
        lead: &Lead,
        invocation: ToolInvocation,
        progress: ToolProgress,
        cancel: CancellationToken,
    ) -> ToolOutput {
        let input = match parse(&invocation.input) {
            Ok(input) => input,
            Err(text) => return ToolOutput::text(ToolOutcome::Failed, text),
        };
        if let Some(refusal) = self.refuse(lead_session, lead, &invocation, &input) {
            return refusal;
        }
        let Some(fleet) = self.fleet.get().and_then(Weak::upgrade) else {
            return ToolOutput::text(
                ToolOutcome::Failed,
                "Not started: this engine cannot start helper agents.",
            );
        };
        let call = Call {
            lead_session: lead_session.clone(),
            lead: lead.clone(),
            id: invocation.call.clone(),
            fleet,
            cancel,
            queued: Mutex::default(),
            progress,
        };
        let results = futures_util::future::join_all(
            input
                .agents
                .iter()
                .enumerate()
                .map(|(index, brief)| self.helper(&call, index as u32, brief)),
        )
        .await;
        self.gate.finish(lead_session);
        finish(results, call.cancel.is_cancelled())
    }

    /// Why the call cannot start, as the result the lead reads.
    fn refuse(
        &self,
        session: &SessionId,
        lead: &Lead,
        invocation: &ToolInvocation,
        input: &RunAgentsInput,
    ) -> Option<ToolOutput> {
        let denied = |text: String| Some(ToolOutput::text(ToolOutcome::Denied, text));
        if !invocation.ultra {
            return denied(
                "Not started: ultra mode is off for this message. The person decides when \
helper agents may run. Do the work yourself, and say in your reply if helpers would have \
helped."
                    .into(),
            );
        }
        if lead.model.provider == CLAUDE_CODE {
            return denied(
                "Not started: helper agents are not available with Claude Code. Each one \
would be a whole Claude Code process. Do the work yourself."
                    .into(),
            );
        }
        for brief in &input.agents {
            if let Some(why) = roles::unavailable(lead, brief.role) {
                return denied(format!(
                    "Not started: there is no `{}` helper here, because {why}. Do that part \
yourself, or ask only for the roles that are available.",
                    brief.role.as_str()
                ));
            }
        }
        let count = input.agents.len() as u32;
        if let Err(used) = self.gate.reserve(session, &invocation.turn, count) {
            let per_turn = self.gate.caps().per_turn;
            return denied(format!(
                "Not started: a turn may start {per_turn} helper agents, and this one has \
started {used}. This call asks for {count}. Do the rest yourself."
            ));
        }
        None
    }

    /// One helper, from waiting for a slot to its result.
    async fn helper(&self, call: &Call, index: u32, brief: &SubAgentBrief) -> SubAgentResult {
        let id = sub_agent_session(&call.id, index);
        let ended = |status, reason: &str| SubAgentResult {
            index,
            role: brief.role,
            title: brief.title.clone(),
            status,
            session: id.clone(),
            report: None,
            reason: Some(reason.into()),
            tokens: 0,
            duration_ms: 0,
        };
        let slot = match self.gate.try_slot(&call.lead_session) {
            Some(slot) => slot,
            None => {
                call.waiting(index);
                let slot = tokio::select! {
                    slot = self.gate.slot(&call.lead_session) => Some(slot),
                    () = call.cancel.cancelled() => None,
                };
                call.started(index);
                match slot {
                    Some(slot) => slot,
                    None => {
                        return ended(
                            SubAgentStatus::Cancelled,
                            "It was stopped before it started.",
                        );
                    }
                }
            }
        };
        if call.cancel.is_cancelled() {
            return ended(
                SubAgentStatus::Cancelled,
                "It was stopped before it started.",
            );
        }
        let changes = match brief.role {
            SubAgentRole::Review => review::changes(&call.lead.workspace_root).await,
            _ => None,
        };
        let origin = SubAgentOrigin {
            lead: call.lead_session.clone(),
            call: call.id.clone(),
            index,
            role: brief.role,
        };
        let config = roles::config(&call.lead, origin);
        let instruction = roles::instruction(&brief.brief, changes.as_deref());
        let session = match call
            .fleet
            .start(&call.lead_session, id.clone(), config, instruction)
            .await
        {
            Ok(session) => session,
            Err(error) => {
                return ended(
                    SubAgentStatus::Failed,
                    &format!("It could not be started: {error}"),
                );
            }
        };
        tokio::select! {
            () = session.wait_idle() => {}
            () = call.cancel.cancelled() => {
                let _ = session.interrupt().await;
                let _ = tokio::time::timeout(STOP_GRACE, session.wait_idle()).await;
            }
        }
        let records = session.records().await;
        call.fleet.release(&id);
        drop(slot);
        outcome::result(index, brief, id, &records)
    }
}

/// What every helper of one call shares.
struct Call {
    lead_session: SessionId,
    lead: Lead,
    id: ToolCallId,
    fleet: Arc<dyn Fleet>,
    cancel: CancellationToken,
    /// Helpers still waiting for a slot.
    queued: Mutex<BTreeSet<u32>>,
    progress: ToolProgress,
}

impl Call {
    fn announce(&self) {
        let queued = self
            .queued
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .copied()
            .collect();
        (self.progress)(
            serde_json::to_string(&RunAgentsProgress { queued }).expect("progress serializes"),
        );
    }

    /// Tells the viewers helper `index` waits for a slot.
    fn waiting(&self, index: u32) {
        self.queued
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(index);
        self.announce();
    }

    /// Tells them it does not wait any more.
    fn started(&self, index: u32) {
        self.queued
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&index);
        self.announce();
    }
}

/// The input, checked against the tool's schema.
fn parse(input: &Value) -> Result<RunAgentsInput, String> {
    let errors = contract::validate(&spec().input_schema, input);
    if !errors.is_empty() {
        return Err(format!(
            "Not started: the input does not match the schema:\n- {}",
            errors.join("\n- ")
        ));
    }
    serde_json::from_value(input.clone()).map_err(|error| format!("Not started: {error}"))
}

/// The lead's answer: every helper's result, as JSON.
fn finish(agents: Vec<SubAgentResult>, cancelled: bool) -> ToolOutput {
    if cancelled {
        return ToolOutput::text(
            ToolOutcome::Cancelled,
            "Cancelled: the user interrupted the turn.",
        );
    }
    let completed = agents
        .iter()
        .any(|agent| agent.status == SubAgentStatus::Completed);
    let tokens = agents.iter().map(|agent| agent.tokens).sum();
    let text =
        serde_json::to_string(&RunAgentsResult { agents, tokens }).expect("a result serializes");
    ToolOutput::text(
        if completed {
            ToolOutcome::Completed
        } else {
            ToolOutcome::Failed
        },
        text,
    )
}

/// The model, asked as the lead asks it: the credential the client holds for
/// a session (which of the person's keys the conversation was set up with)
/// and the provider's cache routing are the lead's, not a new session's.
pub struct AsLead {
    inner: Arc<dyn ModelProvider>,
    lead: SessionId,
}

impl AsLead {
    pub fn new(inner: Arc<dyn ModelProvider>, lead: SessionId) -> Self {
        Self { inner, lead }
    }
}

#[async_trait]
impl ModelProvider for AsLead {
    async fn stream(&self, mut request: ModelRequest) -> Result<ModelStream, ProviderError> {
        // The router names the session whose credential it needs by the
        // request's cache key.
        request.cache.key.clone_from(&self.lead.0);
        self.inner.stream(request).await
    }

    fn forces_tool(&self, model: &ModelRef) -> bool {
        self.inner.forces_tool(model)
    }

    fn reads_images(&self, model: &ModelRef) -> bool {
        self.inner.reads_images(model)
    }
}
