//! What the desktop app needs from the engine beyond running turns: putting
//! the bytes of an attachment, reporting a client tool's progress, and a
//! credential asked per session where the provider needs one.

mod common;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use blame_engine_protocol::rpc::{ClientRequest, MessageAccepted};
use blame_engine_protocol::{BlobRef, Delivery, Delta, ModelRef, RecordBody, UserBlock};
use common::*;
use serde_json::{Value, json};
use std::sync::Arc;

#[tokio::test]
async fn a_put_blob_goes_to_the_model_with_the_message_that_uses_it() {
    let mock = mock(vec![text_reply(&["A red pixel."])]).await;
    let client = Arc::new(FakeClient::new(&mock.base));
    let engine = Engine::ready(&temp_dir("blob"), &[], client).await;
    let session = engine.create(config(&temp_dir("blob-workspace"))).await;
    engine.subscribe(&session, 0).await;

    let png = b"\x89PNG\r\n\x1a\nnot really a png";
    let blob: BlobRef = engine
        .call(ClientRequest::PutBlob {
            media_type: "image/png".into(),
            data: BASE64.encode(png),
        })
        .await;
    assert_eq!(blob.bytes, png.len() as u64);
    assert_eq!(blob.media_type, "image/png");
    let again: BlobRef = engine
        .call(ClientRequest::PutBlob {
            media_type: "image/png".into(),
            data: BASE64.encode(png),
        })
        .await;
    assert_eq!(again, blob, "stored once, by content");

    let _: MessageAccepted = engine
        .call(ClientRequest::Send {
            session: session.clone(),
            input: vec![
                UserBlock::Text {
                    text: "what is this?".into(),
                },
                UserBlock::Image { blob: blob.clone() },
            ],
            delivery: Delivery::Turn,
        })
        .await;
    let records = records_of(&engine.until_turn_ended().await);
    let RecordBody::UserMessage { input, .. } = &records[1].body else {
        panic!("the message: {:?}", records[1]);
    };
    assert_eq!(input[1], UserBlock::Image { blob });
    let sent = sent_messages(&mock)[0].to_string();
    assert!(
        sent.contains(&BASE64.encode(png)),
        "the model got the image: {sent}"
    );
    assert!(engine.shutdown().await.success());
}

#[tokio::test]
async fn a_blob_that_is_not_base64_or_has_no_media_type_is_refused() {
    let client = Arc::new(FakeClient::new("http://127.0.0.1:9"));
    let engine = Engine::ready(&temp_dir("blob-refused"), &[], client).await;
    let not_base64 = engine
        .request::<Value>(ClientRequest::PutBlob {
            media_type: "image/png".into(),
            data: "%%%".into(),
        })
        .await
        .expect_err("refused");
    assert_eq!(not_base64.code, -32602);
    let no_type = engine
        .request::<Value>(ClientRequest::PutBlob {
            media_type: "png".into(),
            data: BASE64.encode(b"x"),
        })
        .await
        .expect_err("refused");
    assert!(
        no_type.message.contains("media type"),
        "{}",
        no_type.message
    );
    assert!(engine.shutdown().await.success());
}

#[tokio::test]
async fn a_client_tool_reports_progress_to_the_viewers() {
    let mock = mock(vec![
        tool_reply(&[("preview", json!({ "path": "/" }))]),
        text_reply(&["Done."]),
    ])
    .await;
    let client = Arc::new(FakeClient::new(&mock.base));
    *client.progress.lock().unwrap() = vec!["building".into(), "serving".into()];
    let engine = Engine::ready(&temp_dir("progress"), &[], client).await;
    let session = engine.create(config(&temp_dir("progress-workspace"))).await;
    engine.subscribe(&session, 0).await;
    engine.send(&session, "show me").await;
    let notifications = engine.until_turn_ended().await;

    let records = records_of(&notifications);
    let call = records
        .iter()
        .find_map(|record| match &record.body {
            RecordBody::ToolCallStarted { call, .. } => Some(call.clone()),
            _ => None,
        })
        .expect("the tool ran");
    let progress: Vec<String> = deltas_of(&notifications)
        .into_iter()
        .filter_map(|delta| match delta {
            Delta::ToolProgress { call: of, text } if of == call => Some(text),
            _ => None,
        })
        .collect();
    assert_eq!(progress, ["building", "serving"]);
    assert!(engine.shutdown().await.success());
}

#[tokio::test]
async fn claude_code_is_asked_a_credential_per_session_and_others_once() {
    let mock = mock(vec![
        text_reply(&["one"]),
        text_reply(&["two"]),
        text_reply(&["three"]),
        text_reply(&["four"]),
    ])
    .await;
    let client = Arc::new(FakeClient::new(&mock.base));
    let engine = Engine::ready(&temp_dir("credential"), &[], client.clone()).await;
    let workspace = temp_dir("credential-workspace");
    let claude_code = {
        let mut config = config(&workspace);
        config.model = ModelRef {
            provider: "claude-code".into(),
            model: "sonnet".into(),
        };
        config
    };
    let mut sessions = Vec::new();
    for config in [
        config(&workspace),
        config(&workspace),
        claude_code.clone(),
        claude_code,
    ] {
        let session = engine.create(config).await;
        engine.subscribe(&session, 0).await;
        engine.send(&session, "hello").await;
        engine.until_turn_ended().await;
        sessions.push(session);
    }

    let asks = client.credential_asks.lock().unwrap().clone();
    assert_eq!(
        asks,
        [
            ("anthropic".to_owned(), sessions[0].clone()),
            ("claude-code".to_owned(), sessions[2].clone()),
            ("claude-code".to_owned(), sessions[3].clone()),
        ]
    );
    assert!(engine.shutdown().await.success());
}
