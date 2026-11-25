//! The helpers, on the core's fakes: a lead session with the real router
//! (`SessionTools`), helpers that are real task sessions, a scripted model.

use super::*;
use crate::connection::Host;
use crate::tools::{SessionTools, ToolShared};
use blame_engine_core::ports::{ModelMessage, ModelRequest, SessionStore};
use blame_engine_core::testing::{
    Behavior, ManualClock, MemoryStore, Script, ScriptedProvider, ScriptedTools, World, config,
    spec,
};
use blame_engine_core::{EngineOptions, Ports};
use blame_engine_protocol::{Delivery, Record, RecordBody, SUBAGENTS, TurnOutcome};
use std::collections::VecDeque;
use tokio::sync::Notify;

const CODE: [&str; 2] = ["search_code", "read_code"];

fn lead_config() -> SessionConfig {
    SessionConfig {
        engine_tools: vec![SUBAGENTS.into()],
        client_tools: vec![
            spec("search_web", ToolEffect::ReadOnly),
            spec("read_web_page", ToolEffect::ReadOnly),
        ],
        checkpoints: false,
        ..config()
    }
}

/// What a lead with the harness's code tools may give its helpers.
fn lead_with_code() -> Lead {
    let harness_tools: HashSet<String> = CODE.iter().map(|name| (*name).to_owned()).collect();
    Lead::new(
        &lead_config(),
        Some(&json!({ "taskContract": { "session_id": "lead" } })),
        &harness_tools,
    )
}

fn agent(role: &str, brief: &str) -> Value {
    json!({ "role": role, "title": format!("{role} {brief}"), "brief": brief })
}

fn agents(list: &[Value]) -> Value {
    json!({ "agents": list })
}

fn is_lead(request: &ModelRequest) -> bool {
    request.tools.iter().any(|tool| tool.name == RUN_AGENTS)
}

fn answered(request: &ModelRequest) -> bool {
    matches!(request.messages.last(), Some(ModelMessage::ToolResults(_)))
}

fn brief_of(request: &ModelRequest) -> String {
    request
        .messages
        .iter()
        .find_map(|message| match message {
            ModelMessage::User(blocks) => blocks.iter().find_map(|block| match block {
                UserBlock::Text { text } => Some(text.clone()),
                _ => None,
            }),
            _ => None,
        })
        .unwrap_or_default()
}

/// A helper's script: look once, report; a `sneaky` brief tries what it must
/// not first, a `broken` one cannot reach the model.
fn helper_reply(request: &ModelRequest) -> Script {
    let brief = brief_of(request);
    if brief.contains("broken") {
        return Script::error(blame_engine_protocol::ErrorKind::Authentication);
    }
    if answered(request) {
        if request.tools.iter().any(|tool| tool.name == "report") {
            return Script::tool_calls(&[(
                "report",
                json!({
                    "summary": format!("answer to {brief}"),
                    "references": [{ "ref": "src/a.rs:1", "note": "where" }]
                }),
            )]);
        }
        return Script::text("no report tool");
    }
    if brief.contains("sneaky") {
        return Script::tool_calls(&[
            ("write", json!({ "path": "x", "text": "y" })),
            ("run_agents", agents(&[agent("explore", "more")])),
            ("search_code", json!({ "query": "x" })),
        ]);
    }
    let look = if request.tools.iter().any(|tool| tool.name == "search_web") {
        "search_web"
    } else {
        "search_code"
    };
    Script::tool_calls(&[(look, json!({ "query": brief }))])
}

/// The model: the lead calls `run_agents` with each input in turn (one per
/// message), then answers; helpers answer as above.
fn model(inputs: Vec<Value>) -> ScriptedProvider {
    let inputs = std::sync::Arc::new(Mutex::new(VecDeque::from(inputs)));
    ScriptedProvider::responding(move |request| {
        if !is_lead(request) {
            return helper_reply(request);
        }
        if answered(request) {
            return Script::text("done");
        }
        let next = inputs.lock().expect("inputs").pop_front();
        match next {
            Some(input) => Script::tool_calls(&[(RUN_AGENTS, input)]),
            None => Script::text("nothing to ask"),
        }
    })
}

/// Everything a test needs: the fakes, the helpers' tools and what the
/// fleet started.
struct Bench {
    world: World,
    /// What the helpers' tool host offers: more than they may use.
    tools: ScriptedTools,
    fleet: std::sync::Arc<TestFleet>,
    subagents: std::sync::Arc<SubAgents>,
}

