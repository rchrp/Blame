//! The engine is killed at every point of a scripted session, reopened, and
//! made to finish. Whatever the point, the log must stay consistent, no
//! write or command may run twice unless the host said it never ran, and
//! the result must be the one an uninterrupted run gives wherever recovery
//! can know it.
//!
//! The session: turn "one" reads two files side by side, has its next
//! request fail once (retried), writes a file, runs a command and answers;
//! turn "two" writes another file and answers; the session is rewound to
//! before "two" with its files; turn "three" answers.

mod common;

use blame_engine_core::ports::{InterruptedCall, ModelMessage, ModelRequest, ToolOutput};
use blame_engine_core::projection::View;
use blame_engine_core::testing::{
    Behavior, ManualClock, Script, ScriptedProvider, ScriptedTools, Workspace, World,
    standard_specs,
};
use blame_engine_core::{RecoveryPolicy, Session};
use blame_engine_protocol::{
    Delivery, ErrorKind, Record, RecordBody, ToolCallId, ToolEffect, ToolOutcome, TurnOutcome,
    UserBlock,
};
use common::*;
use serde_json::json;
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

/// Where the engine is killed in one run.
#[derive(Clone, Copy, Debug, Default)]
struct Faults {
    /// The power goes after this many store appends.
    power_cut: Option<u64>,
    /// The n-th request (from 1) stalls mid-reply and the engine is killed.
    stall_request: Option<usize>,
    /// The n-th tool call (from 1) hangs and the engine is killed.
    block_tool: Option<usize>,
}

#[derive(Default)]
struct Shared {
    retried: AtomicBool,
    requests: AtomicUsize,
    tool_calls: AtomicUsize,
    /// Set when a scripted fault fired: the test kills the engine.
    stuck: AtomicBool,
}

fn last_user_text(messages: &[ModelMessage]) -> (String, usize) {
    let index = messages
        .iter()
        .rposition(|m| matches!(m, ModelMessage::User(_)))
        .expect("a user message");
    let ModelMessage::User(blocks) = &messages[index] else {
        unreachable!()
    };
    let text = blocks
        .iter()
        .rev()
        .find_map(|b| match b {
            UserBlock::Text { text } => Some(text.clone()),
            _ => None,
        })
        .unwrap_or_default();
    let rounds = messages[index + 1..]
        .iter()
        .filter(|m| matches!(m, ModelMessage::ToolResults(_)))
        .count();
    (text, rounds)
}

fn respond(shared: &Shared, faults: Faults, request: &ModelRequest) -> Script {
    let number = shared.requests.fetch_add(1, Ordering::SeqCst) + 1;
    let (text, rounds) = last_user_text(&request.messages);
    let script = match (text.as_str(), rounds) {
        ("one", 0) => Script::tool_calls(&[
            ("read", json!({ "path": "a" })),
            ("read", json!({ "path": "b" })),
        ]),
        ("one", 1) if !shared.retried.swap(true, Ordering::SeqCst) => {
            Script::error(ErrorKind::Overloaded)
        }
        ("one", 1) => Script::tool_calls(&[("write", json!({ "path": "f", "text": "1" }))]),
        ("one", 2) => Script::tool_calls(&[("run", json!({ "command": "make" }))]),
        ("one", _) => Script::text("done one"),
        ("two", 0) => Script::tool_calls(&[("write", json!({ "path": "g", "text": "2" }))]),
        ("two", _) => Script::text("done two"),
        ("three", _) => Script::text("done three"),
        other => panic!("unexpected request {other:?}"),
    };
    if faults.stall_request == Some(number) {
        shared.stuck.store(true, Ordering::SeqCst);
        return script.stalling_after(2);
    }
    script
}

fn tools(shared: Arc<Shared>, faults: Faults) -> ScriptedTools {
    ScriptedTools::new(
        standard_specs(),
        move |invocation, workspace: &Workspace| {
            let number = shared.tool_calls.fetch_add(1, Ordering::SeqCst) + 1;
            if faults.block_tool == Some(number) {
                shared.stuck.store(true, Ordering::SeqCst);
                return Behavior::UntilCancelled;
            }
            let input = &invocation.input;
            let path = input["path"].as_str().unwrap_or_default().to_owned();
            let mut files = workspace.lock().unwrap();
            Behavior::Output(match invocation.name.as_str() {
                "read" => ToolOutput::text(
                    ToolOutcome::Completed,
                    files.get(&path).cloned().unwrap_or_default(),
                ),
                "write" => {
                    files.insert(path, input["text"].as_str().unwrap().to_owned());
                    ToolOutput::text(ToolOutcome::Completed, "written")
                }
                "run" => ToolOutput::text(ToolOutcome::Completed, "built"),
                other => panic!("unexpected tool {other}"),
            })
        },
    )
}

