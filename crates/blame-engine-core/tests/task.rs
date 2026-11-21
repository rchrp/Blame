//! Tasks and completion contracts, driven by a scripted model: the engine,
//! not a prompt, decides when a turn may end.

mod common;

use blame_engine_core::contract::correction_text;
use blame_engine_core::projection::task_outcome;
use blame_engine_core::testing::{
    Behavior, ManualClock, MemoryStore, Script, ScriptedProvider, ScriptedTools, World, config,
    standard_specs,
};
use blame_engine_core::{EngineError, EngineOptions, RecoveryPolicy, Session};
use blame_engine_protocol::{
    CompletionContract, Delivery, Obligation, Record, RecordBody, ResultTool, SessionConfig,
    SessionKind, TaskFailure, TaskOutcome, ToolOutcome, ToolResultBlock, TurnOutcome, Usage,
};
use common::*;
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;

fn title_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["title"],
        "properties": { "title": { "type": "string", "minLength": 1 } }
    })
}

fn contract(required: &[&str]) -> CompletionContract {
    CompletionContract {
        result: ResultTool::Submit {
            name: "submit".into(),
            description: "Submit the result.".into(),
            input_schema: title_schema(),
        },
        required: required.iter().map(|tool| (*tool).to_owned()).collect(),
        allowed: None,
        max_corrections: 2,
    }
}

fn task(required: &[&str]) -> SessionConfig {
    SessionConfig {
        purpose: "title".into(),
        checkpoints: false,
        kind: SessionKind::Task { replicate: false },
        contract: Some(contract(required)),
        ..config()
    }
}

async fn start(world: &World, config: SessionConfig) -> Session {
    Session::create_task(
        world.ports(),
        EngineOptions::default(),
        sid(),
        config,
        text("Name this story."),
    )
    .await
    .expect("starts")
}

async fn run(world: &World, config: SessionConfig) -> (Session, Vec<Record>) {
    let session = start(world, config).await;
    session.wait_idle().await;
    let records = session.records().await;
    (session, records)
}

/// What a task of [`task`] is offered, as the loop sorts it.
fn task_specs() -> Vec<blame_engine_protocol::ToolSpec> {
    let mut specs = blame_engine_core::contract::offered(Some(&contract(&[])), standard_specs());
    specs.sort_by(|a, b| a.name.cmp(&b.name));
    specs
}

fn submit(title: Value) -> Script {
    Script::tool_calls(&[("submit", json!({ "title": title }))])
}

fn corrections(records: &[Record]) -> Vec<(u32, Vec<Obligation>, String, Option<String>)> {
    records
        .iter()
        .filter_map(|record| match &record.body {
            RecordBody::ContractCorrection {
                attempt,
                unmet,
                text,
                forced_tool,
                ..
            } => Some((*attempt, unmet.clone(), text.clone(), forced_tool.clone())),
            _ => None,
        })
        .collect()
}

fn result_texts(records: &[Record]) -> Vec<(ToolOutcome, String)> {
    records
        .iter()
        .filter_map(|record| match &record.body {
            RecordBody::ToolCallFinished {
                outcome, content, ..
            } => Some((
                *outcome,
                content
                    .iter()
                    .map(|block| match block {
                        ToolResultBlock::Text { text } => text.clone(),
                        ToolResultBlock::Image { .. } => String::new(),
                    })
                    .collect(),
            )),
            _ => None,
        })
        .collect()
}

fn accepted_call(records: &[Record]) -> blame_engine_protocol::ToolCallId {
    records
        .iter()
        .find_map(|record| match &record.body {
            RecordBody::ResultAccepted { call, .. } => Some(call.clone()),
            _ => None,
        })
        .expect("a result was accepted")
}

fn call_of(name: &'static str) -> Obligation {
    Obligation::Call { tool: name.into() }
}

fn result_of(name: &'static str) -> Obligation {
    Obligation::Result { tool: name.into() }
}

