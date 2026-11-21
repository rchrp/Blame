//! The agent's plan: the `update_plan` tool the engine serves, the plan as a
//! projection of the log (through rewinds, forks and restarts), and the
//! refusal of a finish while a step is open.

mod common;

use blame_engine_core::plan::{self, CurrentPlan};
use blame_engine_core::projection::View;
use blame_engine_core::testing::{Script, ScriptedProvider, World, config};
use blame_engine_core::{EngineOptions, RecoveryPolicy, Session};
use blame_engine_protocol::{
    CompletionContract, PlanStep, Record, RecordBody, Refusal, ResultTool, SessionConfig,
    SessionId, StepStatus, ToolOutcome, ToolResultBlock, TurnOutcome,
};
use common::*;
use serde_json::{Value, json};

fn plan_config(max_corrections: u32) -> SessionConfig {
    SessionConfig {
        engine_tools: vec!["harness".into(), plan::TOOL_SET.into()],
        contract: Some(CompletionContract {
            result: ResultTool::Tool {
                name: "finish".into(),
            },
            required: Vec::new(),
            allowed: None,
            max_corrections,
        }),
        ..config()
    }
}

async fn start(world: &World, config: SessionConfig) -> Session {
    Session::create(world.ports(), EngineOptions::default(), sid(), config)
        .await
        .expect("creates")
}

/// An `update_plan` input from `(step, status)` pairs.
fn steps(list: &[(&str, &str)]) -> Value {
    json!({ "plan": list
        .iter()
        .map(|(step, status)| json!({ "step": step, "status": status }))
        .collect::<Vec<_>>() })
}

fn update(list: &[(&str, &str)]) -> Script {
    Script::tool_calls(&[(plan::TOOL, steps(list))])
}

fn finish() -> Script {
    Script::tool_calls(&[("finish", json!({}))])
}

/// What the loop offered the model: the tool host's, plus the plan tool.
fn offered_specs() -> Vec<blame_engine_protocol::ToolSpec> {
    let mut specs = plan::offered(
        &plan_config(2),
        blame_engine_core::testing::standard_specs(),
    );
    specs.sort_by(|a, b| a.name.cmp(&b.name));
    specs
}

fn plan_of(records: &[Record]) -> Option<CurrentPlan> {
    View::new(records).plan()
}

fn texts(plan: &CurrentPlan) -> Vec<(&str, StepStatus)> {
    plan.steps
        .iter()
        .map(|step| (step.step.as_str(), step.status))
        .collect()
}

/// What each call of `name` answered, in the order the answers were stored.
fn answers(records: &[Record], name: &str) -> Vec<(ToolOutcome, String)> {
    let calls: Vec<_> = View::new(records)
        .items()
        .iter()
        .filter_map(|item| item.record())
        .filter_map(|record| match &record.body {
            RecordBody::AssistantMessage { blocks, .. } => Some(blocks),
            _ => None,
        })
        .flatten()
        .filter_map(|block| match block {
            blame_engine_protocol::AssistantBlock::ToolCall { call, name: n, .. } if n == name => {
                Some(call.clone())
            }
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
            } if calls.contains(call) => Some((
                *outcome,
                content
                    .iter()
                    .map(|block| match block {
                        ToolResultBlock::Text { text } => text.as_str(),
                        ToolResultBlock::Image { .. } => "",
                    })
                    .collect::<String>(),
            )),
            _ => None,
        })
        .collect()
}

fn seq_of(records: &[Record], wanted: impl Fn(&RecordBody) -> bool) -> u64 {
    records
        .iter()
        .find(|record| wanted(&record.body))
        .expect("the record exists")
        .seq
}

#[tokio::test]
async fn the_plan_tool_is_offered_when_the_session_asks_for_it() {
    for (engine_tools, offered) in [
        (vec!["harness".to_owned(), plan::TOOL_SET.to_owned()], true),
        (vec!["harness".to_owned()], false),
    ] {
        let world = World::new(ScriptedProvider::new());
        world.provider.push(Script::text("Hello."));
        let session = start(
            &world,
            SessionConfig {
                engine_tools,
                contract: None,
                ..plan_config(2)
            },
        )
        .await;
        turn(&session, "Hi").await;
        let tools: Vec<String> = world.provider.requests()[0]
            .tools
            .iter()
            .map(|tool| tool.name.clone())
            .collect();
        assert_eq!(tools.contains(&plan::TOOL.to_owned()), offered, "{tools:?}");
    }
}