struct TestFleet {
    world: World,
    tools: ScriptedTools,
    started: Mutex<Vec<(SessionId, SessionConfig, Session)>>,
    released: Mutex<Vec<SessionId>>,
}

#[async_trait]
impl Fleet for TestFleet {
    async fn start(
        &self,
        lead: &SessionId,
        id: SessionId,
        config: SessionConfig,
        instruction: Vec<UserBlock>,
    ) -> Result<Session, EngineError> {
        let mut ports = self.world.ports();
        ports.tools = std::sync::Arc::new(self.tools.clone());
        ports.provider = std::sync::Arc::new(AsLead::new(ports.provider.clone(), lead.clone()));
        let session = Session::create_task(
            ports,
            EngineOptions::default(),
            id.clone(),
            config.clone(),
            instruction,
        )
        .await?;
        self.started
            .lock()
            .expect("started")
            .push((id, config, session.clone()));
        Ok(session)
    }

    fn release(&self, id: &SessionId) {
        self.released.lock().expect("released").push(id.clone());
    }
}

fn bench(provider: ScriptedProvider, caps: Caps, helper_tools: ScriptedTools) -> Bench {
    let mut world = World::new(provider);
    // Helpers have time limits: their clock must not run by itself.
    let clock = ManualClock::manual();
    world.store = MemoryStore::with_clock(std::sync::Arc::new(clock.clone()));
    world.clock = clock;
    let fleet = std::sync::Arc::new(TestFleet {
        world: world.clone(),
        tools: helper_tools.clone(),
        started: Mutex::default(),
        released: Mutex::default(),
    });
    let subagents = std::sync::Arc::new(SubAgents::new(caps));
    let as_fleet: std::sync::Arc<dyn Fleet> = fleet.clone();
    subagents.attach(std::sync::Arc::downgrade(&as_fleet));
    Bench {
        world,
        tools: helper_tools,
        fleet,
        subagents,
    }
}

/// The helpers' tool host: what it offers is more than a helper may use, so
/// the tests show the contract narrows it.
fn helper_tools(gate: Option<std::sync::Arc<Notify>>) -> ScriptedTools {
    let mut specs = vec![
        spec("search_code", ToolEffect::ReadOnly),
        spec("read_code", ToolEffect::ReadOnly),
        spec("search_web", ToolEffect::ReadOnly),
        spec("read_web_page", ToolEffect::ReadOnly),
        spec("write", ToolEffect::WorkspaceWrite),
        spec("run_task", ToolEffect::Command),
        spec("finish_task", ToolEffect::ReadOnly),
    ];
    specs.push(super::spec());
    ScriptedTools::new(specs, move |invocation, _| {
        let output = ToolOutput::text(ToolOutcome::Completed, format!("{} ran", invocation.name));
        match &gate {
            Some(gate) => Behavior::Gated(gate.clone(), output),
            None => Behavior::Slow(output),
        }
    })
}

fn invocation(call: &str, input: Value, ultra: bool) -> ToolInvocation {
    ToolInvocation {
        session: SessionId::from("lead"),
        turn: blame_engine_protocol::TurnId::from("turn-1"),
        call: ToolCallId::from(call),
        name: RUN_AGENTS.into(),
        input,
        workspace_root: "/work".into(),
        compacted_through: None,
        ultra,
        approved: false,
    }
}

/// One `run_agents` call straight to the helpers, with what it reported.
async fn run(
    bench: &Bench,
    lead: &Lead,
    call: &str,
    input: Value,
    ultra: bool,
) -> (ToolOutput, Vec<RunAgentsProgress>) {
    let seen = std::sync::Arc::new(Mutex::new(Vec::new()));
    let progress: ToolProgress = {
        let seen = seen.clone();
        std::sync::Arc::new(move |text: String| {
            let progress: RunAgentsProgress = serde_json::from_str(&text).expect("progress");
            seen.lock().expect("seen").push(progress);
        })
    };
    let output = bench
        .subagents
        .run(
            &SessionId::from("lead"),
            lead,
            invocation(call, input, ultra),
            progress,
            CancellationToken::new(),
        )
        .await;
    let seen = seen.lock().expect("seen").clone();
    (output, seen)
}