#[tokio::test]
async fn a_task_ends_with_its_accepted_result() {
    let world = World::new(ScriptedProvider::new());
    world.provider.push(submit(json!("Fix the login page")));
    let (session, records) = run(&world, task(&[])).await;
    assert_eq!(
        kinds(&records),
        [
            "created", "user", "request", "reply", "result", "accepted", "ended"
        ]
    );
    assert_eq!(
        task_outcome(&records),
        Some(TaskOutcome::Completed {
            call: accepted_call(&records),
            result: json!({ "title": "Fix the login page" }),
        })
    );
    let tools: Vec<String> = world.provider.requests()[0]
        .tools
        .iter()
        .map(|tool| tool.name.clone())
        .collect();
    assert!(tools.contains(&"submit".to_owned()), "the engine offers it");
    assert!(session.is_idle());
    check_invariants(&records, &task_specs());
}

#[tokio::test]
async fn a_model_that_stops_early_is_corrected_then_forced_then_fails_as_unmet() {
    let world = World::new(ScriptedProvider::new().forcing_tools());
    for _ in 0..3 {
        world.provider.push(Script::text("Fix the login page"));
    }
    let (_, records) = run(&world, task(&["read"])).await;
    let unmet = vec![call_of("read"), result_of("submit")];
    assert_eq!(
        corrections(&records),
        [
            (1, unmet.clone(), correction_text(&unmet), None),
            (
                2,
                unmet.clone(),
                correction_text(&unmet),
                Some("read".into())
            ),
        ],
        "the text is stored, and the last correction forces the first missing tool"
    );
    assert_eq!(
        kinds(&records),
        [
            "created",
            "user",
            "request",
            "reply",
            "correction",
            "request",
            "reply",
            "correction",
            "request",
            "reply",
            "ended"
        ]
    );
    assert_eq!(
        task_outcome(&records),
        Some(TaskOutcome::Failed {
            failure: TaskFailure::ContractUnmet { unmet }
        })
    );
    let requests = world.provider.requests();
    assert_eq!(
        requests
            .iter()
            .map(|request| request.forced_tool.clone())
            .collect::<Vec<_>>(),
        [None, None, Some("read".into())]
    );
    let last = requests[1].messages.last().expect("messages");
    assert_eq!(
        last,
        &blame_engine_core::ports::ModelMessage::User(vec![
            blame_engine_protocol::UserBlock::Text {
                text: correction_text(&[call_of("read"), result_of("submit")])
            }
        ]),
        "the correction reaches the model as the next message"
    );
    check_invariants(&records, &task_specs());
}

#[tokio::test]
async fn a_provider_that_cannot_force_gets_the_corrective_message_only() {
    let world = World::new(ScriptedProvider::new());
    world
        .provider
        .push(Script::text("a"))
        .push(Script::text("b"))
        .push(submit(json!("Fix the login page")));
    let (_, records) = run(&world, task(&[])).await;
    let forced: Vec<Option<String>> = corrections(&records)
        .into_iter()
        .map(|(_, _, _, forced)| forced)
        .collect();
    assert_eq!(forced, [None, None]);
    assert!(
        world
            .provider
            .requests()
            .iter()
            .all(|request| request.forced_tool.is_none())
    );
    assert!(matches!(
        task_outcome(&records),
        Some(TaskOutcome::Completed { .. })
    ));
}

#[tokio::test]
async fn an_invalid_result_goes_back_to_the_model_which_corrects_it() {
    let world = World::new(ScriptedProvider::new());
    world
        .provider
        .push(submit(json!(42)))
        .push(submit(json!("Fix the login page")));
    let (_, records) = run(&world, task(&[])).await;
    let rejected: Vec<Vec<String>> = records
        .iter()
        .filter_map(|record| match &record.body {
            RecordBody::ResultRejected { invalid, unmet, .. } => {
                assert!(unmet.is_empty());
                Some(invalid.clone())
            }
            _ => None,
        })
        .collect();
    assert_eq!(
        rejected,
        [vec!["/title: expected string, found a number".to_owned()]]
    );
    let results = result_texts(&records);
    assert_eq!(results[0].0, ToolOutcome::Failed);
    assert!(
        results[0]
            .1
            .contains("/title: expected string, found a number"),
        "the model reads why: {}",
        results[0].1
    );
    assert_eq!(
        task_outcome(&records),
        Some(TaskOutcome::Completed {
            call: accepted_call(&records),
            result: json!({ "title": "Fix the login page" }),
        })
    );
    check_invariants(&records, &task_specs());
}

