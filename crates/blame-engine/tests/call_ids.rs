//! A provider gets back the call ids its own model wrote, not the engine's:
//! the request for turn N+1 carries the ids of turn N's reply, in the
//! assistant's tool calls and in the results that answer them. A server that
//! keeps the conversation (the Claude Code bridge) depends on it to continue
//! instead of starting over.
//!
//! With `BLAME_CAPTURE_ENGINE_REQUESTS=<file>`, the bodies the mock received
//! are written there: the Claude Code bridge's tests replay them
//! (`packages/agent-runtime/src/claude-code/fixtures/engine-requests.json`).

mod common;

use blame_engine_protocol::rpc::ClientRequest;
use blame_engine_protocol::{AssistantBlock, Delivery, RecordBody, UserBlock};
use common::*;
use serde_json::{Value, json};
use std::sync::Arc;

fn ids(message: &Value, kind: &str, field: &str) -> Vec<String> {
    message["content"]
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter(|block| block["type"] == kind)
                .filter_map(|block| block[field].as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::test]
async fn each_request_carries_the_call_ids_the_model_wrote() {
    let mock = mock(vec![
        // Two calls at once, then one, then the answer; then a second turn.
        tool_reply_as(
            "toolu_01A",
            &[
                ("preview", json!({"path": "/"})),
                ("preview", json!({"path": "/about"})),
            ],
        ),
        tool_reply_as("toolu_01B", &[("preview", json!({"path": "/contact"}))]),
        text_reply(&["All three pages render."]),
        text_reply(&["You're welcome."]),
    ])
    .await;
    let mut client = FakeClient::new(&mock.base);
    let hold = Arc::new(tokio::sync::Notify::new());
    client.hold_tools = Some(hold.clone());
    let client = Arc::new(client);
    let engine = Engine::ready(&temp_dir("call-ids"), &[], client.clone()).await;
    let session = engine.create(config(&temp_dir("call-ids-workspace"))).await;
    engine.subscribe(&session, 0).await;
    engine.send(&session, "check the pages").await;
    // While the first two calls run, the person adds a message: it joins the
    // results of the next request.
    let mut seen = engine
        .until_record(|r| matches!(r.body, RecordBody::ToolCallStarted { .. }))
        .await;
    let _: Value = engine
        .call(ClientRequest::Send {
            session: session.clone(),
            input: vec![UserBlock::Text {
                text: "also the contact page".into(),
            }],
            delivery: Delivery::Steer,
        })
        .await;
    for _ in 0..3 {
        hold.notify_one();
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let release = {
        let hold = hold.clone();
        tokio::spawn(async move {
            loop {
                hold.notify_one();
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        })
    };
    seen.extend(engine.until_turn_ended().await);
    engine.send(&session, "thanks").await;
    seen.extend(engine.until_turn_ended().await);
    release.abort();

    // The engine names the calls its own way in the log.
    let records = records_of(&seen);
    let stored: Vec<String> = records
        .iter()
        .filter_map(|record| match &record.body {
            RecordBody::AssistantMessage { blocks, .. } => Some(blocks.clone()),
            _ => None,
        })
        .flatten()
        .filter_map(|block| match block {
            AssistantBlock::ToolCall { call, .. } => Some(call.as_str().to_owned()),
            _ => None,
        })
        .collect();
    assert_eq!(stored.len(), 3);
    assert!(
        stored.iter().all(|call| call.starts_with("call-")),
        "{stored:?}"
    );

    let bodies: Vec<Value> = mock.requests().into_iter().map(|r| r.body).collect();
    assert_eq!(bodies.len(), 4, "{bodies:#?}");
    if let Ok(path) = std::env::var("BLAME_CAPTURE_ENGINE_REQUESTS") {
        std::fs::write(&path, serde_json::to_string_pretty(&bodies).unwrap()).unwrap();
    }
    let first_calls = vec!["toolu_01A0".to_owned(), "toolu_01A1".to_owned()];
    for (request, from) in bodies.iter().enumerate().skip(1) {
        let messages = from["messages"].as_array().unwrap();
        // The reply to request 1, as every later request replays it.
        assert_eq!(
            ids(&messages[1], "tool_use", "id"),
            first_calls,
            "request {request}"
        );
        assert_eq!(
            ids(&messages[2], "tool_result", "tool_use_id"),
            first_calls,
            "request {request}"
        );
    }
    let second = bodies[1]["messages"].as_array().unwrap();
    assert!(
        second[2].to_string().contains("also the contact page"),
        "the steered message joins the results: {}",
        second[2]
    );
    let third = bodies[2]["messages"].as_array().unwrap();
    assert_eq!(ids(&third[3], "tool_use", "id"), ["toolu_01B0"]);
    assert_eq!(ids(&third[4], "tool_result", "tool_use_id"), ["toolu_01B0"]);
    assert_eq!(bodies[3]["messages"].as_array().unwrap().len(), 7);
    assert!(engine.shutdown().await.success());
}
