//! Tasks on the real binary: `task/run` answered with the outcome, a
//! subscription from the first record, `$/cancel`, `session/delete`, what
//! is copied to Blame's database, retention, and a crash in the middle.

mod common;

use blame_engine_protocol::rpc::{ClientRequest, Records, SessionOpened};
use blame_engine_protocol::{
    CompletionContract, Delivery, ErrorKind, Obligation, RecordBody, ResultTool, SessionConfig,
    SessionId, SessionKind, TaskFailure, TaskOutcome, UserBlock,
};
use common::*;
use serde_json::{Value, json};
use std::path::Path;
use std::sync::Arc;

fn task(workspace: &Path, replicate: bool) -> SessionConfig {
    SessionConfig {
        purpose: "title".into(),
        kind: SessionKind::Task { replicate },
        contract: Some(CompletionContract {
            result: ResultTool::Submit {
                name: "submit_title".into(),
                description: "The title.".into(),
                input_schema: json!({
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["title"],
                    "properties": { "title": { "type": "string", "minLength": 1 } }
                }),
            },
            required: Vec::new(),
            allowed: None,
            max_corrections: 1,
        }),
        ..config(workspace)
    }
}

fn run(session: &str, config: SessionConfig) -> ClientRequest {
    ClientRequest::RunTask {
        session: Some(SessionId::from(session)),
        config,
        instruction: vec![UserBlock::Text {
            text: "Name this story: the login page loses the password.".into(),
        }],
    }
}