fn result_of(output: &ToolOutput) -> RunAgentsResult {
    let blame_engine_protocol::ToolResultBlock::Text { text } = &output.content[0] else {
        panic!("a text result");
    };
    serde_json::from_str(text).unwrap_or_else(|error| panic!("{error}: {text}"))
}

fn text_of(output: &ToolOutput) -> &str {
    match &output.content[0] {
        blame_engine_protocol::ToolResultBlock::Text { text } => text,
        other => panic!("a text result, not {other:?}"),
    }
}

async fn until(mut condition: impl FnMut() -> bool) {
    for _ in 0..10_000 {
        if condition() {
            return;
        }
        tokio::task::yield_now().await;
    }
    panic!("the condition never held");
}

/// Once `ready`, opens the gate over and over until the helpers made `calls`
/// tool calls in all: whoever waits at it passes.
fn open_when(gate: std::sync::Arc<Notify>, tools: ScriptedTools, ready: usize, calls: usize) {
    tokio::spawn(async move {
        until(|| tools.log().running == ready).await;
        while tools.log().executions.len() < calls || tools.log().running > 0 {
            gate.notify_waiters();
            tokio::task::yield_now().await;
        }
    });
}

#[tokio::test]
async fn helpers_run_side_by_side_and_each_reports() {
    let gate = std::sync::Arc::new(Notify::new());
    let tools = helper_tools(Some(gate.clone()));
    let bench = bench(model(vec![]), Caps::default(), tools.clone());
    open_when(gate, tools.clone(), 3, 3);
    let input = agents(&[
        agent("explore", "where is the router"),
        agent("explore", "where is the store"),
        agent("research", "what changed in the API"),
    ]);
    let (output, _) = run(&bench, &lead_with_code(), "call-a", input, true).await;
    assert_eq!(output.outcome, ToolOutcome::Completed);
    let result = result_of(&output);
    assert_eq!(result.agents.len(), 3);
    assert_eq!(tools.log().max_running, 3, "the three ran at the same time");
    for (index, agent) in result.agents.iter().enumerate() {
        assert_eq!(agent.index as usize, index);
        assert_eq!(agent.status, SubAgentStatus::Completed);
        assert_eq!(agent.session.as_str(), format!("call-a.{index}"));
        let report = agent.report.as_ref().expect("a report");
        assert!(report.summary.starts_with("answer to "));
        assert_eq!(report.references[0].reference, "src/a.rs:1");
        // Two replies of 15 tokens each.
        assert_eq!(agent.tokens, 30);
    }
    assert_eq!(result.tokens, 90);
    assert_eq!(result.agents[2].role, SubAgentRole::Research);
    let released = bench.fleet.released.lock().expect("released").len();
    assert_eq!(released, 3, "their copies in memory are let go");
}

#[tokio::test]
async fn each_helper_has_its_own_records_linked_to_the_call() {
    let bench = bench(model(vec![]), Caps::default(), helper_tools(None));
    let input = agents(&[agent("explore", "first"), agent("review", "second")]);
    let (output, _) = run(&bench, &lead_with_code(), "call-b", input, true).await;
    assert_eq!(result_of(&output).agents.len(), 2);
    let started = bench.fleet.started.lock().expect("started").clone();
    assert_eq!(started.len(), 2);
    for (index, (id, config, session)) in started.iter().enumerate() {
        assert_eq!(id.as_str(), format!("call-b.{index}"));
        assert!(config.purpose.starts_with("sub-agent:"));
        assert!(config.kind.is_task());
        let origin: SubAgentOrigin =
            serde_json::from_value(config.tool_options[SUBAGENTS].clone()).expect("an origin");
        assert_eq!(origin.call.as_str(), "call-b");
        assert_eq!(origin.index as usize, index);
        assert_eq!(origin.lead.as_str(), "lead");
        // Their own log, which says how they ended.
        let records = session.records().await;
        assert!(matches!(
            records.last().map(|record| &record.body),
            Some(RecordBody::TurnEnded {
                outcome: TurnOutcome::Completed,
                ..
            })
        ));
    }
}