#[derive(Clone, Copy, Debug)]
enum Command {
    Send(&'static str),
    RewindBeforeTwo,
}

const COMMANDS: [Command; 4] = [
    Command::Send("one"),
    Command::Send("two"),
    Command::RewindBeforeTwo,
    Command::Send("three"),
];

fn user_seq(records: &[Record], message: &str) -> Option<u64> {
    records
        .iter()
        .find(
            |r| matches!(&r.body, RecordBody::UserMessage { input, .. } if *input == text(message)),
        )
        .map(|r| r.seq)
}

fn done(command: Command, records: &[Record]) -> bool {
    match command {
        Command::Send(message) => user_seq(records, message).is_some(),
        Command::RewindBeforeTwo => records
            .iter()
            .any(|r| matches!(r.body, RecordBody::RewindStarted { .. })),
    }
}

struct Run {
    records: Vec<Record>,
    files: BTreeMap<String, String>,
    world: World,
    lives: usize,
}

enum Settled {
    Idle,
    Killed,
}

/// Runs the other tasks until the session is idle or a fault fired. Time
/// moves only when nothing else can: the loop then advances the clock past
/// any backoff.
async fn settle(world: &World, shared: &Shared, session: &Session) -> Settled {
    for _ in 0..10_000 {
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
        if shared.stuck.swap(false, Ordering::SeqCst) || world.store.power_lost() {
            return Settled::Killed;
        }
        if session.is_idle() {
            return Settled::Idle;
        }
        if world.clock.sleepers() > 0 {
            world.clock.advance(Duration::from_secs(60));
        }
    }
    panic!("the session never settled");
}

async fn run(faults: Faults) -> Run {
    let shared = Arc::new(Shared::default());
    let respond_shared = shared.clone();
    let provider =
        ScriptedProvider::responding(move |request| respond(&respond_shared, faults, request));
    let mut world = World::new(provider).with_tools(tools(shared.clone(), faults));
    world.clock = ManualClock::manual();
    world.provider = world.provider.clone().with_clock(world.clock.clone());
    world
        .tools
        .workspace()
        .lock()
        .unwrap()
        .extend([("a".into(), "A".into()), ("b".into(), "B".into())]);
    if let Some(cut) = faults.power_cut {
        world.store.lose_power_after(cut);
    }

    let mut lives = 0;
    'lives: loop {
        lives += 1;
        assert!(lives <= 4, "too many restarts for {faults:?}");
        let session = if world.store.records(&sid()).is_empty() {
            Session::create(
                world.ports(),
                options(RecoveryPolicy::Continue),
                sid(),
                blame_engine_core::testing::config(),
            )
            .await
        } else {
            Session::open(world.ports(), options(RecoveryPolicy::Continue), sid()).await
        };
        let Ok(session) = session else {
            world.store.restore_power();
            continue;
        };
        if let Settled::Killed = settle(&world, &shared, &session).await {
            restart(&world, session).await;
            continue;
        }
        for command in COMMANDS {
            let records = world.store.records(&sid());
            if done(command, &records) {
                continue;
            }
            let result = match command {
                Command::Send(message) => {
                    session.send(text(message), Delivery::Turn).await.map(drop)
                }
                Command::RewindBeforeTwo => {
                    let to = user_seq(&records, "two").expect("turn two exists") - 1;
                    session.rewind(to, true).await.map(drop)
                }
            };
            let settled = settle(&world, &shared, &session).await;
            if result.is_err() || matches!(settled, Settled::Killed) {
                restart(&world, session).await;
                continue 'lives;
            }
        }
        break;
    }
    Run {
        records: world.store.records(&sid()),
        files: world.files(),
        world,
        lives,
    }
}

async fn restart(world: &World, session: Session) {
    session.crash().await;
    drop(session);
    // Let the aborted task be dropped before the engine comes back.
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
    world.store.restore_power();
}

/// Checks one run against the uninterrupted one.
fn check(run: &Run, baseline: &Run, faults: Faults) {
    let specs = sorted_specs();
    check_invariants(&run.records, &specs);

    let ends: Vec<&TurnOutcome> = run
        .records
        .iter()
        .filter_map(|r| match &r.body {
            RecordBody::TurnEnded { outcome, .. } => Some(outcome),
            _ => None,
        })
        .collect();
    assert_eq!(ends.len(), 3, "{faults:?}");
    assert!(
        ends.iter().all(|o| **o == TurnOutcome::Completed),
        "{faults:?}: {ends:?}"
    );

    let log = run.world.tools.log();
    let not_applied: Vec<&ToolCallId> = log
        .interrupted
        .iter()
        .filter(|(_, answer)| *answer == InterruptedCall::NotApplied)
        .map(|(call, _)| call)
        .collect();
    let mut runs: HashMap<&ToolCallId, usize> = HashMap::new();
    for execution in &log.executions {
        if standard_specs()
            .iter()
            .any(|s| s.name == execution.name && s.effect != ToolEffect::ReadOnly)
        {
            *runs.entry(&execution.call).or_default() += 1;
        }
    }
    for (call, count) in runs {
        assert!(
            count == 1 || not_applied.contains(&call),
            "{faults:?}: {call} ran {count} times"
        );
    }

    assert_eq!(run.files, baseline.files, "{faults:?}");

    let unknown = log
        .interrupted
        .iter()
        .any(|(_, answer)| *answer == InterruptedCall::Unknown);
    let messages = normalized(View::new(&run.records).messages());
    let expected = normalized(View::new(&baseline.records).messages());
    if unknown {
        // The model was told the command's outcome is unknown instead of
        // its output; everything else is the same.
        assert_eq!(messages.len(), expected.len(), "{faults:?}");
        let interrupted = messages.iter().any(|m| {
            matches!(m, ModelMessage::ToolResults(results)
                if results.iter().any(|r| r.outcome == ToolOutcome::Interrupted))
        });
        assert!(interrupted, "{faults:?}");
    } else {
        assert_eq!(messages, expected, "{faults:?}");
    }
}

