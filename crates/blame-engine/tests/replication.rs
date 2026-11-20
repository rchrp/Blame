//! Logs copied to Blame's database through the client, and a session opened
//! on an engine that has never seen it.

mod common;

use blame_engine_protocol::RecordBody;
use blame_engine_protocol::rpc::{ClientRequest, SessionOpened};
use common::*;
use std::sync::Arc;
use std::time::Duration;

async fn wait_replicated(
    remote: &FakeRemote,
    session: &blame_engine_protocol::SessionId,
    head: u64,
) {
    for _ in 0..200 {
        if remote.head(session) >= head {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("the remote has {} of {head} records", remote.head(session));
}

#[tokio::test]
async fn a_session_replicated_through_the_client_opens_on_an_empty_engine() {
    let mock = mock(vec![
        text_reply(&["First answer."]),
        text_reply(&["Second answer."]),
    ])
    .await;
    let remote = Arc::new(FakeRemote::default());
    let client = Arc::new(FakeClient::new(&mock.base).with_remote(remote.clone()));
    let workspace = temp_dir("replication-workspace");

    let first = Engine::ready(&temp_dir("replication-a"), &[], client.clone()).await;
    let session = first.create(config(&workspace)).await;
    first.subscribe(&session, 0).await;
    first.send(&session, "first question").await;
    first.until_turn_ended().await;
    let local = first.records(&session).await;
    // Copied in the background as the turn runs.
    wait_replicated(&remote, &session, local.len() as u64).await;
    assert_eq!(remote.logs.lock().unwrap()[&session], local);
    assert!(first.shutdown().await.success());

    // Another machine: nothing on its disk.
    let second = Engine::ready(&temp_dir("replication-b"), &[], client.clone()).await;
    let opened: SessionOpened = second
        .call(ClientRequest::Open {
            session: session.clone(),
        })
        .await;
    assert_eq!(opened.head, local.len() as u64);
    assert_eq!(second.records(&session).await, local, "hydrated as it was");

    second.subscribe(&session, opened.head).await;
    second.send(&session, "second question").await;
    let records = records_of(&second.until_turn_ended().await);
    assert_eq!(kinds(&records), ["user", "request", "reply", "ended"]);
    let sent = sent_messages(&mock);
    let history = sent[1].to_string();
    assert!(
        history.contains("first question") && history.contains("First answer."),
        "the conversation continues: {history}"
    );
    // And the continuation is copied back too, before the engine exits.
    let head = opened.head + records.len() as u64;
    assert!(second.shutdown().await.success());
    assert_eq!(remote.head(&session), head);
    let copied = remote.logs.lock().unwrap()[&session].clone();
    assert!(matches!(
        copied.last().map(|r| &r.body),
        Some(RecordBody::TurnEnded { .. })
    ));
}

#[tokio::test]
async fn an_unknown_session_is_unknown_on_both_sides() {
    let remote = Arc::new(FakeRemote::default());
    let client = Arc::new(FakeClient::new("http://127.0.0.1:9").with_remote(remote));
    let engine = Engine::ready(&temp_dir("replication-unknown"), &[], client).await;
    let error = engine
        .request::<serde_json::Value>(ClientRequest::Open {
            session: "ses-nowhere".into(),
        })
        .await
        .expect_err("unknown");
    assert!(error.message.contains("does not exist"), "{error:?}");
    assert!(engine.shutdown().await.success());
}
