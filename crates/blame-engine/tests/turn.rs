//! A full turn against the real binary: a mock model server, a client tool,
//! a streamed reply, and the records arriving in order.

mod common;

use blame_engine_protocol::rpc::{ClientRequest, SessionList};
use blame_engine_protocol::{AssistantBlock, Delta, RecordBody, ToolOutcome, TurnOutcome};
use blame_engine_providers::testing::Reply;
use common::*;
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::Ordering;

#[tokio::test]
async fn a_turn_runs_a_client_tool_and_streams_the_reply() {
    let mock = mock(vec![
        tool_reply(&[("preview", json!({ "path": "/" }))]),
        text_reply(&["All ", "good", "."]),
    ])
    .await;
    let client = Arc::new(FakeClient::new(&mock.base));
    let engine = Engine::ready(&temp_dir("turn"), &[], client.clone()).await;
    let workspace = temp_dir("turn-workspace");
    let session = engine.create(config(&workspace)).await;
    engine.subscribe(&session, 0).await;
    engine.send(&session, "check the app").await;
    let notifications = engine.until_turn_ended().await;

    let records = records_of(&notifications);
    assert_eq!(
        kinds(&records),
        [
            "created", "user", "request", "reply", "tool", "result", "request", "reply", "ended"
        ]
    );
    for (index, record) in records.iter().enumerate() {
        assert_eq!(record.seq, index as u64 + 1, "in order, none missing");
    }
    assert_eq!(
        engine.records(&session).await,
        records,
        "the same as stored"
    );
    let RecordBody::TurnEnded { outcome, .. } = &records.last().unwrap().body else {
        unreachable!()
    };
    assert_eq!(*outcome, TurnOutcome::Completed);

    // The client ran its tool, and the model got the result.
    assert_eq!(
        *client.tool_calls.lock().unwrap(),
        [("preview".to_owned(), json!({ "path": "/" }))]
    );
    let RecordBody::ToolCallFinished { outcome, .. } = &records[5].body else {
        panic!("a result: {:?}", records[5]);
    };
    assert_eq!(*outcome, ToolOutcome::Completed);
    let sent = sent_messages(&mock);
    assert_eq!(sent.len(), 2);
    assert!(
        sent[1].to_string().contains("preview ran with"),
        "the result reaches the model: {}",
        sent[1]
    );

    // The reply was streamed piece by piece, before its record.
    let reply_at = notifications
        .iter()
        .position(|n| {
            matches!(n, blame_engine_protocol::rpc::EngineNotification::Record { record, .. }
                if record.seq == 8)
        })
        .unwrap();
    let streamed: String = deltas_of(&notifications[..reply_at])
        .into_iter()
        .filter_map(|delta| match delta {
            Delta::Text { text, .. } => Some(text),
            _ => None,
        })
        .collect();
    assert_eq!(streamed, "All good.");
    let RecordBody::AssistantMessage { blocks, .. } = &records[7].body else {
        unreachable!()
    };
    assert!(matches!(&blocks[..], [AssistantBlock::Text { text, .. }] if text == "All good."));

    let list: SessionList = engine.call(ClientRequest::List {}).await;
    assert_eq!(list.sessions.len(), 1);
    assert_eq!(list.sessions[0].head, 9);
    assert_eq!(
        list.sessions[0].workspace_root,
        workspace.display().to_string()
    );
    assert!(engine.shutdown().await.success());
}

#[tokio::test]
async fn a_refused_credential_is_asked_for_again_once() {
    let mock = mock(vec![
        Reply::json(
            401,
            json!({"type": "error", "error": {"type": "authentication_error", "message": "invalid x-api-key"}}),
        ),
        text_reply(&["Hello."]),
        text_reply(&["Hello again."]),
    ])
    .await;
    let client = Arc::new(FakeClient::new(&mock.base));
    *client.keys.lock().unwrap() = vec!["sk-expired".into(), "sk-fresh".into()];
    let engine = Engine::ready(&temp_dir("auth"), &[], client.clone()).await;
    let session = engine.create(config(&temp_dir("auth-workspace"))).await;
    engine.subscribe(&session, 0).await;
    engine.send(&session, "hi").await;
    let records = records_of(&engine.until_turn_ended().await);
    assert_eq!(
        kinds(&records),
        ["created", "user", "request", "reply", "ended"],
        "the refusal never reached the log"
    );
    assert_eq!(client.credential_requests.load(Ordering::SeqCst), 2);
    let requests = mock.requests();
    assert_eq!(requests[0].header("x-api-key"), Some("sk-expired"));
    assert_eq!(requests[1].header("x-api-key"), Some("sk-fresh"));

    // The fresh key is kept in memory for the next turn.
    engine.send(&session, "again").await;
    let records = records_of(&engine.until_turn_ended().await);
    assert_eq!(kinds(&records), ["user", "request", "reply", "ended"]);
    assert_eq!(client.credential_requests.load(Ordering::SeqCst), 2);
    assert_eq!(mock.requests()[2].header("x-api-key"), Some("sk-fresh"));
    assert!(engine.shutdown().await.success());
}