#[tokio::test]
async fn a_call_made_while_ultra_is_off_is_refused_and_starts_nothing() {
    let bench = bench(model(vec![]), Caps::default(), helper_tools(None));
    let input = agents(&[agent("explore", "x")]);
    let (output, _) = run(&bench, &lead_with_code(), "call-c", input, false).await;
    assert_eq!(output.outcome, ToolOutcome::Denied);
    assert!(text_of(&output).contains("ultra mode is off for this message"));
    assert!(bench.fleet.started.lock().expect("started").is_empty());
    assert_eq!(bench.world.provider.requests().len(), 0);
}

#[tokio::test]
async fn an_input_that_breaks_the_schema_is_refused_with_where() {
    let bench = bench(model(vec![]), Caps::default(), helper_tools(None));
    let five: Vec<Value> = (0..5).map(|n| agent("explore", &format!("q{n}"))).collect();
    for input in [
        agents(&[]),
        agents(&five),
        agents(&[json!({ "role": "plan", "title": "t", "brief": "b" })]),
        json!({ "agents": [{ "role": "explore", "brief": "b" }] }),
    ] {
        let (output, _) = run(&bench, &lead_with_code(), "call-d", input, true).await;
        assert_eq!(output.outcome, ToolOutcome::Failed);
        assert!(text_of(&output).starts_with("Not started: the input does not match"));
    }
    assert!(bench.fleet.started.lock().expect("started").is_empty());
}

#[tokio::test]
async fn a_turn_starts_so_many_helpers_and_no_more() {
    let caps = Caps {
        per_turn: 5,
        ..Caps::default()
    };
    let bench = bench(model(vec![]), caps, helper_tools(None));
    let four: Vec<Value> = (0..4).map(|n| agent("explore", &format!("q{n}"))).collect();
    let lead = lead_with_code();
    let (first, _) = run(&bench, &lead, "call-e1", agents(&four), true).await;
    assert_eq!(first.outcome, ToolOutcome::Completed);
    let (second, _) = run(&bench, &lead, "call-e2", agents(&four), true).await;
    assert_eq!(second.outcome, ToolOutcome::Denied);
    assert!(
        text_of(&second).contains("a turn may start 5 helper agents, and this one has started 4")
    );
    let (third, _) = run(&bench, &lead, "call-e3", agents(&four[..1]), true).await;
    assert_eq!(third.outcome, ToolOutcome::Completed);
    assert_eq!(bench.fleet.started.lock().expect("started").len(), 5);
}

#[tokio::test]
async fn the_engine_runs_so_many_at_once_and_the_rest_wait_their_turn() {
    let caps = Caps {
        per_engine: 2,
        ..Caps::default()
    };
    let gate = std::sync::Arc::new(Notify::new());
    let tools = helper_tools(Some(gate.clone()));
    let bench = bench(model(vec![]), caps, tools.clone());
    open_when(gate, tools.clone(), 2, 4);
    let four: Vec<Value> = (0..4).map(|n| agent("explore", &format!("q{n}"))).collect();
    let (output, progress) = run(&bench, &lead_with_code(), "call-f", agents(&four), true).await;
    let result = result_of(&output);
    assert!(
        result
            .agents
            .iter()
            .all(|agent| agent.status == SubAgentStatus::Completed)
    );
    assert_eq!(
        tools.log().max_running,
        2,
        "never more than the engine's share"
    );
    // The viewers were told who waited, and the queue emptied.
    assert!(progress.iter().any(|seen| seen.queued == [2, 3]));
    assert_eq!(progress.last().expect("progress").queued, Vec::<u32>::new());
    assert_eq!(bench.subagents.gate().running(), 0);
}

#[tokio::test]
async fn a_helper_is_offered_its_roles_tools_and_nothing_else() {
    let bench = bench(model(vec![]), Caps::default(), helper_tools(None));
    let input = agents(&[
        agent("explore", "a"),
        agent("research", "b"),
        agent("review", "c"),
    ]);
    let (output, _) = run(&bench, &lead_with_code(), "call-g", input, true).await;
    assert_eq!(output.outcome, ToolOutcome::Completed);
    let offered: Vec<Vec<String>> = bench
        .world
        .provider
        .requests()
        .iter()
        .filter(|request| !is_lead(request))
        .filter(|request| !answered(request))
        .map(|request| request.tools.iter().map(|tool| tool.name.clone()).collect())
        .collect();
    assert_eq!(offered.len(), 3);
    let mut seen = offered.clone();
    seen.sort();
    assert_eq!(
        seen,
        vec![
            vec!["read_code", "report", "search_code"],
            vec!["read_code", "report", "search_code"],
            vec!["read_web_page", "report", "search_web"],
        ],
        "no write, no command, no finish, and no run_agents: a helper cannot start helpers"
    );
    for (_, config, _) in bench.fleet.started.lock().expect("started").iter() {
        assert!(!config.engine_tools.iter().any(|name| name == SUBAGENTS));
        assert!(!config.kind.is_conversation());
    }
}