#[tokio::test]
async fn a_task_runs_to_its_validated_result_and_can_be_followed_from_the_start() {
    let mock = mock(vec![
        tool_reply(&[("submit_title", json!({ "title": "" }))]),
        tool_reply(&[("submit_title", json!({ "title": "Keep the password" }))]),
    ])
    .await;
    let client = Arc::new(FakeClient::new(&mock.base));
    let engine = Engine::ready(&temp_dir("task"), &[], client).await;
    let workspace = temp_dir("task-workspace");
    let (_, answer) = engine
        .send_request(run("t1", task(&workspace, false)))
        .await;
    // Sent right behind `task/run`: the session already exists.
    engine.subscribe(&SessionId::from("t1"), 0).await;
    let outcome: TaskOutcome = Engine::answer(answer).await.expect("an outcome");
    let TaskOutcome::Completed { result, .. } = outcome else {
        panic!("completed: {outcome:?}");
    };
    assert_eq!(result, json!({ "title": "Keep the password" }));
    let records = records_of(&engine.until_turn_ended().await);
    assert_eq!(
        kinds(&records),
        [
            "created", "user", "request", "reply", "result", "rejected", "request", "reply",
            "result", "accepted", "ended"
        ],
        "every step, from the first record"
    );
    let tools: Vec<String> = mock.requests()[0].body["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .map(|tool| tool["name"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(tools, ["preview", "submit_title"]);
    let error = engine
        .request::<Value>(ClientRequest::Send {
            session: SessionId::from("t1"),
            input: vec![UserBlock::Text {
                text: "more".into(),
            }],
            delivery: Delivery::Turn,
        })
        .await
        .expect_err("a task takes no message");
    assert_eq!(error.data.map(|d| d.kind), Some(ErrorKind::InvalidRequest));
}

#[tokio::test]
async fn a_task_that_never_answers_with_its_result_fails_as_unmet() {
    let mock = mock(vec![
        text_reply(&["Keep the password"]),
        text_reply(&["Keep it"]),
    ])
    .await;
    let client = Arc::new(FakeClient::new(&mock.base));
    let engine = Engine::ready(&temp_dir("task-unmet"), &[], client).await;
    let outcome: TaskOutcome = engine
        .call(run("t1", task(&temp_dir("task-unmet-workspace"), false)))
        .await;
    assert_eq!(
        outcome,
        TaskOutcome::Failed {
            failure: TaskFailure::ContractUnmet {
                unmet: vec![Obligation::Result {
                    tool: "submit_title".into()
                }]
            }
        }
    );
    assert_eq!(mock.requests().len(), 2, "one correction");
    // Anthropic cannot be forced while it thinks: the correction is a
    // message only.
    let choice = &mock.requests()[1].body["tool_choice"]["type"];
    assert!(choice != "tool" && choice != "any", "{choice}");
}

#[tokio::test]
async fn cancelling_the_request_interrupts_the_task() {
    let mock = mock(vec![tool_reply(&[("preview", json!({ "path": "/" }))])]).await;
    let mut client = FakeClient::new(&mock.base);
    let hold = Arc::new(tokio::sync::Notify::new());
    client.hold_tools = Some(hold.clone());
    let client = Arc::new(client);
    let engine = Engine::ready(&temp_dir("task-cancel"), &[], client.clone()).await;
    let (id, answer) = engine
        .send_request(run("t1", task(&temp_dir("task-cancel-workspace"), false)))
        .await;
    engine.subscribe(&SessionId::from("t1"), 0).await;
    engine
        .until_record(|r| matches!(r.body, RecordBody::ToolCallStarted { .. }))
        .await;
    engine.cancel(id).await;
    let outcome: TaskOutcome = Engine::answer(answer).await.expect("an outcome");
    assert_eq!(outcome, TaskOutcome::Interrupted);
    assert!(
        !client.cancelled.lock().unwrap().is_empty(),
        "the engine withdrew its own tool request"
    );
}

#[tokio::test]
async fn only_tasks_that_ask_are_copied_and_a_deleted_session_is_gone() {
    let mock = mock(vec![
        tool_reply(&[("submit_title", json!({ "title": "Local" }))]),
        tool_reply(&[("submit_title", json!({ "title": "Copied" }))]),
    ])
    .await;
    let remote = Arc::new(FakeRemote::default());
    let client = Arc::new(FakeClient::new(&mock.base).with_remote(remote.clone()));
    let engine = Engine::ready(&temp_dir("task-copy"), &[], client).await;
    let workspace = temp_dir("task-copy-workspace");
    let _: TaskOutcome = engine.call(run("local", task(&workspace, false))).await;
    let _: TaskOutcome = engine.call(run("copied", task(&workspace, true))).await;
    let chat = engine.create(config(&workspace)).await;
    let local = SessionId::from("local");
    let copied = SessionId::from("copied");
    let deadline = tokio::time::Instant::now() + WAIT;
    while remote.head(&copied) < 7 || remote.head(&chat) < 1 {
        assert!(tokio::time::Instant::now() < deadline, "replicated in time");
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert_eq!(remote.head(&local), 0, "a local task is never copied");

    let _: Value = engine
        .call(ClientRequest::Delete {
            session: local.clone(),
        })
        .await;
    let error = engine
        .request::<Records>(ClientRequest::Read {
            session: local,
            after: 0,
            limit: 10,
        })
        .await
        .expect_err("gone");
    assert_eq!(error.data.map(|d| d.kind), Some(ErrorKind::InvalidRequest));
    let _: Value = engine
        .call(ClientRequest::Delete {
            session: chat.clone(),
        })
        .await;
    assert_eq!(
        remote.head(&chat),
        1,
        "the database's copy is the client's to delete"
    );
}

#[tokio::test]
async fn kept_tasks_are_deleted_once_their_retention_has_passed() {
    let mock = mock(vec![tool_reply(&[(
        "submit_title",
        json!({ "title": "Old" }),
    )])])
    .await;
    let data = temp_dir("task-retention");
    let client = Arc::new(FakeClient::new(&mock.base));
    let engine = Engine::ready(&data, &["--task-retention", "1"], client.clone()).await;
    let _: TaskOutcome = engine
        .call(run(
            "old",
            task(&temp_dir("task-retention-workspace"), false),
        ))
        .await;
    engine.shutdown().await;
    tokio::time::sleep(std::time::Duration::from_millis(1_100)).await;
    let engine = Engine::ready(&data, &["--task-retention", "1"], client).await;
    let deadline = tokio::time::Instant::now() + WAIT;
    loop {
        let list: blame_engine_protocol::rpc::SessionList =
            engine.call(ClientRequest::List {}).await;
        if list.sessions.is_empty() {
            break;
        }
        assert!(tokio::time::Instant::now() < deadline, "deleted in time");
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn a_task_cut_by_a_crash_reopens_as_interrupted() {
    let mock = mock(vec![stalled_reply()]).await;
    let data = temp_dir("task-crash");
    let client = Arc::new(FakeClient::new(&mock.base));
    let engine = Engine::ready(&data, &[], client.clone()).await;
    let (_, _answer) = engine
        .send_request(run("t1", task(&temp_dir("task-crash-workspace"), false)))
        .await;
    engine.subscribe(&SessionId::from("t1"), 0).await;
    engine
        .until_record(|r| matches!(r.body, RecordBody::RequestStarted { .. }))
        .await;
    engine.kill().await;

    let engine = Engine::ready(&data, &[], client).await;
    let opened: SessionOpened = engine
        .call(ClientRequest::Open {
            session: SessionId::from("t1"),
        })
        .await;
    let records = engine.records(&opened.session).await;
    assert_eq!(
        kinds(&records),
        ["created", "user", "request", "failed", "ended", "notice"]
    );
    assert!(matches!(
        records[4].body,
        RecordBody::TurnEnded {
            outcome: blame_engine_protocol::TurnOutcome::Interrupted,
            ..
        }
    ));
}

// A task's session is created before the engine reads further (a follow
// sent right behind finds it), while the open it waits for may be pulling a
// session from Blame's database: the client's answer to that pull must
// still be read, or neither ends and the engine reads nothing ever again.
#[tokio::test]
async fn a_task_sent_while_an_open_waits_for_the_database_does_not_stall_the_engine() {
    let mock = mock(vec![tool_reply(&[(
        "submit_title",
        json!({ "title": "Keep the password" }),
    )])])
    .await;
    let hold = Arc::new(tokio::sync::Notify::new());
    let mut client = FakeClient::new(&mock.base).with_remote(Arc::new(FakeRemote::default()));
    client.hold_pulls = Some(hold.clone());
    let client = Arc::new(client);
    let engine = Engine::ready(&temp_dir("task-pull"), &[], client.clone()).await;
    let (_, opened) = engine
        .send_request(ClientRequest::Open {
            session: SessionId::from("elsewhere"),
        })
        .await;
    for _ in 0..200 {
        if client.pulls.load(std::sync::atomic::Ordering::SeqCst) > 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(
        client.pulls.load(std::sync::atomic::Ordering::SeqCst) > 0,
        "the open pulls"
    );
    let (_, ran) = engine
        .send_request(run("t1", task(&temp_dir("task-pull-workspace"), false)))
        .await;
    hold.notify_one();
    let unknown = Engine::answer::<SessionOpened>(opened)
        .await
        .expect_err("nobody has that session");
    assert!(unknown.message.contains("does not exist"), "{unknown:?}");
    let outcome: TaskOutcome = Engine::answer(ran).await.expect("an outcome");
    assert!(
        matches!(outcome, TaskOutcome::Completed { .. }),
        "{outcome:?}"
    );
}
