//! The Anthropic Messages wire against a local server: what is sent, what
//! comes back, and the replay of thinking across requests.

mod support;

use blame_engine_core::ports::{ModelEvent, ModelMessage, ToolResultMessage};
use blame_engine_protocol::rpc::Credential;
use blame_engine_protocol::{
    AssistantBlock, BlobRef, BlockKind, ErrorKind, StopReason, ToolOutcome, ToolResultBlock,
    UserBlock,
};
use blame_engine_providers::{Options, connect};
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;
use support::*;

const SIGNATURE: &str =
    "EvECCqgBCBIYAipAC6Z8WibjV9YpPiJfTcIPQnEyueJdm00rm+j+65aYuY+P6H4ZENNSXTe8rE4K";
const REDACTED: &str = "RW5jcnlwdGVkIHRoaW5raW5n";

/// A reply in the shape Anthropic streams it (from a recorded reply,
/// shortened): thinking with its signature, withheld thinking, text and a
/// tool call whose input arrives in pieces.
fn reply() -> String {
    sse(&[
        (
            "message_start",
            json!({"type": "message_start", "message": {
                "id": "msg_1", "type": "message", "role": "assistant",
                "model": "claude-sonnet-4-6", "content": [],
                "stop_reason": null, "stop_sequence": null,
                "usage": {"input_tokens": 671, "cache_creation_input_tokens": 200,
                          "cache_read_input_tokens": 3000, "output_tokens": 7}}}),
        ),
        (
            "content_block_start",
            json!({"type": "content_block_start", "index": 0,
                   "content_block": {"type": "thinking", "thinking": "", "signature": ""}}),
        ),
        ("ping", json!({"type": "ping"})),
        (
            "content_block_delta",
            json!({"type": "content_block_delta", "index": 0,
                   "delta": {"type": "thinking_delta", "thinking": "The user wants"}}),
        ),
        (
            "content_block_delta",
            json!({"type": "content_block_delta", "index": 0,
                   "delta": {"type": "thinking_delta", "thinking": " the weather."}}),
        ),
        (
            "content_block_delta",
            json!({"type": "content_block_delta", "index": 0,
                   "delta": {"type": "signature_delta", "signature": SIGNATURE}}),
        ),
        (
            "content_block_stop",
            json!({"type": "content_block_stop", "index": 0}),
        ),
        (
            "content_block_start",
            json!({"type": "content_block_start", "index": 1,
                   "content_block": {"type": "redacted_thinking", "data": REDACTED}}),
        ),
        (
            "content_block_stop",
            json!({"type": "content_block_stop", "index": 1}),
        ),
        (
            "content_block_start",
            json!({"type": "content_block_start", "index": 2,
                   "content_block": {"type": "text", "text": ""}}),
        ),
        (
            "content_block_delta",
            json!({"type": "content_block_delta", "index": 2,
                   "delta": {"type": "text_delta", "text": "Let me check"}}),
        ),
        (
            "content_block_delta",
            json!({"type": "content_block_delta", "index": 2,
                   "delta": {"type": "text_delta", "text": " Tokyo."}}),
        ),
        (
            "content_block_stop",
            json!({"type": "content_block_stop", "index": 2}),
        ),
        (
            "content_block_start",
            json!({"type": "content_block_start", "index": 3,
                   "content_block": {"type": "tool_use", "id": "toolu_01", "name": "get_weather", "input": {}}}),
        ),
        (
            "content_block_delta",
            json!({"type": "content_block_delta", "index": 3,
                   "delta": {"type": "input_json_delta", "partial_json": "{\"city\": \"Tok"}}),
        ),
        (
            "content_block_delta",
            json!({"type": "content_block_delta", "index": 3,
                   "delta": {"type": "input_json_delta", "partial_json": "yo\"}"}}),
        ),
        (
            "content_block_stop",
            json!({"type": "content_block_stop", "index": 3}),
        ),
        (
            "message_delta",
            json!({"type": "message_delta",
                   "delta": {"stop_reason": "tool_use", "stop_sequence": null},
                   "usage": {"input_tokens": 671, "cache_creation_input_tokens": 200,
                             "cache_read_input_tokens": 3000, "output_tokens": 108}}),
        ),
        ("message_stop", json!({"type": "message_stop"})),
    ])
}