#[tokio::test]
async fn a_helper_that_asks_for_a_tool_it_was_not_offered_runs_nothing() {
    let bench = bench(model(vec![]), Caps::default(), helper_tools(None));
    let input = agents(&[agent("explore", "sneaky")]);
    let (output, _) = run(&bench, &lead_with_code(), "call-h", input, true).await;
    assert_eq!(
        result_of(&output).agents[0].status,
        SubAgentStatus::Completed
    );
    let ran: Vec<String> = bench
        .tools
        .log()
        .executions
        .iter()
        .map(|call| call.name.clone())
        .collect();
    assert_eq!(
        ran,
        ["search_code"],
        "the write and the nested call never ran"
    );
    let session = bench.fleet.started.lock().expect("started")[0].2.clone();
    let records = session.records().await;
    let refused: Vec<&str> = records
        .iter()
        .filter_map(|record| match &record.body {
            RecordBody::ToolCallFinished {
                outcome: ToolOutcome::Failed,
                content,
                ..
            } => match &content[0] {
                blame_engine_protocol::ToolResultBlock::Text { text } => Some(text.as_str()),
                _ => None,
            },
            _ => None,
        })
        .collect();
    assert_eq!(
        refused,
        [
            "There is no tool named `write`.",
            "There is no tool named `run_agents`."
        ]
    );
}

#[tokio::test]
async fn roles_the_session_cannot_serve_are_refused_by_name() {
    let bench = bench(model(vec![]), Caps::default(), helper_tools(None));
    // The lead has neither the code tools nor the web.
    let bare = Lead::new(
        &SessionConfig {
            client_tools: Vec::new(),
            ..lead_config()
        },
        None,
        &HashSet::new(),
    );
    for (role, why) in [
        ("explore", "the code tools are not connected"),
        ("review", "the code tools are not connected"),
        ("research", "web research is not connected"),
    ] {
        let (output, _) = run(&bench, &bare, "call-i", agents(&[agent(role, "x")]), true).await;
        assert_eq!(output.outcome, ToolOutcome::Denied);
        assert!(text_of(&output).contains(&format!("no `{role}` helper here")));
        assert!(text_of(&output).contains(why));
    }
    assert!(bench.fleet.started.lock().expect("started").is_empty());
}

#[tokio::test]
async fn claude_code_gets_no_helpers() {
    let bench = bench(model(vec![]), Caps::default(), helper_tools(None));
    let mut config = lead_config();
    config.model.provider = "claude-code".into();
    let lead = Lead::new(
        &config,
        None,
        &CODE.iter().map(|name| (*name).to_owned()).collect(),
    );
    let (output, _) = run(
        &bench,
        &lead,
        "call-j",
        agents(&[agent("explore", "x")]),
        true,
    )
    .await;
    assert_eq!(output.outcome, ToolOutcome::Denied);
    assert!(text_of(&output).contains("not available with Claude Code"));
    assert!(bench.fleet.started.lock().expect("started").is_empty());
}

#[tokio::test]
async fn a_helper_that_fails_says_so_and_the_others_still_report() {
    let bench = bench(model(vec![]), Caps::default(), helper_tools(None));
    let input = agents(&[agent("explore", "fine"), agent("explore", "broken")]);
    let (output, _) = run(&bench, &lead_with_code(), "call-k", input, true).await;
    assert_eq!(output.outcome, ToolOutcome::Completed);
    let result = result_of(&output);
    assert_eq!(result.agents[0].status, SubAgentStatus::Completed);
    assert_eq!(result.agents[1].status, SubAgentStatus::Failed);
    assert!(result.agents[1].report.is_none());
    assert!(
        result.agents[1]
            .reason
            .as_deref()
            .is_some_and(|reason| reason.starts_with("The model failed"))
    );
}