#[tokio::test]
async fn a_result_needs_the_required_tools_done_in_an_earlier_reply() {
    let world = World::new(ScriptedProvider::new());
    world
        .tools
        .workspace()
        .lock()
        .unwrap()
        .insert("a".into(), "story".into());
    world
        .provider
        .push(Script::tool_calls(&[
            ("read", json!({ "path": "a" })),
            ("submit", json!({ "title": "Guessed" })),
        ]))
        .push(submit(json!("Read first")));
    let (_, records) = run(&world, task(&["read"])).await;
    let rejected: Vec<Vec<Obligation>> = records
        .iter()
        .filter_map(|record| match &record.body {
            RecordBody::ResultRejected { unmet, .. } => Some(unmet.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(
        rejected,
        [vec![call_of("read")]],
        "a result in the same reply as the read could not have used it"
    );
    let order: Vec<ToolOutcome> = result_texts(&records).into_iter().map(|(o, _)| o).collect();
    assert_eq!(
        order,
        [
            ToolOutcome::Completed,
            ToolOutcome::Failed,
            ToolOutcome::Completed
        ],
        "the read ran first, the result was judged after it"
    );
    assert_eq!(
        task_outcome(&records),
        Some(TaskOutcome::Completed {
            call: accepted_call(&records),
            result: json!({ "title": "Read first" }),
        })
    );
}

#[tokio::test]
async fn a_required_tool_never_called_fails_the_task_with_exactly_that() {
    let world = World::new(ScriptedProvider::new());
    world
        .provider
        .push(submit(json!("No reading")))
        .push(Script::text("Done."))
        .push(submit(json!("Still no reading")))
        .push(Script::text("Done."))
        .push(Script::text("Done."));
    let (_, records) = run(&world, task(&["read"])).await;
    assert_eq!(
        records
            .iter()
            .filter(|r| matches!(r.body, RecordBody::ResultRejected { .. }))
            .count(),
        2
    );
    assert_eq!(
        task_outcome(&records),
        Some(TaskOutcome::Failed {
            failure: TaskFailure::ContractUnmet {
                unmet: vec![call_of("read"), result_of("submit")]
            }
        })
    );
}

#[tokio::test]
async fn allowed_tools_narrow_what_the_model_is_offered_and_may_call() {
    let world = World::new(ScriptedProvider::new());
    world
        .provider
        .push(Script::tool_calls(&[(
            "write",
            json!({ "path": "x", "text": "1" }),
        )]))
        .push(submit(json!("Fix")));
    let mut config = task(&[]);
    config.contract.as_mut().unwrap().allowed = Some(vec!["read".into()]);
    let (_, records) = run(&world, config).await;
    let offered: Vec<String> = world.provider.requests()[0]
        .tools
        .iter()
        .map(|tool| tool.name.clone())
        .collect();
    assert_eq!(offered, ["read", "submit"]);
    assert_eq!(
        result_texts(&records)[0],
        (
            ToolOutcome::Failed,
            "There is no tool named `write`.".into()
        )
    );
    assert!(world.tools.log().executions.is_empty(), "nothing ran");
    assert!(world.files().is_empty());
}

#[tokio::test]
async fn limits_on_requests_and_tokens_end_the_task() {
    let world = World::new(ScriptedProvider::responding(|_| {
        Script::tool_calls(&[("read", json!({ "path": "a" }))])
    }));
    let mut config = task(&[]);
    config.limits.max_requests_per_turn = Some(3);
    let (_, records) = run(&world, config).await;
    assert_eq!(
        task_outcome(&records),
        Some(TaskOutcome::Failed {
            failure: TaskFailure::LimitReached {
                limit: "max_requests_per_turn".into()
            }
        })
    );
    assert_eq!(world.provider.requests().len(), 3);

    let world = World::new(ScriptedProvider::responding(|_| {
        Script::tool_calls(&[("read", json!({ "path": "a" }))]).with_usage(Usage {
            input_tokens: Some(700),
            cache_read_tokens: Some(200),
            output_tokens: Some(100),
            ..Usage::default()
        })
    }));
    let mut config = task(&[]);
    config.limits.max_turn_tokens = Some(2_500);
    let (_, records) = run(&world, config).await;
    assert_eq!(
        task_outcome(&records),
        Some(TaskOutcome::Failed {
            failure: TaskFailure::LimitReached {
                limit: "max_turn_tokens".into()
            }
        })
    );
    assert_eq!(world.provider.requests().len(), 3, "1000 tokens a reply");
}

fn manual_world(tools: ScriptedTools) -> (World, ManualClock) {
    let clock = ManualClock::manual();
    let mut world = World::new(ScriptedProvider::new()).with_tools(tools);
    world.provider = world.provider.clone().with_clock(clock.clone());
    world.store = MemoryStore::with_clock(Arc::new(clock.clone()));
    world.clock = clock.clone();
    (world, clock)
}

#[tokio::test]
async fn the_wall_time_limit_stops_a_tool_still_running() {
    let (world, clock) = manual_world(ScriptedTools::new(standard_specs(), |_, _| {
        Behavior::UntilCancelled
    }));
    world.provider.push(Script::tool_calls(&[(
        "run",
        json!({ "command": "sleep 600" }),
    )]));
    let mut config = task(&[]);
    config.limits.max_turn_ms = Some(60_000);
    let session = start(&world, config).await;
    until(|| world.tools.log().running == 1).await;
    clock.advance(Duration::from_secs(59));
    tokio::task::yield_now().await;
    assert_eq!(world.tools.log().running, 1, "not yet");
    clock.advance(Duration::from_secs(1));
    session.wait_idle().await;
    let records = session.records().await;
    assert_eq!(
        task_outcome(&records),
        Some(TaskOutcome::Failed {
            failure: TaskFailure::LimitReached {
                limit: "max_turn_ms".into()
            }
        })
    );
    assert_eq!(result_texts(&records)[0].0, ToolOutcome::Cancelled);
}

#[tokio::test]
async fn cancelling_a_task_interrupts_it() {
    let world = World::new(ScriptedProvider::new())
        .with_tools(ScriptedTools::new(standard_specs(), |_, _| {
            Behavior::UntilCancelled
        }));
    world
        .provider
        .push(Script::tool_calls(&[("run", json!({ "command": "make" }))]));
    let session = start(&world, task(&[])).await;
    until(|| world.tools.log().running == 1).await;
    session.interrupt().await.expect("interrupts");
    session.wait_idle().await;
    let records = session.records().await;
    assert_eq!(task_outcome(&records), Some(TaskOutcome::Interrupted));
    assert_eq!(
        kinds(&records),
        [
            "created", "user", "request", "reply", "tool", "result", "ended"
        ]
    );
}

#[tokio::test]
async fn a_task_crashed_in_the_middle_is_settled_on_reopen() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let tools = {
        let gate = gate.clone();
        ScriptedTools::new(standard_specs(), move |_, _| {
            Behavior::Gated(
                gate.clone(),
                blame_engine_core::ports::ToolOutput::text(ToolOutcome::Completed, "ran"),
            )
        })
    };
    let world = World::new(ScriptedProvider::new()).with_tools(tools);
    world
        .provider
        .push(Script::tool_calls(&[("run", json!({ "command": "make" }))]))
        .push(submit(json!("After the crash")));
    let session = start(&world, task(&[])).await;
    until(|| world.tools.log().running == 1).await;
    session.crash().await;
    drop(session);
    assert_eq!(
        task_outcome(&world.store.records(&sid())),
        None,
        "still running"
    );

    let session = Session::open(world.ports(), options(RecoveryPolicy::Stop), sid())
        .await
        .expect("reopens");
    session.wait_idle().await;
    let records = session.records().await;
    assert_eq!(task_outcome(&records), Some(TaskOutcome::Interrupted));
    let tail: Vec<&str> = kinds(&records).into_iter().rev().take(3).collect();
    assert_eq!(tail, ["notice", "ended", "result"]);
    check_invariants(&records, &task_specs());
}

#[tokio::test]
async fn a_task_recovered_with_continue_runs_the_call_again_and_finishes() {
    let first = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let tools = {
        let first = first.clone();
        ScriptedTools::new(standard_specs(), move |_, _| {
            let output = blame_engine_core::ports::ToolOutput::text(ToolOutcome::Completed, "ran");
            if first.swap(false, std::sync::atomic::Ordering::SeqCst) {
                // Never returns: the engine dies while it runs.
                Behavior::Gated(Arc::new(tokio::sync::Notify::new()), output)
            } else {
                Behavior::Output(output)
            }
        })
    };
    let world = World::new(ScriptedProvider::new()).with_tools(tools);
    world
        .provider
        .push(Script::tool_calls(&[("read", json!({ "path": "a" }))]))
        .push(submit(json!("After the crash")));
    let session = start(&world, task(&["read"])).await;
    until(|| world.tools.log().running == 1).await;
    session.crash().await;
    drop(session);
    let session = Session::open(world.ports(), options(RecoveryPolicy::Continue), sid())
        .await
        .expect("reopens");
    session.wait_idle().await;
    let records = session.records().await;
    assert_eq!(
        task_outcome(&records),
        Some(TaskOutcome::Completed {
            call: accepted_call(&records),
            result: json!({ "title": "After the crash" }),
        })
    );
    assert_eq!(world.tools.log().executions.len(), 2, "the read ran again");
    check_invariants(&records, &task_specs());
}

#[tokio::test]
async fn a_task_takes_no_messages_no_rewind_and_no_new_configuration() {
    let world = World::new(ScriptedProvider::new());
    world.provider.push(submit(json!("Fix")));
    let (session, _) = run(&world, task(&[])).await;
    assert!(matches!(
        session.send(text("more"), Delivery::Turn).await,
        Err(EngineError::Task(_))
    ));
    assert!(matches!(
        session.rewind(1, false).await,
        Err(EngineError::Task(_))
    ));
    assert!(matches!(
        session.configure(task(&[])).await,
        Err(EngineError::Task(_))
    ));
    assert!(matches!(
        session.fork(1, "/elsewhere".into(), "s2".into()).await,
        Err(EngineError::Task(_))
    ));
    assert!(matches!(
        Session::create(
            world.ports(),
            EngineOptions::default(),
            "s3".into(),
            task(&[])
        )
        .await,
        Err(EngineError::Task(_))
    ));
    let mut no_contract = task(&[]);
    no_contract.contract = None;
    assert!(matches!(
        Session::create_task(
            world.ports(),
            EngineOptions::default(),
            "s4".into(),
            no_contract,
            text("x")
        )
        .await,
        Err(EngineError::InvalidContract(_))
    ));
}

/// A story's turn: it ends only through an accepted `finish`, the session's
/// own tool, and only once `run` (the checks) completed in that turn.
#[tokio::test]
async fn a_conversation_turn_ends_only_through_its_contract() {
    let world = World::new(ScriptedProvider::new());
    world
        .provider
        // Turn 1: stops in text, is corrected, finishes too early, then right.
        .push(Script::text("I am done."))
        .push(Script::tool_calls(&[("finish", json!({}))]))
        .push(Script::tool_calls(&[("run", json!({ "command": "test" }))]))
        .push(Script::tool_calls(&[("finish", json!({}))]))
        // Turn 2: the obligations start again.
        .push(Script::tool_calls(&[("finish", json!({}))]))
        .push(Script::tool_calls(&[("run", json!({ "command": "test" }))]))
        .push(Script::tool_calls(&[("finish", json!({}))]));
    let config = SessionConfig {
        contract: Some(CompletionContract {
            result: ResultTool::Tool {
                name: "finish".into(),
            },
            required: vec!["run".into()],
            allowed: None,
            max_corrections: 2,
        }),
        ..config()
    };
    let session = Session::create(world.ports(), EngineOptions::default(), sid(), config)
        .await
        .expect("creates");
    turn(&session, "Build it").await;
    let records = session.records().await;
    assert_eq!(
        kinds(&records)[2..],
        [
            "checkpoint",
            "request",
            "reply",
            "correction",
            "request",
            "reply",
            "result",
            "rejected",
            "request",
            "reply",
            "tool",
            "result",
            "request",
            "reply",
            "tool",
            "result",
            "accepted",
            "ended"
        ]
    );
    let finishes = world
        .tools
        .log()
        .executions
        .iter()
        .filter(|invocation| invocation.name == "finish")
        .count();
    assert_eq!(finishes, 1, "a refused finish never ran");
    turn(&session, "Again").await;
    let records = session.records().await;
    let accepted = records
        .iter()
        .filter(|r| matches!(r.body, RecordBody::ResultAccepted { .. }))
        .count();
    let rejected = records
        .iter()
        .filter(|r| matches!(r.body, RecordBody::ResultRejected { .. }))
        .count();
    assert_eq!((accepted, rejected), (2, 2));
    assert!(matches!(
        records.last().map(|r| &r.body),
        Some(RecordBody::TurnEnded {
            outcome: TurnOutcome::Completed,
            ..
        })
    ));
    check_invariants(&records, &sorted_specs());
}

/// A finish the tool itself refuses (its checks still fail) is recorded with
/// why, typed, so the client can keep the agent's last reply as unverified.
#[tokio::test]
async fn a_finish_the_tool_refuses_is_recorded_with_its_typed_reason() {
    let refusal = blame_engine_protocol::Refusal::FailingChecks {
        tasks: vec!["test".into()],
    };
    let refused = refusal.clone();
    let tools = ScriptedTools::new(standard_specs(), move |invocation, _| {
        let mut output = blame_engine_core::ports::ToolOutput::text(
            if invocation.name == "finish" {
                ToolOutcome::Failed
            } else {
                ToolOutcome::Completed
            },
            "Current validation is still failing: test.",
        );
        if invocation.name == "finish" {
            output.refusal = Some(refused.clone());
        }
        Behavior::Output(output)
    });
    let world = World::new(ScriptedProvider::new()).with_tools(tools);
    world
        .provider
        .push(Script::tool_calls(&[("finish", json!({}))]))
        .push(Script::text("The GPU test cannot run here."))
        .push(Script::text("It still cannot."));
    let config = SessionConfig {
        contract: Some(CompletionContract {
            result: ResultTool::Tool {
                name: "finish".into(),
            },
            required: Vec::new(),
            allowed: None,
            max_corrections: 1,
        }),
        ..config()
    };
    let session = Session::create(world.ports(), EngineOptions::default(), sid(), config)
        .await
        .expect("creates");
    turn(&session, "Fix the GPU test").await;
    let records = session.records().await;
    let reasons: Vec<_> = records
        .iter()
        .filter_map(|record| match &record.body {
            RecordBody::ResultRejected { refusal, .. } => Some(refusal.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(reasons, vec![Some(refusal)]);
    // The turn's outcome says why the last finish was refused.
    assert!(matches!(
        records.last().map(|r| &r.body),
        Some(RecordBody::TurnEnded {
            outcome: TurnOutcome::ContractUnmet { refused: Some(why), .. },
            ..
        }) if why == &reasons[0].clone().unwrap()
    ));
}