fn final_reply() -> String {
    sse(&[
        (
            "message_start",
            json!({"type": "message_start", "message": {
                "id": "msg_2", "type": "message", "role": "assistant",
                "model": "claude-sonnet-4-6", "content": [],
                "stop_reason": null, "stop_sequence": null,
                "usage": {"input_tokens": 20, "output_tokens": 1}}}),
        ),
        (
            "content_block_start",
            json!({"type": "content_block_start", "index": 0,
                   "content_block": {"type": "text", "text": ""}}),
        ),
        (
            "content_block_delta",
            json!({"type": "content_block_delta", "index": 0,
                   "delta": {"type": "text_delta", "text": "Sunny."}}),
        ),
        (
            "content_block_stop",
            json!({"type": "content_block_stop", "index": 0}),
        ),
        (
            "message_delta",
            json!({"type": "message_delta", "delta": {"stop_reason": "end_turn"},
                   "usage": {"output_tokens": 3}}),
        ),
        ("message_stop", json!({"type": "message_stop"})),
    ])
}

const MODEL: &str = "claude-sonnet-4-6";

fn first_request() -> blame_engine_core::ports::ModelRequest {
    let png = b"\x89PNG\r\n\x1a\nfake".to_vec();
    let sha = "a".repeat(64);
    let mut request = request(
        model("anthropic", MODEL),
        vec![ModelMessage::User(vec![
            UserBlock::Text {
                text: "Weather in Tokyo?".into(),
            },
            UserBlock::Image {
                blob: BlobRef {
                    sha256: sha.clone(),
                    media_type: "image/png".into(),
                    bytes: png.len() as u64,
                },
            },
        ])],
    );
    request.blobs = Arc::new(Blobs([(sha, png)].into_iter().collect()));
    request
}

fn anthropic(mock: &Mock) -> blame_engine_providers::Provider {
    connect(
        "anthropic",
        &api_key("sk-ant-test", &mock.base),
        &Options::default(),
    )
    .expect("provider")
}

fn native(item: Value) -> blame_engine_protocol::NativeItem {
    blame_engine_protocol::NativeItem {
        wire: "anthropic-messages".into(),
        model: model("anthropic", MODEL),
        item,
    }
}

