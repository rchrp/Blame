//! The engine killed or abandoned in the middle of a turn.

mod common;

use blame_engine_core::projection::{View, request_digest};
use blame_engine_protocol::rpc::{ClientRequest, EngineNotification, SessionOpened};
use blame_engine_protocol::{Delta, ErrorKind, Record, RecordBody, SessionActivity, TurnOutcome};
use common::*;
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Every stored digest is what the records before it give now: a restarted
/// engine rebuilt the same bytes.
fn assert_digests(records: &[Record]) {
    let mut checked = 0;
    for record in records {
        if let RecordBody::RequestStarted { prefix_digest, .. } = &record.body {
            let view = View::new(&records[..record.seq as usize - 1]);
            let config = view.config().expect("configured");
            let mut specs = config.client_tools.clone();
            specs.sort_by(|a, b| a.name.cmp(&b.name));
            let digest = request_digest(
                &config.model,
                &config.system_prompt,
                &specs,
                config.reasoning,
                &view.messages(),
            );
            assert_eq!(&digest, prefix_digest, "digest of request {}", record.seq);
            checked += 1;
        }
    }
    assert!(checked > 0);
}

fn without_cache_marks(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .filter(|(key, _)| key.as_str() != "cache_control")
                .map(|(key, value)| (key.clone(), without_cache_marks(value)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(without_cache_marks).collect()),
        other => other.clone(),
    }
}

async fn wait_for_streaming(engine: &Engine) {
    loop {
        if let EngineNotification::Delta {
            delta: Delta::Text { .. },
            ..
        } = engine.next_notification().await
        {
            return;
        }
    }
}

#[tokio::test]
async fn a_killed_engine_restarts_consistent_and_keeps_the_prefix() {
    let mock = mock(vec![
        tool_reply(&[("preview", json!({ "path": "/" }))]),
        stalled_reply(),
        text_reply(&["Continued."]),
    ])
    .await;
    let client = Arc::new(FakeClient::new(&mock.base));
    let data = temp_dir("kill");
    let workspace = temp_dir("kill-workspace");
    let first = Engine::ready(&data, &[], client.clone()).await;
    let session = first.create(config(&workspace)).await;
    first.subscribe(&session, 0).await;
    first.send(&session, "first").await;
    // The second request of the turn is streaming when the engine dies.
    first
        .until_record(|r| matches!(&r.body, RecordBody::ToolCallFinished { .. }))
        .await;
    wait_for_streaming(&first).await;
    first.kill().await;

    let second = Engine::ready(&data, &[], client.clone()).await;
    let opened: SessionOpened = second
        .call(ClientRequest::Open {
            session: session.clone(),
        })
        .await;
    assert_eq!(opened.activity, SessionActivity::Idle);
    let records = second.records(&session).await;
    assert_eq!(
        kinds(&records),
        [
            "created", "user", "request", "reply", "tool", "result", "request",
            // Recovery: the cut reply is a failed request, the turn ends.
            "failed", "ended", "notice"
        ]
    );
    for (index, record) in records.iter().enumerate() {
        assert_eq!(record.seq, index as u64 + 1);
    }
    assert!(matches!(
        &records[7].body,
        RecordBody::RequestFailed { error, .. } if error.kind == ErrorKind::Transport
    ));
    assert!(matches!(
        &records[8].body,
        RecordBody::TurnEnded {
            outcome: TurnOutcome::Interrupted,
            ..
        }
    ));

    second.subscribe(&session, opened.head).await;
    second.send(&session, "second").await;
    second.until_turn_ended().await;
    let records = second.records(&session).await;
    assert_digests(&records);

    // The request after the restart starts with the bytes of the one the
    // crash cut: the provider's cache still holds.
    let sent = sent_messages(&mock);
    assert_eq!(sent.len(), 3);
    let before = without_cache_marks(&sent[1]);
    let after = without_cache_marks(&sent[2]);
    let (before, after) = (before.as_array().unwrap(), after.as_array().unwrap());
    let shared = before.len() - 1;
    assert_eq!(before[..shared], after[..shared], "the same history");
    // The last message of the cut request (the tool result) is where the
    // new user text joins it, as one user turn.
    let cut_last = before[shared]["content"].as_array().unwrap();
    let new_last = after[shared]["content"].as_array().unwrap();
    assert_eq!(cut_last[..], new_last[..cut_last.len()]);
    assert!(after[shared].to_string().contains("second"));
    assert!(second.shutdown().await.success());
}

#[tokio::test]
async fn closing_stdin_mid_turn_ends_the_turn_and_exits() {
    let mock = mock(vec![stalled_reply()]).await;
    let client = Arc::new(FakeClient::new(&mock.base));
    let data = temp_dir("stdin");
    let engine = Engine::ready(&data, &[], client.clone()).await;
    let session = engine.create(config(&temp_dir("stdin-workspace"))).await;
    engine.subscribe(&session, 0).await;
    engine.send(&session, "hi").await;
    wait_for_streaming(&engine).await;

    let started = Instant::now();
    engine.close_stdin().await;
    let status = engine.wait_exit().await;
    assert!(status.success(), "{status:?}");
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "exits promptly: {:?}",
        started.elapsed()
    );

    // The engine that stopped wrote the end itself: no recovery was needed.
    let after = Engine::ready(&data, &[], client).await;
    let records = after.records(&session).await;
    assert_eq!(
        kinds(&records),
        ["created", "user", "request", "failed", "ended"]
    );
    assert!(matches!(
        &records[3].body,
        RecordBody::RequestFailed { error, .. } if error.kind == ErrorKind::Cancelled
    ));
    assert!(matches!(
        &records[4].body,
        RecordBody::TurnEnded {
            outcome: TurnOutcome::Interrupted,
            ..
        }
    ));
    assert!(after.shutdown().await.success());
}
