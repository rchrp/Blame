//! One behaviour of the loop per test, driven with fakes and a manual clock.

mod common;

use blame_engine_core::ports::Clock;
use blame_engine_core::ports::{ModelMessage, ProviderError};
use blame_engine_core::projection::{SUMMARY_PREAMBLE, View};
use blame_engine_core::testing::{
    Behavior, ManualClock, Script, ScriptedProvider, ScriptedTools, World, config, standard_specs,
};
use blame_engine_core::{ContextPolicy, RecoveryPolicy, Session, SessionEvent};
use blame_engine_protocol::{
    ApprovalDecision, ContextEdit, Delivery, Delta, ErrorKind, RecordBody, SessionActivity,
    SessionId, ToolOutcome, ToolSpec, TurnOutcome, Usage, WorkspaceRestore,
};
use common::*;
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;

fn fresh() -> World {
    World::new(ScriptedProvider::new())
}

fn outcome_of_last_turn(records: &[blame_engine_protocol::Record]) -> TurnOutcome {
    records
        .iter()
        .rev()
        .find_map(|r| match &r.body {
            RecordBody::TurnEnded { outcome, .. } => Some(outcome.clone()),
            _ => None,
        })
        .expect("a turn ended")
}

#[tokio::test]
async fn a_turn_is_stored_step_by_step() {
    let world = fresh();
    world.provider.push(Script::text("hello"));
    let session = create(&world).await;
    turn(&session, "hi").await;
    let records = session.records().await;
    assert_eq!(
        kinds(&records),
        ["created", "user", "checkpoint", "request", "reply", "ended"]
    );
    assert_eq!(outcome_of_last_turn(&records), TurnOutcome::Completed);
    assert_eq!(session.activity(), SessionActivity::Idle);
    assert_eq!(
        records,
        world.store.records(&sid()),
        "memory matches the store"
    );
    check_invariants(&records, &sorted_specs());
}

#[tokio::test]
async fn reads_run_side_by_side_and_writes_run_alone_in_order() {
    let world = fresh().with_tools(ScriptedTools::new(standard_specs(), |invocation, _| {
        Behavior::Slow(blame_engine_core::ports::ToolOutput::text(
            ToolOutcome::Completed,
            format!("{} ok", invocation.name),
        ))
    }));
    world
        .provider
        .push(Script::tool_calls(&[
            ("read", json!({ "path": "a" })),
            ("read", json!({ "path": "b" })),
            ("read", json!({ "path": "c" })),
            ("write", json!({ "path": "f", "text": "1" })),
            ("run", json!({ "command": "make" })),
            ("read", json!({ "path": "d" })),
        ]))
        .push(Script::text("done"));
    let session = create(&world).await;
    turn(&session, "go").await;
    let records = session.records().await;
    assert!(world.tools.log().max_running >= 2, "reads overlapped");
    let order: Vec<(&str, String)> = records
        .iter()
        .filter_map(|r| match &r.body {
            RecordBody::ToolCallStarted { name, .. } => Some(("start", name.clone())),
            RecordBody::ToolCallFinished { call, .. } => Some(("end", call.0.clone())),
            _ => None,
        })
        .collect();
    // The write starts only once every read before it ended, and ends before
    // the command starts.
    let position = |pair: (&str, &str)| {
        order
            .iter()
            .position(|(k, n)| *k == pair.0 && n == pair.1)
            .unwrap()
    };
    let write = position(("start", "write"));
    let run = position(("start", "run"));
    assert_eq!(
        order[..write].iter().filter(|(k, _)| *k == "end").count(),
        3
    );
    assert_eq!(order[write + 1].0, "end");
    assert!(run > write + 1);
    let messages = world.provider.request_messages();
    let ModelMessage::ToolResults(results) = &messages[1][2] else {
        panic!()
    };
    assert_eq!(results.len(), 6);
    check_invariants(&records, &sorted_specs());
}

#[tokio::test]
async fn failed_requests_are_retried_with_backoff_through_the_clock() {
    let world = fresh();
    let mut rate_limited = ProviderError::new(ErrorKind::RateLimited, "slow down");
    rate_limited.retry_after = Some(Duration::from_secs(7));
    world
        .provider
        .push(Script::error(ErrorKind::Overloaded))
        .push(Script::text("partial reply").failing_after(3, ErrorKind::Transport))
        .push(Script::Reject(rate_limited))
        .push(Script::text("finally"));
    let session = create(&world).await;
    turn(&session, "hi").await;
    let records = session.records().await;
    assert_eq!(
        kinds(&records),
        [
            "created",
            "user",
            "checkpoint",
            "request",
            "failed",
            "request",
            "failed",
            "request",
            "failed",
            "request",
            "reply",
            "ended"
        ]
    );
    let attempts: Vec<u32> = records
        .iter()
        .filter_map(|r| match &r.body {
            RecordBody::RequestStarted { attempt, .. } => Some(*attempt),
            _ => None,
        })
        .collect();
    assert_eq!(attempts, [1, 2, 3, 4]);
    assert_eq!(
        world.clock.sleeps(),
        [1, 2, 7].map(Duration::from_secs),
        "1s, 2s, then the 7s the provider asked for"
    );
    // The cut reply was never shown to the model.
    let last = world.provider.request_messages().pop().unwrap();
    assert_eq!(last.len(), 1);
}

