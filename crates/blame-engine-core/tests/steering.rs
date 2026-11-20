//! Messages the user sends while a turn runs: a steer joins it, a queued one
//! waits for it to end, and either can be taken back or sent now.

mod common;

use blame_engine_core::testing::{
    Behavior, Script, ScriptedProvider, ScriptedTools, World, config, standard_specs,
};
use blame_engine_core::{EngineError, EngineOptions, RecoveryPolicy, Session};
use blame_engine_protocol::{
    CompletionContract, Delivery, Record, RecordBody, ResultTool, SessionConfig, ToolOutcome,
    TurnOutcome,
};
use common::*;
use serde_json::json;
use std::sync::Arc;

/// A world whose `run` waits for the gate: a turn stays busy in its tool.
fn gated_world(gate: Arc<tokio::sync::Notify>) -> World {
    World::new(ScriptedProvider::new()).with_tools(ScriptedTools::new(
        standard_specs(),
        move |invocation, _| {
            let output = blame_engine_core::ports::ToolOutput::text(
                ToolOutcome::Completed,
                format!("{} ok", invocation.name),
            );
            match invocation.name.as_str() {
                "run" => Behavior::Gated(gate.clone(), output),
                _ => Behavior::Output(output),
            }
        },
    ))
}

async fn tool_running(world: &World) {
    let tools = world.tools.clone();
    until(move || tools.log().running > 0).await;
}

fn ended(records: &[Record], turn: &blame_engine_protocol::TurnId) -> Option<TurnOutcome> {
    records.iter().find_map(|r| match &r.body {
        RecordBody::TurnEnded { turn: t, outcome } if t == turn => Some(outcome.clone()),
        _ => None,
    })
}

fn continued(records: &[Record]) -> usize {
    records
        .iter()
        .filter(|r| matches!(r.body, RecordBody::TurnContinued { .. }))
        .count()
}

#[tokio::test]
async fn a_queued_message_taken_back_never_reaches_the_model() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let world = gated_world(gate.clone());
    world
        .provider
        .push(Script::tool_calls(&[("run", json!({ "command": "test" }))]))
        .push(Script::text("first done"));
    let session = create(&world).await;
    let first = session.send(text("first"), Delivery::Turn).await.unwrap();
    tool_running(&world).await;
    let queued = session.send(text("later"), Delivery::Turn).await.unwrap();
    assert!(!queued.started);
    session.withdraw(queued.turn.clone()).await.unwrap();
    // Gone from the queue: a second withdraw, a promote or a withdraw of
    // the running turn are refused.
    assert!(matches!(
        session.withdraw(queued.turn.clone()).await,
        Err(EngineError::NotQueued(_))
    ));
    assert!(matches!(
        session.promote(queued.turn.clone()).await,
        Err(EngineError::NotQueued(_))
    ));
    assert!(matches!(
        session.withdraw(first.turn.clone()).await,
        Err(EngineError::NotQueued(_))
    ));
    gate.notify_one();
    session.wait_idle().await;
    let records = session.records().await;
    assert_eq!(ended(&records, &queued.turn), Some(TurnOutcome::Withdrawn));
    assert_eq!(ended(&records, &first.turn), Some(TurnOutcome::Completed));
    let requests = world.provider.request_messages();
    assert_eq!(requests.len(), 2, "the withdrawn turn never ran");
    assert!(
        requests
            .iter()
            .all(|r| !user_texts(r).contains(&"later".into()))
    );
    check_invariants(&records, &standard_specs_sorted());
}