#[tokio::test]
async fn protocol_faults_are_answered_and_requests_wait_for_initialize() {
    let client = Arc::new(FakeClient::new("http://127.0.0.1:9"));
    let engine = Engine::start(&temp_dir("protocol"), &[], client).await;
    let early = engine
        .request::<Value>(ClientRequest::List {})
        .await
        .expect_err("not initialized");
    assert_eq!(early.code, -32002);
    engine.initialize(false).await;
    let unknown = engine
        .request::<Value>(ClientRequest::Open {
            session: "ses-missing".into(),
        })
        .await
        .expect_err("unknown session");
    assert!(unknown.message.contains("does not exist"), "{unknown:?}");
    let again = engine
        .request::<Value>(ClientRequest::Initialize {
            protocol_version: 1,
            client_name: "t".into(),
            client_version: "0".into(),
            remote_log: false,
        })
        .await
        .expect_err("once");
    assert!(again.message.contains("already"));
    assert!(engine.shutdown().await.success());
}

#[test]
fn version_and_catalog_print_on_stdout() {
    let version = std::process::Command::new(binary())
        .arg("--version")
        .output()
        .unwrap();
    assert!(version.status.success());
    let text = String::from_utf8(version.stdout).unwrap();
    assert!(text.starts_with("blame-engine 0."), "{text}");

    let catalog = std::process::Command::new(binary())
        .arg("catalog")
        .output()
        .unwrap();
    assert!(catalog.status.success());
    let providers: Value = serde_json::from_slice(&catalog.stdout).expect("JSON");
    let ids: Vec<&str> = providers
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|p| p["id"].as_str())
        .collect();
    assert!(
        ids.contains(&"anthropic") && ids.contains(&"chatgpt"),
        "{ids:?}"
    );
}

#[tokio::test]
async fn approvals_go_to_the_client_and_an_interrupt_withdraws_its_request() {
    let mock = mock(vec![
        tool_reply(&[("deploy", json!({}))]),
        text_reply(&["Deployed."]),
        tool_reply(&[("preview", json!({ "path": "/slow" }))]),
    ])
    .await;
    let mut client = FakeClient::new(&mock.base);
    let hold = Arc::new(tokio::sync::Notify::new());
    client.hold_tools = Some(hold.clone());
    let client = Arc::new(client);
    let engine = Engine::ready(&temp_dir("approval"), &[], client.clone()).await;
    let mut config = config(&temp_dir("approval-workspace"));
    config.client_tools.push(blame_engine_protocol::ToolSpec {
        name: "deploy".into(),
        description: "Deploys.".into(),
        input_schema: json!({"type": "object"}),
        effect: blame_engine_protocol::ToolEffect::External,
        ends_turn: false,
        needs_approval: true,
    });
    let session = engine.create(config).await;
    engine.subscribe(&session, 0).await;
    engine.send(&session, "deploy it").await;
    let mut seen = engine
        .until_record(|r| matches!(r.body, RecordBody::ToolCallStarted { .. }))
        .await;
    hold.notify_one();
    seen.extend(engine.until_turn_ended().await);
    let records = records_of(&seen);
    assert_eq!(
        kinds(&records),
        [
            "created",
            "user",
            "request",
            "reply",
            "approval?",
            "approval",
            "tool",
            "result",
            "request",
            "reply",
            "ended"
        ],
        "{:?}",
        kinds(&records)
    );

    // A client tool still running when the user stops the turn: the engine
    // withdraws its request.
    engine.send(&session, "look at /slow").await;
    engine
        .until_record(|r| matches!(r.body, RecordBody::ToolCallStarted { .. }))
        .await;
    let _: Value = engine
        .call(ClientRequest::Interrupt {
            session: session.clone(),
        })
        .await;
    let records = records_of(&engine.until_turn_ended().await);
    assert!(matches!(
        &records[records.len() - 2].body,
        RecordBody::ToolCallFinished {
            outcome: ToolOutcome::Cancelled,
            ..
        }
    ));
    assert_eq!(client.cancelled.lock().unwrap().len(), 1, "one $/cancel");
    hold.notify_one();
    assert!(engine.shutdown().await.success());
}

#[tokio::test]
async fn sessions_run_side_by_side_and_idle_ones_leave_memory() {
    let mock = mock((0..4).map(|_| text_reply(&["Done."])).collect()).await;
    let client = Arc::new(FakeClient::new(&mock.base));
    let engine = Engine::ready(&temp_dir("many"), &["--idle-timeout", "1"], client).await;
    let mut sessions = Vec::new();
    for n in 0..3 {
        let session = engine
            .create(config(&temp_dir(&format!("many-workspace-{n}"))))
            .await;
        engine.subscribe(&session, 0).await;
        sessions.push(session);
    }
    for session in &sessions {
        engine.send(session, "go").await;
    }
    let mut ended = 0;
    while ended < 3 {
        if let blame_engine_protocol::rpc::EngineNotification::Record { record, .. } =
            engine.next_notification().await
            && matches!(
                record.body,
                RecordBody::TurnEnded {
                    outcome: TurnOutcome::Completed,
                    ..
                }
            )
        {
            ended += 1;
        }
    }
    for session in &sessions {
        let _: Value = engine
            .call(ClientRequest::Unsubscribe {
                session: session.clone(),
            })
            .await;
    }
    // Idle and unwatched for longer than --idle-timeout: dropped, then
    // opened again from the log when used.
    for _ in 0..100 {
        if sessions
            .iter()
            .all(|s| engine.logged(&format!("session {s} dropped from memory")))
        {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert!(engine.logged(&format!("session {} dropped from memory", sessions[0])));
    engine.subscribe(&sessions[0], 0).await;
    engine.send(&sessions[0], "again").await;
    let records = records_of(&engine.until_record(|r| r.seq == 9).await);
    assert!(matches!(
        &records.last().unwrap().body,
        RecordBody::TurnEnded {
            outcome: TurnOutcome::Completed,
            ..
        }
    ));
    assert!(engine.shutdown().await.success());
}