#[tokio::test]
async fn retries_give_up_after_a_bounded_number_of_attempts() {
    let world = World::new(ScriptedProvider::responding(|_| {
        Script::error(ErrorKind::Overloaded)
    }));
    let session = create(&world).await;
    turn(&session, "hi").await;
    let records = session.records().await;
    let TurnOutcome::Failed { error } = outcome_of_last_turn(&records) else {
        panic!()
    };
    assert_eq!(error.kind, ErrorKind::Overloaded);
    assert_eq!(world.provider.requests().len(), 6);

    let world = world_with_one(Script::error(ErrorKind::Authentication));
    let session = create(&world).await;
    turn(&session, "hi").await;
    assert!(matches!(
        outcome_of_last_turn(&session.records().await),
        TurnOutcome::Failed { .. }
    ));
    assert_eq!(world.provider.requests().len(), 1, "never retried");
}

fn world_with_one(script: Script) -> World {
    let world = fresh();
    world.provider.push(script);
    world
}

#[tokio::test]
async fn a_silent_stream_is_abandoned_and_sent_again() {
    let world = fresh();
    world
        .provider
        .push(Script::text("never finished").stalling_after(2))
        .push(Script::text("ok"));
    let session = create(&world).await;
    let start = world.clock.now_ms();
    turn(&session, "hi").await;
    let records = session.records().await;
    let failure = records
        .iter()
        .find_map(|r| match &r.body {
            RecordBody::RequestFailed { error, .. } => Some(error.clone()),
            _ => None,
        })
        .unwrap();
    assert_eq!(failure.kind, ErrorKind::Stalled);
    assert!(
        world.clock.now_ms() - start >= 180_000,
        "waited the inactivity limit"
    );
    assert_eq!(outcome_of_last_turn(&records), TurnOutcome::Completed);
}

#[tokio::test]
async fn a_machine_that_slept_sends_the_request_again_at_once() {
    let world = fresh();
    world
        .provider
        .push(Script::text("never finished").stalling_after(1))
        .push(Script::text("ok"));
    world.clock.jump_on_next_sleep(Duration::from_secs(3600));
    let session = create(&world).await;
    turn(&session, "hi").await;
    let records = session.records().await;
    let failure = records
        .iter()
        .find_map(|r| match &r.body {
            RecordBody::RequestFailed { error, .. } => Some(error.clone()),
            _ => None,
        })
        .unwrap();
    assert_eq!(failure.kind, ErrorKind::Stalled);
    assert!(failure.message.contains("asleep"), "{}", failure.message);
    // One watchdog slice noticed it, then the 1s backoff.
    assert_eq!(
        world.clock.sleeps(),
        [Duration::from_secs(5), Duration::from_secs(1)]
    );
    assert_eq!(outcome_of_last_turn(&records), TurnOutcome::Completed);
}

#[tokio::test]
async fn limits_end_the_turn() {
    let world = World::new(ScriptedProvider::responding(|_| {
        Script::tool_calls(&[("read", json!({ "path": "a" }))])
    }));
    let mut limited = config();
    limited.limits.max_requests_per_turn = Some(3);
    let session = Session::create(world.ports(), Default::default(), sid(), limited)
        .await
        .unwrap();
    turn(&session, "loop forever").await;
    assert_eq!(
        outcome_of_last_turn(&session.records().await),
        TurnOutcome::LimitReached {
            limit: "max_requests_per_turn".into()
        }
    );
    assert_eq!(world.provider.requests().len(), 3);

    let world = World::new(ScriptedProvider::responding(|_| {
        Script::tool_calls(&[("read", json!({ "path": "a" }))]).with_usage(Usage {
            cost_micro_usd: Some(60),
            ..Usage::default()
        })
    }));
    let mut limited = config();
    limited.limits.max_cost_micro_usd = Some(100);
    let session = Session::create(world.ports(), Default::default(), sid(), limited)
        .await
        .unwrap();
    turn(&session, "spend").await;
    assert_eq!(
        outcome_of_last_turn(&session.records().await),
        TurnOutcome::LimitReached {
            limit: "max_cost_micro_usd".into()
        }
    );
    assert_eq!(world.provider.requests().len(), 2);
}