#[tokio::test]
async fn helpers_ask_the_model_as_their_lead_does() {
    let bench = bench(model(vec![]), Caps::default(), helper_tools(None));
    let input = agents(&[agent("explore", "x")]);
    run(&bench, &lead_with_code(), "call-l", input, true).await;
    let keys: Vec<String> = bench
        .world
        .provider
        .requests()
        .iter()
        .map(|request| request.cache.key.clone())
        .collect();
    assert!(!keys.is_empty());
    assert!(
        keys.iter().all(|key| key == "lead"),
        "the credential and the cache are the lead's: {keys:?}"
    );
}

#[tokio::test]
async fn a_helper_reasons_little_and_has_limits() {
    let bench = bench(model(vec![]), Caps::default(), helper_tools(None));
    let input = agents(&[agent("explore", "x"), agent("review", "y")]);
    run(&bench, &lead_with_code(), "call-m", input, true).await;
    let started = bench.fleet.started.lock().expect("started");
    let (explore, review) = (&started[0].1, &started[1].1);
    // The lead's setting is medium: an explorer needs less, a reviewer the same.
    assert_eq!(
        explore.reasoning,
        Some(blame_engine_protocol::ReasoningEffort::Low)
    );
    assert_eq!(
        review.reasoning,
        Some(blame_engine_protocol::ReasoningEffort::Medium)
    );
    for config in [explore, review] {
        assert_eq!(config.model, lead_config().model);
        assert!(config.limits.max_requests_per_turn.is_some());
        assert!(config.limits.max_turn_ms.is_some());
        assert!(config.limits.max_turn_tokens.is_some());
        assert!(!config.checkpoints);
    }
    // The system prompt is the role's: the same bytes for every helper of it.
    assert!(
        explore
            .system_prompt
            .starts_with("You answer one question about a codebase")
    );
    assert!(
        review
            .system_prompt
            .starts_with("You review the current changes")
    );
}

// What follows runs through a lead session and the real router.

struct Lead_ {
    lead: Session,
    bench: Bench,
}

async fn lead_session(
    inputs: Vec<Value>,
    caps: Caps,
    gate: Option<std::sync::Arc<Notify>>,
) -> Lead_ {
    let bench = bench(model(inputs), caps, helper_tools(gate));
    let shared = ToolShared {
        host: std::sync::Arc::new(Host::default()),
        harness: None,
        store: std::sync::Arc::new(bench.world.store.clone()) as std::sync::Arc<dyn SessionStore>,
        subagents: bench.subagents.clone(),
    };
    let id = SessionId::from("lead");
    let mut ports: Ports = bench.world.ports();
    ports.tools = std::sync::Arc::new(SessionTools::new(id.clone(), shared));
    let lead = Session::create(ports, EngineOptions::default(), id, lead_config())
        .await
        .expect("a lead");
    Lead_ { lead, bench }
}

fn message(text: &str, ultra: bool) -> Vec<UserBlock> {
    let mut blocks = vec![UserBlock::Text { text: text.into() }];
    if ultra {
        blocks.push(UserBlock::Ultra);
    }
    blocks
}