#[tokio::test]
async fn a_queued_message_sent_now_joins_the_running_turn_once() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let world = gated_world(gate.clone());
    world
        .provider
        .push(Script::tool_calls(&[("run", json!({ "command": "test" }))]))
        // Acknowledges in the same reply as its next call.
        .push(Script::text_and_tool_calls(
            "Noted, checking the docs too.",
            &[("read", json!({ "path": "docs.md" }))],
        ))
        .push(Script::text("all done"));
    let session = create(&world).await;
    let first = session.send(text("task"), Delivery::Turn).await.unwrap();
    tool_running(&world).await;
    let queued = session
        .send(text("and check the docs"), Delivery::Turn)
        .await
        .unwrap();
    let promoted = session.promote(queued.turn.clone()).await.unwrap();
    assert_eq!(
        (promoted.turn.clone(), promoted.started),
        (first.turn.clone(), true)
    );
    gate.notify_one();
    session.wait_idle().await;
    let records = session.records().await;
    assert_eq!(ended(&records, &queued.turn), Some(TurnOutcome::Withdrawn));
    assert_eq!(ended(&records, &first.turn), Some(TurnOutcome::Completed));
    let requests = world.provider.request_messages();
    assert_eq!(requests.len(), 3, "no turn of its own");
    assert_eq!(user_texts(&requests[1]), ["task", "and check the docs"]);
    let sightings = requests
        .iter()
        .map(|r| {
            user_texts(r)
                .iter()
                .filter(|t| *t == "and check the docs")
                .count()
        })
        .collect::<Vec<_>>();
    assert_eq!(sightings, [0, 1, 1], "read once, then kept in the history");
    assert_eq!(continued(&records), 0, "it answered with a call");
    check_invariants(&records, &standard_specs_sorted());
}

#[tokio::test]
async fn an_acknowledgement_of_a_steer_mid_work_does_not_end_the_turn() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let world = gated_world(gate.clone());
    world
        .provider
        .push(Script::tool_calls(&[("run", json!({ "command": "test" }))]))
        .push(Script::text("Got it, I will check the docs too."))
        .push(Script::tool_calls(&[(
            "read",
            json!({ "path": "docs.md" }),
        )]))
        .push(Script::text("Done, docs checked."));
    let session = create(&world).await;
    let first = session.send(text("task"), Delivery::Turn).await.unwrap();
    tool_running(&world).await;
    session
        .send(text("and check the docs"), Delivery::Steer)
        .await
        .unwrap();
    gate.notify_one();
    session.wait_idle().await;
    let records = session.records().await;
    assert_eq!(ended(&records, &first.turn), Some(TurnOutcome::Completed));
    assert_eq!(continued(&records), 1);
    let requests = world.provider.request_messages();
    assert_eq!(requests.len(), 4);
    assert_eq!(
        user_texts(&requests[2]).last().map(String::as_str),
        Some(
            "Carry on with the work you were doing, taking that message into account. If nothing is left to do, say so in one sentence."
        )
    );
    check_invariants(&records, &standard_specs_sorted());
}

#[tokio::test]
async fn a_second_text_only_reply_after_the_nudge_ends_the_turn() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let world = gated_world(gate.clone());
    world
        .provider
        .push(Script::tool_calls(&[("run", json!({ "command": "test" }))]))
        .push(Script::text("Understood, stopping there."))
        .push(Script::text("Nothing is left to do."));
    let session = create(&world).await;
    let first = session.send(text("task"), Delivery::Turn).await.unwrap();
    tool_running(&world).await;
    session
        .send(text("that is enough"), Delivery::Steer)
        .await
        .unwrap();
    gate.notify_one();
    session.wait_idle().await;
    let records = session.records().await;
    assert_eq!(ended(&records, &first.turn), Some(TurnOutcome::Completed));
    assert_eq!(continued(&records), 1, "asked to carry on once per message");
    assert_eq!(world.provider.request_messages().len(), 3);
}

#[tokio::test]
async fn a_steer_before_any_work_is_answered_as_usual() {
    let world = World::new(ScriptedProvider::new());
    world.provider.push(Script::text("hello"));
    let session = create(&world).await;
    // Delivered with the opening message: no work was under way.
    session.send(text("task"), Delivery::Turn).await.unwrap();
    session.send(text("more"), Delivery::Steer).await.unwrap();
    session.wait_idle().await;
    let records = session.records().await;
    assert_eq!(continued(&records), 0);
    assert_eq!(world.provider.request_messages().len(), 1);
}