fn gated_world(gate: Arc<tokio::sync::Notify>) -> World {
    fresh().with_tools(ScriptedTools::new(
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

#[tokio::test]
async fn a_steer_reaches_the_model_at_its_next_request() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let world = gated_world(gate.clone());
    world
        .provider
        .push(Script::tool_calls(&[("run", json!({ "command": "test" }))]))
        .push(Script::text("ok, also that"));
    let session = create(&world).await;
    let first = session.send(text("task"), Delivery::Turn).await.unwrap();
    tool_running(&world).await;
    let steer = session
        .send(text("and check the docs"), Delivery::Steer)
        .await
        .unwrap();
    assert_eq!((steer.turn, steer.started), (first.turn, true));
    gate.notify_one();
    session.wait_idle().await;
    let requests = world.provider.request_messages();
    assert_eq!(requests.len(), 2);
    let second = &requests[1];
    assert!(matches!(second[2], ModelMessage::ToolResults(_)));
    assert_eq!(user_texts(&second[3..]), ["and check the docs"]);
    check_invariants(&session.records().await, &sorted_specs());
}

#[tokio::test]
async fn a_steer_after_the_last_reply_gets_one_more_request() {
    let world = fresh();
    world
        .provider
        .push(Script::text("done"))
        .push(Script::text("seen"));
    let session = create(&world).await;
    // Delivered before the driver runs: it is part of the first request.
    session.send(text("task"), Delivery::Turn).await.unwrap();
    session.send(text("more"), Delivery::Steer).await.unwrap();
    session.wait_idle().await;
    assert_eq!(world.provider.requests().len(), 1);
    assert_eq!(
        user_texts(&world.provider.request_messages()[0]),
        ["task", "more"]
    );
    // With no turn running, a steer opens one.
    let accepted = session.send(text("hello"), Delivery::Steer).await.unwrap();
    assert!(accepted.started);
    session.wait_idle().await;
    assert_eq!(world.provider.requests().len(), 2);
}

#[tokio::test]
async fn a_message_sent_during_a_turn_runs_as_the_next_turn() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let world = gated_world(gate.clone());
    world
        .provider
        .push(Script::tool_calls(&[("run", json!({ "command": "test" }))]))
        .push(Script::text("first done"))
        .push(Script::text("second done"));
    let session = create(&world).await;
    let first = session.send(text("first"), Delivery::Turn).await.unwrap();
    tool_running(&world).await;
    let second = session.send(text("second"), Delivery::Turn).await.unwrap();
    assert!(!second.started);
    assert_ne!(first.turn, second.turn);
    gate.notify_one();
    session.wait_idle().await;
    let records = session.records().await;
    let ended_first = records
        .iter()
        .position(|r| matches!(&r.body, RecordBody::TurnEnded { turn, .. } if *turn == first.turn))
        .unwrap();
    let second_request = records
        .iter()
        .position(
            |r| matches!(&r.body, RecordBody::RequestStarted { turn, .. } if *turn == second.turn),
        )
        .unwrap();
    assert!(ended_first < second_request);
    let requests = world.provider.request_messages();
    assert_eq!(requests.len(), 3);
    assert_eq!(
        user_texts(&requests[1]),
        ["first"],
        "not seen by the first turn"
    );
    assert_eq!(user_texts(&requests[2]), ["first", "second"]);
    check_invariants(&records, &sorted_specs());
}

#[tokio::test]
async fn an_interrupt_cancels_the_running_tool_and_ends_the_turn() {
    let world = fresh().with_tools(ScriptedTools::new(standard_specs(), |_, _| {
        Behavior::UntilCancelled
    }));
    world
        .provider
        .push(Script::tool_calls(&[
            ("run", json!({ "command": "sleep" })),
            ("write", json!({ "path": "f", "text": "x" })),
        ]))
        .push(Script::text("next turn"));
    let session = create(&world).await;
    session.send(text("first"), Delivery::Turn).await.unwrap();
    tool_running(&world).await;
    let queued = session.send(text("second"), Delivery::Turn).await.unwrap();
    session.interrupt().await.unwrap();
    session.wait_idle().await;
    let records = session.records().await;
    let outcomes: Vec<ToolOutcome> = records
        .iter()
        .filter_map(|r| match &r.body {
            RecordBody::ToolCallFinished { outcome, .. } => Some(*outcome),
            _ => None,
        })
        .collect();
    assert_eq!(outcomes, [ToolOutcome::Cancelled, ToolOutcome::Cancelled]);
    assert_eq!(world.tools.log().executions.len(), 1, "the write never ran");
    let ends: Vec<_> = records
        .iter()
        .filter_map(|r| match &r.body {
            RecordBody::TurnEnded { turn, outcome } => Some((turn.clone(), outcome.clone())),
            _ => None,
        })
        .collect();
    assert_eq!(ends[0].1, TurnOutcome::Interrupted);
    assert_eq!(
        ends[1],
        (queued.turn, TurnOutcome::Completed),
        "the queue still runs"
    );
    check_invariants(&records, &sorted_specs());
}

#[tokio::test]
async fn an_interrupt_stops_a_reply_mid_stream() {
    let mut world = fresh();
    world.clock = ManualClock::manual();
    world.provider = ScriptedProvider::new().with_clock(world.clock.clone());
    world
        .provider
        .push(Script::text("a long answer").stalling_after(2));
    let session = create(&world).await;
    let mut subscription = session.subscribe(0).await;
    session.send(text("hi"), Delivery::Turn).await.unwrap();
    let clock = world.clock.clone();
    until(move || clock.sleepers() > 0).await;
    // A late subscriber sees the reply so far.
    let late = session.subscribe(3).await;
    assert_eq!(late.activity, SessionActivity::Streaming);
    assert!(matches!(
        late.in_flight.as_slice(),
        [Delta::BlockStarted { .. }, Delta::Text { text, .. }] if text == "a long"
    ));
    session.interrupt().await.unwrap();
    session.wait_idle().await;
    let records = session.records().await;
    assert_eq!(
        kinds(&records),
        [
            "created",
            "user",
            "checkpoint",
            "request",
            "failed",
            "ended"
        ]
    );
    assert_eq!(outcome_of_last_turn(&records), TurnOutcome::Interrupted);
    // The first subscriber saw every record and the deltas in between.
    let mut seen = Vec::new();
    while let Ok(event) = subscription.events.try_recv() {
        seen.push(event);
    }
    let seen_records: Vec<_> = seen
        .iter()
        .filter_map(|e| match e {
            SessionEvent::Record(r) => Some(r.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(seen_records, records[1..]);
    assert!(
        seen.iter()
            .any(|e| matches!(e, SessionEvent::Delta(Delta::Text { .. })))
    );
}

#[tokio::test]
async fn calls_that_need_approval_wait_for_the_user() {
    let world = fresh();
    world
        .provider
        .push(Script::tool_calls(&[(
            "deploy",
            json!({ "target": "prod" }),
        )]))
        .push(Script::tool_calls(&[(
            "deploy",
            json!({ "target": "prod" }),
        )]))
        .push(Script::text("ok"));
    world.approver.push(Some(ApprovalDecision::Approved));
    world.approver.push(Some(ApprovalDecision::Denied));
    let session = create(&world).await;
    turn(&session, "deploy twice").await;
    let records = session.records().await;
    assert_eq!(
        kinds(&records)[3..],
        [
            "request",
            "reply",
            "approval?",
            "approval",
            "tool",
            "result",
            "request",
            "reply",
            "approval?",
            "approval",
            "result",
            "request",
            "reply",
            "ended"
        ]
    );
    let outcomes: Vec<ToolOutcome> = records
        .iter()
        .filter_map(|r| match &r.body {
            RecordBody::ToolCallFinished { outcome, .. } => Some(*outcome),
            _ => None,
        })
        .collect();
    assert_eq!(outcomes, [ToolOutcome::Completed, ToolOutcome::Denied]);
    assert_eq!(world.tools.log().executions.len(), 1);
    assert_eq!(world.approver.requests()[0].tool.name, "deploy");

    // An unanswered question is dropped by an interrupt.
    let world = world_with_one(Script::tool_calls(&[("deploy", json!({}))]));
    world.approver.push(None);
    let session = create(&world).await;
    session.send(text("deploy"), Delivery::Turn).await.unwrap();
    let probe = session.clone();
    until(move || probe.activity() == SessionActivity::AwaitingApproval).await;
    session.interrupt().await.unwrap();
    session.wait_idle().await;
    let records = session.records().await;
    assert_eq!(outcome_of_last_turn(&records), TurnOutcome::Interrupted);
    check_invariants(&records, &sorted_specs());
}

#[tokio::test]
async fn a_tool_that_ends_the_turn_ends_it() {
    let world = world_with_one(Script::tool_calls(&[("finish", json!({}))]));
    let session = create(&world).await;
    turn(&session, "do it").await;
    assert_eq!(world.provider.requests().len(), 1);
    assert_eq!(
        outcome_of_last_turn(&session.records().await),
        TurnOutcome::Completed
    );
}

fn big_usage() -> Usage {
    Usage {
        input_tokens: Some(900),
        output_tokens: Some(50),
        ..Usage::default()
    }
}

#[tokio::test]
async fn a_full_context_is_compacted_before_the_next_request() {
    let world = fresh();
    world
        .provider
        .push(Script::text("first answer").with_usage(big_usage()))
        .push(Script::text("the user said first"))
        .push(Script::text("second answer"));
    let mut small = config();
    small.limits.max_context_tokens = Some(1000);
    let session = Session::create(world.ports(), Default::default(), sid(), small)
        .await
        .unwrap();
    turn(&session, "first").await;
    turn(&session, "second").await;
    let records = session.records().await;
    let through = records
        .iter()
        .find_map(|r| match &r.body {
            RecordBody::ContextCompacted {
                through, summary, ..
            } => {
                assert_eq!(summary, "the user said first");
                Some(*through)
            }
            _ => None,
        })
        .expect("compacted");
    let requests = world.provider.request_messages();
    assert_eq!(requests.len(), 3);
    // The summary request is the history up to the cut, then the question.
    let summary_request = user_texts(&requests[1]);
    assert_eq!(summary_request[0], "first");
    assert!(summary_request.last().unwrap().starts_with("Summarise"));
    // The next request starts with the summary and keeps the tail verbatim.
    let after = &requests[2];
    assert!(user_texts(after)[0].starts_with(SUMMARY_PREAMBLE));
    assert!(user_texts(after)[0].ends_with("the user said first"));
    assert!(
        after
            .iter()
            .any(|m| matches!(m, ModelMessage::Assistant(_)))
    );
    assert_eq!(user_texts(after).last().unwrap(), "second");
    assert!(through < records.len() as u64);
    check_invariants(&records, &sorted_specs());
}

#[tokio::test]
async fn a_context_overflow_compacts_and_retries_once() {
    let world = fresh();
    world
        .provider
        .push(Script::text("first answer"))
        .push(Script::error(ErrorKind::ContextOverflow))
        .push(Script::text("summary"))
        .push(Script::text("fits now"));
    let session = create(&world).await;
    turn(&session, "first").await;
    turn(&session, "second").await;
    let records = session.records().await;
    assert_eq!(
        kinds(&records)[6..],
        [
            "user",
            "checkpoint",
            "request",
            "failed",
            "compacted",
            "request",
            "reply",
            "ended"
        ]
    );
    assert_eq!(outcome_of_last_turn(&records), TurnOutcome::Completed);

    // When it still does not fit, the turn fails.
    let world = fresh();
    world
        .provider
        .push(Script::text("first answer"))
        .push(Script::error(ErrorKind::ContextOverflow))
        .push(Script::text("summary"))
        .push(Script::error(ErrorKind::ContextOverflow));
    let session = create(&world).await;
    turn(&session, "first").await;
    turn(&session, "second").await;
    let TurnOutcome::Failed { error } = outcome_of_last_turn(&session.records().await) else {
        panic!()
    };
    assert_eq!(error.kind, ErrorKind::ContextOverflow);
    assert_eq!(world.provider.requests().len(), 4);
}

#[tokio::test]
async fn compaction_can_be_asked_for() {
    let world = fresh();
    world
        .provider
        .push(Script::text("one"))
        .push(Script::text("two"))
        .push(Script::text("summary of both"));
    let session = create(&world).await;
    turn(&session, "first").await;
    turn(&session, "second").await;
    session.compact().await.unwrap();
    let records = session.records().await;
    assert_eq!(kind(&records.last().unwrap().body), "compacted");
    let view = View::new(&records);
    let messages = view.messages();
    assert!(user_texts(&messages)[0].ends_with("summary of both"));
    assert_eq!(session.activity(), SessionActivity::Idle);
}

/// Turn one writes `f = 1`, turn two writes `f = 2` and runs a command.
async fn two_turns(world: &World) -> Session {
    world
        .provider
        .push(Script::tool_calls(&[(
            "write",
            json!({ "path": "f", "text": "1" }),
        )]))
        .push(Script::text("wrote one"))
        .push(Script::tool_calls(&[
            ("write", json!({ "path": "f", "text": "2" })),
            ("run", json!({ "command": "npm install" })),
        ]))
        .push(Script::text("wrote two"));
    let session = create(world).await;
    turn(&session, "one").await;
    turn(&session, "two").await;
    session
}

fn seq_of_user(records: &[blame_engine_protocol::Record], message: &str) -> u64 {
    records
        .iter()
        .find(
            |r| matches!(&r.body, RecordBody::UserMessage { input, .. } if *input == text(message)),
        )
        .unwrap()
        .seq
}

#[tokio::test]
async fn a_rewind_undoes_the_conversation_and_the_files_and_can_be_undone() {
    let world = fresh();
    let session = two_turns(&world).await;
    assert_eq!(world.files()["f"], "2");
    let records = session.records().await;
    let before_two = seq_of_user(&records, "two") - 1;

    let rewound = session.rewind(before_two, true).await.unwrap();
    let records = session.records().await;
    let RecordBody::RewindFinished {
        workspace,
        unreverted_commands,
        ..
    } = &records[rewound.finished as usize - 1].body
    else {
        panic!()
    };
    assert_eq!(*workspace, WorkspaceRestore::Restored);
    assert_eq!(unreverted_commands, &["npm install"]);
    assert_eq!(world.files()["f"], "1");
    assert_eq!(user_texts(&View::new(&records).messages()), ["one"]);

    session.undo_rewind().await.unwrap();
    assert_eq!(world.files()["f"], "2", "the files came back");
    let records = session.records().await;
    assert_eq!(user_texts(&View::new(&records).messages()), ["one", "two"]);
    assert!(matches!(
        session.undo_rewind().await,
        Err(blame_engine_core::EngineError::NothingToUndo)
    ));

    // The first turn too.
    session.rewind(1, true).await.unwrap();
    assert!(!world.files().contains_key("f"));
    assert!(View::new(&session.records().await).messages().is_empty());

    // And the session goes on from there.
    world.provider.push(Script::text("fresh start"));
    turn(&session, "again").await;
    let records = session.records().await;
    assert_eq!(user_texts(&View::new(&records).messages()), ["again"]);
    check_invariants(&records, &sorted_specs());
}

#[tokio::test]
async fn a_conversation_only_rewind_leaves_the_files() {
    let world = fresh();
    let session = two_turns(&world).await;
    let before_two = seq_of_user(&session.records().await, "two") - 1;
    let rewound = session.rewind(before_two, false).await.unwrap();
    let records = session.records().await;
    assert!(matches!(
        &records[rewound.finished as usize - 1].body,
        RecordBody::RewindFinished {
            workspace: WorkspaceRestore::NotRequested,
            ..
        }
    ));
    assert_eq!(world.files()["f"], "2");
}

#[tokio::test]
async fn a_rewind_during_a_turn_interrupts_it_first() {
    let world = fresh().with_tools(ScriptedTools::new(standard_specs(), |_, _| {
        Behavior::UntilCancelled
    }));
    world.provider.push(Script::tool_calls(&[(
        "run",
        json!({ "command": "serve" }),
    )]));
    let session = create(&world).await;
    session.send(text("start"), Delivery::Turn).await.unwrap();
    tool_running(&world).await;
    session.rewind(1, true).await.unwrap();
    let records = session.records().await;
    let kinds = kinds(&records);
    assert_eq!(
        kinds[3..],
        [
            "request", "reply", "tool", "result", "ended", "rewind", "rewound"
        ]
    );
    let RecordBody::RewindFinished {
        unreverted_commands,
        ..
    } = &records.last().unwrap().body
    else {
        panic!()
    };
    assert_eq!(unreverted_commands, &["serve"]);
    assert!(session.is_idle());
}

#[tokio::test]
async fn a_rewind_needs_a_checkpoint_to_restore_files() {
    let world = fresh();
    world.checkpointer.fail_snapshots(1);
    world
        .provider
        .push(Script::tool_calls(&[(
            "write",
            json!({ "path": "f", "text": "1" }),
        )]))
        .push(Script::text("done"));
    let session = create(&world).await;
    turn(&session, "one").await;
    let records = session.records().await;
    assert!(records.iter().any(|r| matches!(
        &r.body,
        RecordBody::Notice { code, .. } if code == blame_engine_core::NOTICE_CHECKPOINT_FAILED
    )));
    let rewound = session.rewind(1, true).await.unwrap();
    let records = session.records().await;
    assert!(matches!(
        &records[rewound.finished as usize - 1].body,
        RecordBody::RewindFinished {
            workspace: WorkspaceRestore::Failed { .. },
            ..
        }
    ));
    assert_eq!(world.files()["f"], "1", "nothing was restored");
}

#[tokio::test]
async fn a_fork_continues_from_a_point_in_another_workspace() {
    let world = fresh();
    let session = two_turns(&world).await;
    let records = session.records().await;
    let end_of_one = seq_of_user(&records, "two") - 1;
    let fork = session
        .fork(end_of_one, "/elsewhere".into(), SessionId::from("fork"))
        .await
        .unwrap();
    let forked = fork.records().await;
    assert_eq!(forked.len() as u64, end_of_one + 1, "the copy and a notice");
    assert!(forked.iter().all(|r| match &r.body {
        RecordBody::SessionCreated { config } | RecordBody::ConfigChanged { config } =>
            config.workspace_root == "/elsewhere",
        _ => true,
    }));
    world.provider.push(Script::text("forked answer"));
    turn(&fork, "other way").await;
    let messages = View::new(&fork.records().await).messages();
    assert_eq!(user_texts(&messages), ["one", "other way"]);
    // The source is untouched.
    assert_eq!(session.records().await, records);

    // A fork in the middle of a tool exchange ends it in the copy.
    let mid = records
        .iter()
        .find(|r| matches!(r.body, RecordBody::ToolCallStarted { .. }))
        .unwrap()
        .seq;
    let fork = session
        .fork(mid, "/third".into(), SessionId::from("fork2"))
        .await
        .unwrap();
    check_invariants(&fork.records().await, &sorted_specs());
    assert!(fork.is_idle());
}

#[tokio::test]
async fn an_idle_session_can_be_dropped_and_opened_again() {
    let world = fresh();
    let session = two_turns(&world).await;
    let records = session.records().await;
    drop(session);
    let session = open(&world, RecoveryPolicy::Stop).await;
    assert_eq!(session.records().await, records, "nothing to repair");
    world.provider.push(Script::text("three"));
    turn(&session, "three").await;
    let records = session.records().await;
    assert_eq!(
        user_texts(&View::new(&records).messages()),
        ["one", "two", "three"]
    );
    // Same history, same bytes: the first request after reopening extends
    // the previous one exactly.
    let requests = world.provider.request_messages();
    let last = requests.last().unwrap();
    let previous = &requests[requests.len() - 2];
    assert_eq!(&last[..previous.len()], &previous[..]);
    check_invariants(&records, &sorted_specs());
}

#[tokio::test]
async fn reopening_after_a_crash_mid_tool_ends_the_turn_by_default() {
    // A command killed while it hung never took effect: it is reported as
    // not run.
    let world = fresh().with_tools(ScriptedTools::new(standard_specs(), |_, _| {
        Behavior::UntilCancelled
    }));
    world.provider.push(Script::tool_calls(&[(
        "run",
        json!({ "command": "deploy.sh" }),
    )]));
    let session = create(&world).await;
    session.send(text("ship"), Delivery::Turn).await.unwrap();
    tool_running(&world).await;
    session.crash().await;
    drop(session);
    let session = open(&world, RecoveryPolicy::Stop).await;
    let records = session.records().await;
    assert_eq!(
        kinds(&records)[3..],
        ["request", "reply", "tool", "result", "ended", "notice"]
    );
    let RecordBody::ToolCallFinished { outcome, .. } = &records[6].body else {
        panic!()
    };
    assert_eq!(*outcome, ToolOutcome::Cancelled);
    assert_eq!(outcome_of_last_turn(&records), TurnOutcome::Interrupted);
    assert!(session.is_idle());
    check_invariants(&records, &sorted_specs());

    // A command that ran but whose result was never stored: nobody knows
    // what it did, and the model is told so.
    let world = fresh();
    world.provider.push(Script::tool_calls(&[(
        "run",
        json!({ "command": "deploy.sh" }),
    )]));
    let session = create(&world).await;
    // user, checkpoint, request, reply, tool started; then the power goes.
    world.store.lose_power_after(5);
    session.send(text("ship"), Delivery::Turn).await.unwrap();
    session.wait_idle().await;
    assert_eq!(world.tools.log().executions.len(), 1);
    drop(session);
    world.store.restore_power();
    let session = open(&world, RecoveryPolicy::Stop).await;
    let records = session.records().await;
    let RecordBody::ToolCallFinished { outcome, .. } = &records[6].body else {
        panic!("{:?}", kinds(&records))
    };
    assert_eq!(*outcome, ToolOutcome::Interrupted);
    assert_eq!(outcome_of_last_turn(&records), TurnOutcome::Interrupted);
    check_invariants(&records, &sorted_specs());
}

#[tokio::test]
async fn reopening_after_a_crash_mid_stream_can_continue_the_turn() {
    let mut world = fresh();
    world.clock = ManualClock::manual();
    world.provider = ScriptedProvider::new().with_clock(world.clock.clone());
    world
        .provider
        .push(Script::text("cut off").stalling_after(2))
        .push(Script::text("complete"));
    let session = create(&world).await;
    session.send(text("hi"), Delivery::Turn).await.unwrap();
    let clock = world.clock.clone();
    until(move || clock.sleepers() > 0).await;
    session.crash().await;
    drop(session);

    let session = open(&world, RecoveryPolicy::Continue).await;
    let probe = session.clone();
    // The retry waits its backoff on the manual clock.
    until(move || matches!(probe.activity(), SessionActivity::Retrying { in_ms: 1000 })).await;
    world.clock.advance(Duration::from_secs(1));
    session.wait_idle().await;
    let records = session.records().await;
    assert_eq!(
        kinds(&records)[3..],
        ["request", "failed", "notice", "request", "reply", "ended"]
    );
    assert_eq!(outcome_of_last_turn(&records), TurnOutcome::Completed);
    check_invariants(&records, &sorted_specs());
}

#[tokio::test]
async fn a_storage_failure_stops_the_session_until_it_is_opened_again() {
    let world = fresh();
    world
        .provider
        .push(Script::text("lost"))
        .push(Script::text("ok"));
    let session = create(&world).await;
    world.store.fail_next_appends(1);
    // The user message itself is refused.
    assert!(session.send(text("hi"), Delivery::Turn).await.is_err());
    assert!(matches!(
        session.send(text("hi"), Delivery::Turn).await,
        Err(blame_engine_core::EngineError::Broken(_))
    ));
    drop(session);
    let session = open(&world, RecoveryPolicy::Stop).await;
    turn(&session, "hi").await;
    assert_eq!(
        outcome_of_last_turn(&session.records().await),
        TurnOutcome::Completed
    );
}

struct ElideReads;

impl ContextPolicy for ElideReads {
    fn edits(&self, view: &View<'_>, _tools: &[ToolSpec]) -> Vec<ContextEdit> {
        let already = view.items().iter().any(|item| {
            matches!(
                item.record().map(|r| &r.body),
                Some(RecordBody::ContextEdited { .. })
            )
        });
        if already {
            return Vec::new();
        }
        view.items()
            .iter()
            .filter_map(|item| item.record())
            .filter(|r| matches!(r.body, RecordBody::ToolCallFinished { .. }))
            .map(|r| ContextEdit {
                target: r.seq,
                block: 0,
                replacement: "[elided]".into(),
            })
            .collect()
    }
}

#[tokio::test]
async fn context_edits_are_stored_before_the_request_that_uses_them() {
    let world = fresh();
    world
        .tools
        .workspace()
        .lock()
        .unwrap()
        .insert("a".into(), "contents".into());
    world
        .provider
        .push(Script::tool_calls(&[("read", json!({ "path": "a" }))]))
        .push(Script::text("ok"));
    let mut ports = world.ports();
    ports.context_policy = Arc::new(ElideReads);
    let session = Session::create(ports, Default::default(), sid(), config())
        .await
        .unwrap();
    turn(&session, "read a").await;
    let records = session.records().await;
    let edited = records
        .iter()
        .position(|r| matches!(r.body, RecordBody::ContextEdited { .. }))
        .unwrap();
    assert!(matches!(
        records[edited + 1].body,
        RecordBody::RequestStarted { .. }
    ));
    let requests = world.provider.request_messages();
    let ModelMessage::ToolResults(results) = &requests[1][2] else {
        panic!()
    };
    assert_eq!(
        results[0].content,
        [blame_engine_protocol::ToolResultBlock::Text {
            text: "[elided]".into()
        }]
    );
    check_invariants(&records, &sorted_specs());
}

#[tokio::test]
async fn a_configuration_change_applies_from_the_next_request() {
    let world = fresh();
    world
        .provider
        .push(Script::text("one"))
        .push(Script::text("two"));
    let session = create(&world).await;
    turn(&session, "first").await;
    let mut changed = config();
    changed.system_prompt = "Be brief.".into();
    session.configure(changed).await.unwrap();
    turn(&session, "second").await;
    let requests = world.provider.requests();
    assert_eq!(requests[0].system, "You are a test agent.");
    assert_eq!(requests[1].system, "Be brief.");
    check_invariants(&session.records().await, &sorted_specs());
}

#[tokio::test]
async fn a_closed_session_refuses_commands_and_keeps_its_records() {
    let world = fresh();
    world.provider.push(Script::text("one"));
    let session = create(&world).await;
    turn(&session, "first").await;
    session.close().await.unwrap();
    assert!(matches!(
        session.send(text("x"), Delivery::Turn).await,
        Err(blame_engine_core::EngineError::Closed)
    ));
    let reopened = open(&world, RecoveryPolicy::Stop).await;
    assert_eq!(reopened.records().await, session.records().await);
}