#[tokio::test]
async fn the_plan_is_the_latest_update_that_completed() {
    let world = World::new(ScriptedProvider::new());
    world
        .provider
        .push(update(&[("Add it", "in_progress"), ("Test it", "pending")]))
        // Two steps in progress: refused, so the plan stays as it was.
        .push(update(&[
            ("Add it", "in_progress"),
            ("Test it", "in_progress"),
        ]))
        .push(update(&[
            ("Add it", "completed"),
            ("Test it", "in_progress"),
        ]))
        .push(Script::text("Working."));
    let session = start(
        &world,
        SessionConfig {
            contract: None,
            ..plan_config(2)
        },
    )
    .await;
    turn(&session, "Build it").await;
    let records = session.records().await;
    let answered = answers(&records, plan::TOOL);
    assert_eq!(
        answered,
        [
            (
                ToolOutcome::Completed,
                "Plan updated: 0 of 2 done. In progress: Add it.".to_owned()
            ),
            (
                ToolOutcome::Failed,
                "Plan not updated:\n- only one step can be `in_progress`, and steps 1, 2 are: finish one or set the others back to `pending`\nFix this and call `update_plan` again with the whole plan.".to_owned()
            ),
            (
                ToolOutcome::Completed,
                "Plan updated: 1 of 2 done. In progress: Test it.".to_owned()
            ),
        ]
    );
    let plan = plan_of(&records).expect("a plan");
    assert_eq!(
        texts(&plan),
        [
            ("Add it", StepStatus::Completed),
            ("Test it", StepStatus::InProgress)
        ]
    );
    // The engine served it: the tool host never saw the calls.
    assert!(
        world
            .tools
            .log()
            .executions
            .iter()
            .all(|call| call.name != plan::TOOL)
    );
    check_invariants(&records, &offered_specs());
}

#[tokio::test]
async fn calls_of_one_reply_count_in_the_order_the_model_made_them() {
    let world = World::new(ScriptedProvider::new());
    world
        .provider
        .push(Script::tool_calls(&[
            (plan::TOOL, steps(&[("First", "pending")])),
            (plan::TOOL, steps(&[("Second", "pending")])),
        ]))
        .push(Script::text("Done."));
    let session = start(
        &world,
        SessionConfig {
            contract: None,
            ..plan_config(2)
        },
    )
    .await;
    turn(&session, "Plan twice").await;
    let plan = plan_of(&session.records().await).expect("a plan");
    assert_eq!(texts(&plan), [("Second", StepStatus::Pending)]);
}