#[tokio::test]
async fn under_a_contract_an_acknowledgement_is_not_a_correction() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let world = gated_world(gate.clone());
    world
        .provider
        .push(Script::tool_calls(&[("run", json!({ "command": "test" }))]))
        .push(Script::text("Noted."))
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
    let first = session
        .send(text("Build it"), Delivery::Turn)
        .await
        .unwrap();
    tool_running(&world).await;
    session
        .send(text("use the fast path"), Delivery::Steer)
        .await
        .unwrap();
    gate.notify_one();
    session.wait_idle().await;
    let records = session.records().await;
    assert_eq!(ended(&records, &first.turn), Some(TurnOutcome::Completed));
    assert_eq!(continued(&records), 1);
    let corrections = records
        .iter()
        .filter(|r| matches!(r.body, RecordBody::ContractCorrection { .. }))
        .count();
    assert_eq!(
        corrections, 0,
        "the acknowledgement is not counted against the contract"
    );
}

/// A turn mid-tool with a message queued behind it, then a quit (close)
/// and a reopen: the running turn is stopped, the queued message waits.
async fn quit_with_a_queued_message() -> (World, blame_engine_protocol::TurnId, Session) {
    let gate = Arc::new(tokio::sync::Notify::new());
    let world = gated_world(gate);
    world
        .provider
        .push(Script::tool_calls(&[("run", json!({ "command": "test" }))]));
    let session = create(&world).await;
    let first = session.send(text("first"), Delivery::Turn).await.unwrap();
    tool_running(&world).await;
    let queued = session.send(text("later"), Delivery::Turn).await.unwrap();
    session.close().await.unwrap();
    drop(session);
    let session = open(&world, RecoveryPolicy::Stop).await;
    let records = session.records().await;
    assert_eq!(ended(&records, &first.turn), Some(TurnOutcome::Interrupted));
    assert_eq!(ended(&records, &queued.turn), None, "still queued");
    (world, queued.turn, session)
}

#[tokio::test]
async fn a_queued_message_waits_through_a_quit_and_runs_once_when_the_conversation_goes_on() {
    let (world, queued, session) = quit_with_a_queued_message().await;
    assert!(
        session.is_idle(),
        "nothing starts on its own after a reopen"
    );
    assert_eq!(world.provider.request_messages().len(), 1);
    // A stop with nothing running leaves it queued.
    session.interrupt().await.unwrap();
    assert_eq!(ended(&session.records().await, &queued), None);
    world
        .provider
        .push(Script::text("did later"))
        .push(Script::text("did new"));
    let new = session.send(text("new"), Delivery::Steer).await.unwrap();
    assert!(!new.started, "it waits behind the queued message");
    session.wait_idle().await;
    let records = session.records().await;
    assert_eq!(ended(&records, &queued), Some(TurnOutcome::Completed));
    assert_eq!(ended(&records, &new.turn), Some(TurnOutcome::Completed));
    let requests = world.provider.request_messages();
    assert_eq!(requests.len(), 3);
    let sightings = |needle: &str| {
        requests
            .iter()
            .filter(|r| user_texts(r).last().map(String::as_str) == Some(needle))
            .count()
    };
    assert_eq!((sightings("later"), sightings("new")), (1, 1));
    check_invariants(&records, &standard_specs_sorted());
}

#[tokio::test]
async fn a_message_that_waited_through_a_quit_can_be_sent_now_or_taken_back() {
    let (world, queued, session) = quit_with_a_queued_message().await;
    world.provider.push(Script::text("did later"));
    let accepted = session.promote(queued.clone()).await.unwrap();
    assert_eq!(
        (accepted.turn.clone(), accepted.started),
        (queued.clone(), true)
    );
    session.wait_idle().await;
    assert_eq!(
        ended(&session.records().await, &queued),
        Some(TurnOutcome::Completed)
    );
    assert_eq!(world.provider.request_messages().len(), 2);

    let (world, queued, session) = quit_with_a_queued_message().await;
    session.withdraw(queued.clone()).await.unwrap();
    assert_eq!(
        ended(&session.records().await, &queued),
        Some(TurnOutcome::Withdrawn)
    );
    assert!(session.is_idle());
    assert_eq!(world.provider.request_messages().len(), 1);
}

fn standard_specs_sorted() -> Vec<blame_engine_protocol::ToolSpec> {
    sorted_specs()
}