#[tokio::test]
async fn sends_the_request_and_reads_the_reply() {
    let mock = Mock::start(vec![Reply::sse(&reply())]).await;
    let (events, error) = run(&anthropic(&mock), first_request()).await;
    assert!(error.is_none(), "{error:?}");

    let sent = mock.only_request();
    assert_eq!(sent.method, "POST");
    assert_eq!(sent.target, "/v1/messages");
    assert_eq!(sent.header("x-api-key"), Some("sk-ant-test"));
    assert_eq!(sent.header("authorization"), None);
    assert!(sent.header("anthropic-version").is_some());

    let body = &sent.body;
    assert_eq!(body["model"], MODEL);
    assert_eq!(body["max_tokens"], 1000);
    assert_eq!(body["stream"], true);
    assert_eq!(body["output_config"]["effort"], "high");
    // The static prefix (tools, then system) is cached for an hour…
    let hour = json!({"type": "ephemeral", "ttl": "1h"});
    assert_eq!(
        body["system"],
        json!([{"type": "text", "text": "You are a test.", "cache_control": hour}])
    );
    let tools: Vec<&str> = body["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .map(|tool| tool["name"].as_str().expect("name"))
        .collect();
    assert_eq!(
        tools,
        ["get_weather", "read_file"],
        "tools keep their order"
    );
    assert_eq!(body["tools"][0].get("cache_control"), None);
    assert_eq!(body["tools"][1]["cache_control"], hour);
    // …and the breakpoint after the first message for the default five
    // minutes, on its last block.
    let first = &body["messages"][0]["content"];
    assert_eq!(
        first[0],
        json!({"type": "text", "text": "Weather in Tokyo?"})
    );
    assert_eq!(
        first[1]["source"],
        json!({"type": "base64", "media_type": "image/png", "data": "iVBORw0KGgpmYWtl"})
    );
    assert_eq!(first[1]["cache_control"], json!({"type": "ephemeral"}));
    assert_eq!(body.get("cache_control"), None, "no request-wide marker");

    let started: Vec<_> = events
        .iter()
        .filter_map(|event| match event {
            ModelEvent::BlockStarted { index, kind, tool } => Some((*index, *kind, tool.clone())),
            _ => None,
        })
        .collect();
    assert_eq!(
        started,
        [
            (0, BlockKind::Reasoning, None),
            (1, BlockKind::Reasoning, None),
            (2, BlockKind::Text, None),
            (3, BlockKind::ToolCall, Some("get_weather".into())),
        ]
    );
    assert!(events.contains(&ModelEvent::ReasoningDelta {
        index: 0,
        text: " the weather.".into()
    }));
    assert!(events.contains(&ModelEvent::TextDelta {
        index: 2,
        text: "Let me check".into()
    }));
    assert!(events.contains(&ModelEvent::ToolInputDelta {
        index: 3,
        json: "yo\"}".into()
    }));

    // The complete blocks come after every delta, then one `Finished`.
    let finished_at = events
        .iter()
        .position(|event| matches!(event, ModelEvent::BlockFinished { .. }))
        .expect("blocks");
    assert!(events[finished_at..].iter().all(|event| matches!(
        event,
        ModelEvent::BlockFinished { .. } | ModelEvent::Finished { .. }
    )));
    assert_eq!(
        finished_blocks(&events),
        [
            AssistantBlock::Reasoning {
                text: "The user wants the weather.".into(),
                native: Some(native(
                    json!({"type": "thinking", "thinking": "The user wants the weather.", "signature": SIGNATURE})
                )),
            },
            AssistantBlock::Opaque {
                native: native(json!({"type": "redacted_thinking", "data": REDACTED})),
            },
            AssistantBlock::Text {
                text: "Let me check Tokyo.".into(),
                native: Some(native(
                    json!({"type": "text", "text": "Let me check Tokyo."})
                )),
            },
            AssistantBlock::ToolCall {
                call: "toolu_01".into(),
                name: "get_weather".into(),
                input: json!({"city": "Tokyo"}),
                native: Some(native(
                    json!({"type": "tool_use", "id": "toolu_01", "name": "get_weather", "input": {"city": "Tokyo"}})
                )),
            },
        ]
    );
    let Some(ModelEvent::Finished { stop, usage }) = events.last() else {
        panic!("no Finished last: {events:#?}");
    };
    assert_eq!(*stop, StopReason::ToolUse);
    // Anthropic's own counters already do not overlap.
    assert_eq!(usage.input_tokens, Some(671));
    assert_eq!(usage.cache_read_tokens, Some(3000));
    assert_eq!(usage.cache_write_tokens, Some(200));
    assert_eq!(usage.output_tokens, Some(108));
    // Without the one-hour/five-minute split of the writes the price is
    // unknown, and a partial figure is never reported.
    assert_eq!(usage.cost_micro_usd, None);
}

fn history_after_first_reply(blocks: Vec<AssistantBlock>) -> Vec<ModelMessage> {
    vec![
        user("Weather in Tokyo?"),
        ModelMessage::Assistant(blocks),
        ModelMessage::ToolResults(vec![ToolResultMessage {
            call: "toolu_01".into(),
            outcome: ToolOutcome::Completed,
            content: vec![ToolResultBlock::Text {
                text: "Sunny, 24°C".into(),
            }],
        }]),
    ]
}

#[tokio::test]
async fn replays_thinking_signatures_to_the_model_that_wrote_them() {
    let mock = Mock::start(vec![
        Reply::sse(&reply()),
        Reply::sse(&final_reply()),
        Reply::sse(&final_reply()),
    ])
    .await;
    let provider = anthropic(&mock);
    let (events, error) = run(&provider, first_request()).await;
    assert!(error.is_none(), "{error:?}");
    // What the loop would store, read back as a stored record is.
    let stored: Vec<AssistantBlock> =
        serde_json::from_value(serde_json::to_value(finished_blocks(&events)).unwrap()).unwrap();

    let mut second = request(
        model("anthropic", MODEL),
        history_after_first_reply(stored.clone()),
    );
    second.cache.breakpoints = vec![2];
    let (events, error) = run(&provider, second).await;
    assert!(error.is_none(), "{error:?}");
    assert!(matches!(
        events.last(),
        Some(ModelEvent::Finished {
            stop: StopReason::EndTurn,
            ..
        })
    ));

    let sent = &mock.requests()[1].body;
    let messages = sent["messages"].as_array().expect("messages");
    assert_eq!(messages.len(), 3);
    assert_eq!(messages[1]["role"], "assistant");
    assert_eq!(
        messages[1]["content"],
        json!([
            {"type": "thinking", "thinking": "The user wants the weather.", "signature": SIGNATURE},
            {"type": "redacted_thinking", "data": REDACTED},
            {"type": "text", "text": "Let me check Tokyo."},
            {"type": "tool_use", "id": "toolu_01", "name": "get_weather", "input": {"city": "Tokyo"}},
        ]),
        "every item goes back exactly as it came"
    );
    assert_eq!(messages[2]["role"], "user");
    let result = &messages[2]["content"][0];
    assert_eq!(result["type"], "tool_result");
    assert_eq!(result["tool_use_id"], "toolu_01");
    assert_eq!(result["cache_control"], json!({"type": "ephemeral"}));

    // Another model gets the canonical blocks: no signature, no withheld
    // thinking.
    let other = request(
        model("anthropic", "claude-opus-4-6"),
        history_after_first_reply(stored),
    );
    let (_, error) = run(&provider, other).await;
    assert!(error.is_none(), "{error:?}");
    let sent = &mock.requests()[2].body;
    let assistant = serde_json::to_string(&sent["messages"][1]).unwrap();
    assert!(!assistant.contains(SIGNATURE), "{assistant}");
    assert!(!assistant.contains("redacted_thinking"), "{assistant}");
    assert!(assistant.contains("toolu_01"), "{assistant}");
    assert!(assistant.contains("Let me check Tokyo."), "{assistant}");
}

#[tokio::test]
async fn the_claude_code_bridge_takes_a_bearer_token_at_its_own_address() {
    let mock = Mock::start(vec![Reply::sse(&final_reply())]).await;
    let credential = Credential::Bearer {
        token: "bridge-token".into(),
        account: None,
        base_url: Some(format!("{}/bridge", mock.base)),
    };
    let provider = connect("claude-code", &credential, &Options::default()).expect("provider");
    let (events, error) = run(
        &provider,
        request(model("claude-code", MODEL), vec![user("hi")]),
    )
    .await;
    assert!(error.is_none(), "{error:?}");
    assert!(matches!(events.last(), Some(ModelEvent::Finished { .. })));
    let sent = mock.only_request();
    assert_eq!(sent.target, "/bridge/v1/messages");
    assert_eq!(sent.header("authorization"), Some("Bearer bridge-token"));
    assert_eq!(sent.header("x-api-key"), None);

    let without_url = Credential::Bearer {
        token: "t".into(),
        account: None,
        base_url: None,
    };
    let error = connect("claude-code", &without_url, &Options::default()).expect_err("base URL");
    assert_eq!(error.kind, ErrorKind::InvalidRequest);
    let error =
        connect("anthropic", &Credential::Missing, &Options::default()).expect_err("credential");
    assert_eq!(error.kind, ErrorKind::Authentication);
}

#[tokio::test]
async fn a_request_for_another_provider_is_refused() {
    let mock = Mock::start(vec![]).await;
    let (_, error) = run(
        &anthropic(&mock),
        request(model("openai", "gpt-5.4"), vec![user("hi")]),
    )
    .await;
    assert_eq!(error.expect("refused").kind, ErrorKind::InvalidRequest);
    assert!(mock.requests().is_empty());
}

#[tokio::test]
async fn a_reply_cut_mid_stream_fails_as_transport() {
    let full = reply();
    let cut_at = full
        .find("event: content_block_start\ndata: {\"content_block\":{\"text\"")
        .or_else(|| full.find("\"index\":2"))
        .expect("text block");
    let mock = Mock::start(vec![Reply {
        status: 200,
        headers: vec![("content-type".into(), "text/event-stream".into())],
        body: Body::Cut(full[..cut_at].to_owned()),
    }])
    .await;
    let (events, error) = run(&anthropic(&mock), first_request()).await;
    let error = error.expect("the stream fails");
    assert_eq!(error.kind, ErrorKind::Transport, "{error:?}");
    assert!(error.kind.is_retryable());
    assert!(
        events
            .iter()
            .any(|event| matches!(event, ModelEvent::ReasoningDelta { .. }))
    );
    assert!(
        !events.iter().any(|event| matches!(
            event,
            ModelEvent::BlockFinished { .. } | ModelEvent::Finished { .. }
        )),
        "nothing of a cut reply is complete: {events:#?}"
    );
}

#[tokio::test]
async fn a_reply_that_ends_without_its_end_fails_as_transport() {
    let full = reply();
    let end = full.find("event: message_delta").expect("message_delta");
    let mock = Mock::start(vec![Reply::sse(&full[..end])]).await;
    let (events, error) = run(&anthropic(&mock), first_request()).await;
    assert_eq!(error.expect("truncated").kind, ErrorKind::Transport);
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, ModelEvent::Finished { .. }))
    );
}

#[tokio::test]
async fn a_silent_stream_fails_as_stalled() {
    let full = reply();
    let first_block = full.find("event: content_block_start").expect("block");
    let mock = Mock::start(vec![Reply {
        status: 200,
        headers: vec![("content-type".into(), "text/event-stream".into())],
        body: Body::Stall(full[..first_block].to_owned()),
    }])
    .await;
    let options = Options {
        idle_timeout: Duration::from_millis(300),
        ..Options::default()
    };
    let provider = connect("anthropic", &api_key("k", &mock.base), &options).expect("provider");
    let (_, error) = run(&provider, first_request()).await;
    let error = error.expect("stalled");
    assert_eq!(error.kind, ErrorKind::Stalled, "{error:?}");
}

#[tokio::test]
async fn an_error_inside_the_stream_is_classified() {
    let full = reply();
    let first_block = full.find("event: content_block_start").expect("block");
    let body = format!(
        "{}{}",
        &full[..first_block],
        sse(&[(
            "error",
            json!({"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}})
        )])
    );
    let mock = Mock::start(vec![Reply::sse(&body)]).await;
    let (_, error) = run(&anthropic(&mock), first_request()).await;
    assert_eq!(error.expect("error").kind, ErrorKind::Overloaded);
}