#[tokio::test]
async fn a_finish_waits_for_the_plan_to_close() {
    let world = World::new(ScriptedProvider::new());
    world
        .provider
        .push(update(&[
            ("Add it", "completed"),
            ("Wire it", "in_progress"),
            ("Test it", "pending"),
        ]))
        .push(finish())
        .push(update(&[
            ("Add it", "completed"),
            ("Wire it", "completed"),
            ("Test it", "completed"),
        ]))
        .push(finish());
    let session = start(&world, plan_config(2)).await;
    turn(&session, "Build it").await;
    let records = session.records().await;
    let finishes = answers(&records, "finish");
    assert_eq!(finishes.len(), 2);
    assert_eq!(finishes[0].0, ToolOutcome::Failed);
    assert_eq!(
        finishes[0].1,
        "Not accepted: `finish` was refused: the plan still has open steps.\n\
- 2. Wire it (in progress)\n\
- 3. Test it (pending)\n\
Mark each one `completed`, or `abandoned` with a one-line reason, by calling `update_plan` with the whole plan. Then call `finish` again."
    );
    assert_eq!(finishes[1].0, ToolOutcome::Completed);
    // The refused finish is a typed record, and the tool never ran for it.
    let refusals: Vec<_> = records
        .iter()
        .filter_map(|record| match &record.body {
            RecordBody::ResultRejected { refusal, .. } => Some(refusal.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(
        refusals,
        [Some(Refusal::OpenPlan {
            steps: vec!["Wire it".into(), "Test it".into()]
        })]
    );
    let ran = world
        .tools
        .log()
        .executions
        .iter()
        .filter(|call| call.name == "finish")
        .count();
    assert_eq!(ran, 1, "only the accepted finish ran");
    check_invariants(&records, &offered_specs());
}

/// A chat has no contract: the tool that ends the turn is held back the
/// same way, and the model carries on, or stops in text, as it chooses.
#[tokio::test]
async fn without_a_contract_the_tool_that_ends_the_turn_waits_for_the_plan_too() {
    let world = World::new(ScriptedProvider::new());
    world
        .provider
        .push(update(&[("Add it", "in_progress")]))
        .push(finish())
        .push(update(&[("Add it", "completed")]))
        .push(finish());
    let session = start(
        &world,
        SessionConfig {
            contract: None,
            ..plan_config(2)
        },
    )
    .await;
    turn(&session, "Build it").await;
    let records = session.records().await;
    let finishes = answers(&records, "finish");
    assert_eq!(
        finishes
            .iter()
            .map(|(outcome, _)| *outcome)
            .collect::<Vec<_>>(),
        [ToolOutcome::Failed, ToolOutcome::Completed]
    );
    assert!(finishes[0].1.starts_with(
        "Not accepted: `finish` was refused: the plan still has open steps.\n- 1. Add it (in progress)"
    ));
    assert!(matches!(
        records.last().map(|record| &record.body),
        Some(RecordBody::TurnEnded {
            outcome: TurnOutcome::Completed,
            ..
        })
    ));
    // Not a contract: nothing was rejected as a result.
    assert!(
        records
            .iter()
            .all(|record| !matches!(record.body, RecordBody::ResultRejected { .. }))
    );
}

#[tokio::test]
async fn a_finish_goes_through_once_every_step_is_closed() {
    let world = World::new(ScriptedProvider::new());
    world
        .provider
        .push(update(&[("Add it", "in_progress"), ("Test it", "pending")]))
        .push(finish())
        .push(Script::tool_calls(&[(
            plan::TOOL,
            json!({ "plan": [
                { "step": "Add it", "status": "completed" },
                { "step": "Test it", "status": "abandoned", "reason": "The brief asks for no tests" },
            ] }),
        )]))
        .push(finish());
    let session = start(&world, plan_config(2)).await;
    turn(&session, "Build it").await;
    let records = session.records().await;
    assert!(matches!(
        records.last().map(|record| &record.body),
        Some(RecordBody::TurnEnded {
            outcome: TurnOutcome::Completed,
            ..
        })
    ));
    let plan = plan_of(&records).expect("a plan");
    assert_eq!(
        plan.steps[1].reason.as_deref(),
        Some("The brief asks for no tests")
    );
    check_invariants(&records, &offered_specs());
}

#[tokio::test]
async fn a_turn_that_never_closes_its_plan_ends_unmet_and_says_why() {
    let world = World::new(ScriptedProvider::new());
    world
        .provider
        .push(update(&[("Add it", "in_progress")]))
        .push(finish())
        .push(Script::text("It is done, really."))
        .push(finish())
        .push(Script::text("Still done."));
    let session = start(&world, plan_config(1)).await;
    turn(&session, "Build it").await;
    let records = session.records().await;
    let Some(RecordBody::TurnEnded {
        outcome: TurnOutcome::ContractUnmet { refused, .. },
        ..
    }) = records.last().map(|record| &record.body)
    else {
        panic!("the turn ended unmet: {:?}", kinds(&records));
    };
    assert_eq!(
        refused,
        &Some(Refusal::OpenPlan {
            steps: vec!["Add it".into()]
        })
    );
}

#[tokio::test]
async fn a_plan_left_open_by_one_turn_still_gates_the_next() {
    let world = World::new(ScriptedProvider::new());
    world
        .provider
        .push(update(&[("Add it", "in_progress")]))
        // No correction left: the first turn ends unmet, the plan stays open.
        .push(Script::text("Pausing."))
        .push(finish())
        .push(Script::tool_calls(&[(
            plan::TOOL,
            json!({ "plan": [
                { "step": "Add it", "status": "abandoned", "reason": "The person changed course" },
            ] }),
        )]))
        .push(finish());
    let session = start(&world, plan_config(0)).await;
    turn(&session, "Build it").await;
    let first = plan_of(&session.records().await).expect("a plan");
    turn(&session, "Actually, just explain it").await;
    let records = session.records().await;
    let finishes = answers(&records, "finish");
    assert_eq!(
        finishes
            .iter()
            .map(|(outcome, _)| *outcome)
            .collect::<Vec<_>>(),
        [ToolOutcome::Failed, ToolOutcome::Completed]
    );
    let plan = plan_of(&records).expect("a plan");
    assert_eq!(plan.steps[0].status, StepStatus::Abandoned);
    assert_ne!(plan.turn, first.turn, "the second turn set it");
}

#[tokio::test]
async fn a_rewind_takes_the_plan_back_with_the_turns_it_removes() {
    let world = World::new(ScriptedProvider::new());
    world
        .provider
        .push(update(&[("One", "in_progress"), ("Two", "pending")]))
        .push(Script::text("Turn one."))
        .push(update(&[("One", "completed"), ("Two", "in_progress")]))
        .push(Script::text("Turn two."));
    let session = start(
        &world,
        SessionConfig {
            contract: None,
            ..plan_config(2)
        },
    )
    .await;
    turn(&session, "First").await;
    let after_one = session.head().await;
    turn(&session, "Second").await;
    let full = session.records().await;
    let two = plan_of(&full).expect("a plan");
    assert_eq!(texts(&two)[0], ("One", StepStatus::Completed));

    // Back to the end of turn one: its plan.
    session.rewind(after_one, false).await.expect("rewinds");
    let records = session.records().await;
    let one = plan_of(&records).expect("the first plan");
    assert_eq!(texts(&one)[0], ("One", StepStatus::InProgress));
    assert!(one.seq < two.seq);

    // Undone: the second plan is back, byte for byte.
    session.undo_rewind().await.expect("undoes");
    assert_eq!(plan_of(&session.records().await), Some(two));

    // Back to before any plan: none.
    session.rewind(1, false).await.expect("rewinds");
    assert_eq!(plan_of(&session.records().await), None);
}

#[tokio::test]
async fn a_rewind_into_a_turn_drops_an_update_whose_answer_it_cut() {
    let world = World::new(ScriptedProvider::new());
    world
        .provider
        .push(update(&[("One", "in_progress")]))
        .push(Script::text("Done."));
    let session = start(
        &world,
        SessionConfig {
            contract: None,
            ..plan_config(2)
        },
    )
    .await;
    turn(&session, "First").await;
    let records = session.records().await;
    // Keep the reply that made the call, cut the answer: the model is told
    // the call did not complete, and the plan agrees.
    let reply = seq_of(&records, |body| {
        matches!(body, RecordBody::AssistantMessage { .. })
    });
    session.rewind(reply, false).await.expect("rewinds");
    assert_eq!(plan_of(&session.records().await), None);
}

#[tokio::test]
async fn a_fork_and_a_restart_keep_the_plan() {
    let world = World::new(ScriptedProvider::new());
    world
        .provider
        .push(update(&[("One", "in_progress")]))
        .push(Script::text("Turn one."))
        .push(update(&[("One", "completed")]))
        .push(Script::text("Turn two."));
    let session = start(
        &world,
        SessionConfig {
            contract: None,
            ..plan_config(2)
        },
    )
    .await;
    turn(&session, "First").await;
    let after_one = session.head().await;
    turn(&session, "Second").await;
    let live = plan_of(&session.records().await).expect("a plan");

    // A restart reads the same log: the same plan.
    let reopened = open(&world, RecoveryPolicy::default()).await;
    assert_eq!(plan_of(&reopened.records().await), Some(live));

    // A fork holds the plan as it was where it was cut.
    let fork = session
        .fork(after_one, "/elsewhere".into(), SessionId::from("fork"))
        .await
        .expect("forks");
    let forked = plan_of(&fork.records().await).expect("the forked plan");
    assert_eq!(texts(&forked), [("One", StepStatus::InProgress)]);
}

#[test]
fn a_plan_survives_the_wire() {
    let step = PlanStep {
        step: "Add it".into(),
        status: StepStatus::Abandoned,
        reason: Some("Not needed".into()),
    };
    let json = serde_json::to_value(&step).expect("serialises");
    assert_eq!(
        json,
        json!({ "step": "Add it", "status": "abandoned", "reason": "Not needed" })
    );
    assert_eq!(
        serde_json::from_value::<PlanStep>(json).expect("reads"),
        step
    );
}