#[tokio::test]
async fn the_uninterrupted_run_does_what_the_script_says() {
    let run = run(Faults::default()).await;
    assert_eq!(run.lives, 1);
    check_invariants(&run.records, &sorted_specs());
    assert_eq!(run.files.get("f").map(String::as_str), Some("1"));
    assert!(
        !run.files.contains_key("g"),
        "the rewind removed turn two's file"
    );
    let messages = View::new(&run.records).messages();
    assert_eq!(user_texts(&messages), ["one", "three"]);
    let failed = run
        .records
        .iter()
        .filter(|r| matches!(r.body, RecordBody::RequestFailed { .. }))
        .count();
    assert_eq!(failed, 1, "one retry");
    assert!(run.world.tools.log().max_running >= 1);
}

#[tokio::test]
async fn killing_the_engine_after_any_append_loses_nothing() {
    let baseline = run(Faults::default()).await;
    let appends = baseline.world.store.appends();
    assert!(appends > 20, "the scenario has {appends} appends");
    let mut answers: Vec<&str> = Vec::new();
    let mut rewinds_finished_by_recovery = 0;
    for cut in 0..appends {
        let faults = Faults {
            power_cut: Some(cut),
            ..Faults::default()
        };
        let run = run(faults).await;
        assert!(run.lives >= 2, "{faults:?} never cut");
        check(&run, &baseline, faults);
        for (_, answer) in run.world.tools.log().interrupted {
            answers.push(match answer {
                InterruptedCall::NotApplied => "not applied",
                InterruptedCall::Applied(_) => "applied",
                InterruptedCall::Unknown => "unknown",
            });
        }
        let restores = run
            .world
            .checkpointer
            .calls()
            .iter()
            .filter(|c| matches!(c, blame_engine_core::testing::CheckpointCall::Restore(_)))
            .count();
        if restores > 1 {
            rewinds_finished_by_recovery += 1;
        }
    }
    // Both ways recovery settles a call that ran were exercised.
    for answer in ["applied", "unknown"] {
        assert!(answers.contains(&answer), "never {answer}: {answers:?}");
    }
    assert!(
        rewinds_finished_by_recovery > 0,
        "a rewind was cut and finished on reopen"
    );
}

#[tokio::test]
async fn killing_the_engine_mid_stream_loses_nothing() {
    let baseline = run(Faults::default()).await;
    let requests = baseline.world.provider.requests().len();
    for stall in 1..=requests {
        let faults = Faults {
            stall_request: Some(stall),
            ..Faults::default()
        };
        let run = run(faults).await;
        assert_eq!(run.lives, 2, "{faults:?}");
        check(&run, &baseline, faults);
    }
}

#[tokio::test]
async fn killing_the_engine_mid_tool_loses_nothing() {
    let baseline = run(Faults::default()).await;
    let calls = baseline.world.tools.log().executions.len();
    assert_eq!(calls, 5);
    for block in 1..=calls {
        let faults = Faults {
            block_tool: Some(block),
            ..Faults::default()
        };
        let run = run(faults).await;
        assert_eq!(run.lives, 2, "{faults:?}");
        check(&run, &baseline, faults);
        // The hung call never took effect: the host says so, and it runs
        // again after the restart.
        let log = run.world.tools.log();
        let (call, answer) = log.interrupted.first().expect("asked about the call");
        assert_eq!(*answer, InterruptedCall::NotApplied, "{faults:?}");
        assert_eq!(
            log.executions.iter().filter(|e| e.call == *call).count(),
            2,
            "{faults:?}"
        );
    }
}

#[tokio::test]
async fn reopening_at_any_point_rebuilds_the_requests_already_sent() {
    let baseline = run(Faults::default()).await;
    // Every prefix of the log is a state a crash could leave: the digest of
    // each request sent so far is rebuilt from it.
    for end in 1..=baseline.records.len() {
        assert_digests(&baseline.records[..end], &sorted_specs());
    }
}