fn finished<'a>(records: &'a [Record], name: &str) -> Vec<(&'a ToolOutcome, &'a str)> {
    let calls: Vec<&blame_engine_protocol::ToolCallId> = records
        .iter()
        .filter_map(|record| match &record.body {
            RecordBody::ToolCallStarted { call, name: n, .. } if n == name => Some(call),
            _ => None,
        })
        .collect();
    records
        .iter()
        .filter_map(|record| match &record.body {
            RecordBody::ToolCallFinished {
                call,
                outcome,
                content,
                ..
            } if calls.contains(&call) => match &content[0] {
                blame_engine_protocol::ToolResultBlock::Text { text } => {
                    Some((outcome, text.as_str()))
                }
                _ => None,
            },
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn a_message_with_ultra_lets_the_lead_start_helpers_and_the_next_one_does_not() {
    let one = agents(&[agent("research", "first"), agent("research", "second")]);
    let two = agents(&[agent("research", "third")]);
    let Lead_ { lead, bench } = lead_session(vec![one, two], Caps::default(), None).await;
    lead.send(message("look it up", true), Delivery::Turn)
        .await
        .expect("sent");
    lead.wait_idle().await;
    lead.send(message("and again", false), Delivery::Turn)
        .await
        .expect("sent");
    lead.wait_idle().await;
    let records = lead.records().await;
    let calls = finished(&records, RUN_AGENTS);
    assert_eq!(calls.len(), 2);
    assert_eq!(*calls[0].0, ToolOutcome::Completed);
    assert_eq!(
        result_of(&ToolOutput::text(ToolOutcome::Completed, calls[0].1))
            .agents
            .len(),
        2
    );
    assert_eq!(
        *calls[1].0,
        ToolOutcome::Denied,
        "ultra was on for the first message only"
    );
    assert!(calls[1].1.contains("ultra mode is off for this message"));
    assert_eq!(bench.fleet.started.lock().expect("started").len(), 2);
}

#[tokio::test]
async fn toggling_ultra_leaves_the_cached_prefix_alone() {
    let ask = agents(&[agent("research", "q")]);
    let Lead_ { lead, bench } = lead_session(vec![ask.clone(), ask], Caps::default(), None).await;
    lead.send(message("one", false), Delivery::Turn)
        .await
        .expect("sent");
    lead.wait_idle().await;
    lead.send(message("two", true), Delivery::Turn)
        .await
        .expect("sent");
    lead.wait_idle().await;
    let requests: Vec<ModelRequest> = bench
        .world
        .provider
        .requests()
        .into_iter()
        .filter(is_lead)
        .collect();
    assert_eq!(requests.len(), 4);
    let (before, after) = (&requests[1], &requests[2]);
    assert_eq!(
        before.tools, after.tools,
        "the tool list is the same whatever a message asks"
    );
    assert_eq!(before.system, after.system);
    // Everything the model read before the toggle is read again unchanged.
    assert_eq!(after.messages[..before.messages.len()], before.messages[..]);
    let last_user = after
        .messages
        .iter()
        .rev()
        .find_map(|message| match message {
            ModelMessage::User(blocks) => Some(blocks),
            _ => None,
        });
    assert!(
        last_user
            .expect("a user message")
            .contains(&UserBlock::Ultra)
    );
}

#[tokio::test]
async fn interrupting_the_lead_stops_its_helpers() {
    let input = agents(&[
        agent("research", "a"),
        agent("research", "b"),
        agent("research", "c"),
    ]);
    let gate = std::sync::Arc::new(Notify::new());
    let Lead_ { lead, bench } = lead_session(vec![input], Caps::default(), Some(gate)).await;
    lead.send(message("go", true), Delivery::Turn)
        .await
        .expect("sent");
    let tools = bench.tools.clone();
    until(|| tools.log().running == 3).await;
    lead.interrupt().await.expect("interrupted");
    lead.wait_idle().await;
    let records = lead.records().await;
    assert_eq!(*finished(&records, RUN_AGENTS)[0].0, ToolOutcome::Cancelled);
    assert!(records.iter().any(|record| matches!(
        record.body,
        RecordBody::TurnEnded {
            outcome: TurnOutcome::Interrupted,
            ..
        }
    )));
    assert_helpers_interrupted(&bench).await;
    assert_eq!(
        bench.subagents.gate().running(),
        0,
        "their slots are free again"
    );
}

#[tokio::test]
async fn rewinding_the_lead_stops_its_helpers() {
    let input = agents(&[agent("research", "a"), agent("research", "b")]);
    let gate = std::sync::Arc::new(Notify::new());
    let Lead_ { lead, bench } = lead_session(vec![input], Caps::default(), Some(gate)).await;
    lead.send(message("go", true), Delivery::Turn)
        .await
        .expect("sent");
    let tools = bench.tools.clone();
    until(|| tools.log().running == 2).await;
    // Back to before the message.
    lead.rewind(1, false).await.expect("rewound");
    lead.wait_idle().await;
    assert_helpers_interrupted(&bench).await;
    assert_eq!(bench.subagents.gate().running(), 0);
}

async fn assert_helpers_interrupted(bench: &Bench) {
    let started: Vec<Session> = bench
        .fleet
        .started
        .lock()
        .expect("started")
        .iter()
        .map(|(_, _, session)| session.clone())
        .collect();
    assert!(!started.is_empty());
    for session in started {
        session.wait_idle().await;
        let records = session.records().await;
        assert!(
            records.iter().any(|record| matches!(
                record.body,
                RecordBody::TurnEnded {
                    outcome: TurnOutcome::Interrupted,
                    ..
                }
            )),
            "a helper ended as interrupted: {records:#?}"
        );
    }
}
