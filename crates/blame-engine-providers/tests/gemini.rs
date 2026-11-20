//! The Gemini `generateContent` wire against a local server, with the
//! replay of thought signatures across requests.

mod support;

use blame_engine_core::ports::{ModelEvent, ModelMessage, ToolResultMessage};
use blame_engine_protocol::{AssistantBlock, ErrorKind, StopReason, ToolOutcome, ToolResultBlock};
use blame_engine_providers::{Options, connect};
use serde_json::{Value, json};
use support::*;

const MODEL: &str = "gemini-2.5-flash";
const SIGNATURE: &str = "CiQBaRR9E2NXvZvOBpVTaadQB6jTzzDK5WrKVQqTPxEMFbMax08KcwFpFH0THuth4U5Bty/w5xw6CbkAaoQwvL94aH9+GwnVN1D3P5T9E7ymGl5g2pWQ";

/// A reply in the shape Gemini streams it (a recorded reply, shortened):
/// a thought, then a call signed with its thought signature.
fn reply() -> String {
    data_lines(&[
        json!({"candidates": [{"content": {"role": "model", "parts": [
                {"text": "**Checking the weather**\n\nI'll call get_weather.", "thought": true}]}, "index": 0}],
               "modelVersion": MODEL, "responseId": "r1",
               "usageMetadata": {"promptTokenCount": 144, "thoughtsTokenCount": 48, "totalTokenCount": 192}}),
        json!({"candidates": [{"content": {"role": "model", "parts": [
                {"functionCall": {"name": "get_weather", "args": {"city": "Tokyo"}}, "thoughtSignature": SIGNATURE}]},
               "finishReason": "STOP", "index": 0}],
               "modelVersion": MODEL, "responseId": "r1",
               "usageMetadata": {"promptTokenCount": 144, "cachedContentTokenCount": 100,
                                 "candidatesTokenCount": 16, "thoughtsTokenCount": 48, "totalTokenCount": 208}}),
    ])
}

fn text_reply() -> String {
    data_lines(&[
        json!({"candidates": [{"content": {"role": "model", "parts": [{"text": "Sunny."}]},
        "finishReason": "STOP", "index": 0}], "modelVersion": MODEL,
        "usageMetadata": {"promptTokenCount": 200, "candidatesTokenCount": 2, "totalTokenCount": 202}}),
    ])
}

fn gemini(mock: &Mock) -> blame_engine_providers::Provider {
    connect(
        "gemini",
        &api_key("gem-key", &mock.base),
        &Options::default(),
    )
    .expect("provider")
}

fn native(item: Value) -> blame_engine_protocol::NativeItem {
    blame_engine_protocol::NativeItem {
        wire: "gemini-generate-content".into(),
        model: model("gemini", MODEL),
        item,
    }
}

fn gemini_request(messages: Vec<ModelMessage>) -> blame_engine_core::ports::ModelRequest {
    let mut request = request(model("gemini", MODEL), messages);
    request.max_output_tokens = Some(32_000);
    request
}

#[tokio::test]
async fn a_forced_tool_asks_for_a_call_of_that_function() {
    let mock = Mock::start(vec![Reply::sse(&reply())]).await;
    let mut forced = gemini_request(vec![user("Weather in Tokyo?")]);
    forced.forced_tool = Some("get_weather".into());
    let (_, error) = run(&gemini(&mock), forced).await;
    assert!(error.is_none(), "{error:?}");
    assert_eq!(
        mock.only_request().body["toolConfig"],
        json!({"functionCallingConfig": {"mode": "ANY", "allowed_function_names": ["get_weather"]}})
    );
}

#[tokio::test]
async fn sends_the_request_and_reads_the_reply() {
    let mock = Mock::start(vec![Reply::sse(&reply())]).await;
    let (events, error) = run(
        &gemini(&mock),
        gemini_request(vec![user("Weather in Tokyo?")]),
    )
    .await;
    assert!(error.is_none(), "{error:?}");

    let sent = mock.only_request();
    let (path, query) = sent.target.split_once('?').expect("query");
    assert_eq!(
        path,
        format!("/v1beta/models/{MODEL}:streamGenerateContent")
    );
    let query: Vec<(String, String)> = url::form_urlencoded::parse(query.as_bytes())
        .into_owned()
        .collect();
    assert!(
        query.contains(&("key".into(), "gem-key".into())),
        "{query:?}"
    );
    assert!(query.contains(&("alt".into(), "sse".into())), "{query:?}");
    let body = &sent.body;
    assert_eq!(
        body["systemInstruction"]["parts"][0]["text"],
        "You are a test."
    );
    assert_eq!(body["contents"][0]["role"], "user");
    assert_eq!(body["contents"][0]["parts"][0]["text"], "Weather in Tokyo?");
    let tools: Vec<&str> = body["tools"][0]["functionDeclarations"]
        .as_array()
        .expect("tools")
        .iter()
        .map(|tool| tool["name"].as_str().expect("name"))
        .collect();
    assert_eq!(tools, ["get_weather", "read_file"]);
    assert_eq!(body["generationConfig"]["maxOutputTokens"], 32_000);
    // Gemini 2.5 takes a thinking budget, not an effort level: `high`
    // becomes a budget inside the model's range.
    assert_eq!(
        body["generationConfig"]["thinkingConfig"]["thinkingBudget"],
        16_384
    );

    assert!(events.contains(&ModelEvent::ToolInputDelta {
        index: 1,
        json: "{\"city\":\"Tokyo\"}".into()
    }));
    let blocks = finished_blocks(&events);
    assert_eq!(blocks.len(), 2, "{blocks:#?}");
    assert_eq!(
        blocks[0],
        AssistantBlock::Reasoning {
            text: "**Checking the weather**\n\nI'll call get_weather.".into(),
            native: Some(native(
                json!({"text": "**Checking the weather**\n\nI'll call get_weather.", "thought": true})
            )),
        }
    );
    let AssistantBlock::ToolCall {
        call,
        name,
        input,
        native: Some(item),
    } = &blocks[1]
    else {
        panic!("{blocks:#?}");
    };
    // Gemini 2.5 names no call: the id is one the engine can keep.
    assert!(!call.as_str().is_empty());
    assert_eq!(name, "get_weather");
    assert_eq!(*input, json!({"city": "Tokyo"}));
    assert_eq!(
        item.item,
        json!({"functionCall": {"name": "get_weather", "args": {"city": "Tokyo"}}, "thoughtSignature": SIGNATURE})
    );

    let Some(ModelEvent::Finished { stop, usage }) = events.last() else {
        panic!("{events:#?}")
    };
    assert_eq!(*stop, StopReason::ToolUse);
    // Gemini's prompt count includes the cached part; its output count
    // leaves the thoughts out. Ours: no overlap, thoughts in the output.
    assert_eq!(usage.input_tokens, Some(44));
    assert_eq!(usage.cache_read_tokens, Some(100));
    assert_eq!(usage.output_tokens, Some(64));
    assert_eq!(usage.reasoning_tokens, Some(48));
    assert!(usage.cost_micro_usd.is_some());
}

fn history(blocks: Vec<AssistantBlock>) -> Vec<ModelMessage> {
    let AssistantBlock::ToolCall { call, .. } = &blocks[1] else {
        panic!("{blocks:#?}")
    };
    let call = call.clone();
    vec![
        user("Weather in Tokyo?"),
        ModelMessage::Assistant(blocks),
        ModelMessage::ToolResults(vec![ToolResultMessage {
            call,
            outcome: ToolOutcome::Completed,
            content: vec![ToolResultBlock::Text {
                text: "Sunny, 24°C".into(),
            }],
        }]),
    ]
}

#[tokio::test]
async fn replays_thought_signatures_to_the_model_that_wrote_them() {
    let mock = Mock::start(vec![
        Reply::sse(&reply()),
        Reply::sse(&text_reply()),
        Reply::sse(&text_reply()),
    ])
    .await;
    let provider = gemini(&mock);
    let (events, _) = run(&provider, gemini_request(vec![user("Weather in Tokyo?")])).await;
    let stored: Vec<AssistantBlock> =
        serde_json::from_value(serde_json::to_value(finished_blocks(&events)).unwrap()).unwrap();

    let (events, error) = run(&provider, gemini_request(history(stored.clone()))).await;
    assert!(error.is_none(), "{error:?}");
    assert!(matches!(
        events.last(),
        Some(ModelEvent::Finished {
            stop: StopReason::EndTurn,
            ..
        })
    ));
    let contents = &mock.requests()[1].body["contents"];
    assert_eq!(contents[1]["role"], "model");
    assert_eq!(
        contents[1]["parts"],
        json!([
            {"text": "**Checking the weather**\n\nI'll call get_weather.", "thought": true},
            {"functionCall": {"name": "get_weather", "args": {"city": "Tokyo"}}, "thoughtSignature": SIGNATURE},
        ]),
        "{contents:#}"
    );
    let response = &contents[2]["parts"][0]["functionResponse"];
    assert_eq!(response["name"], "get_weather", "{contents:#}");
    assert_eq!(response["response"], json!({"result": "Sunny, 24°C"}));

    // Another model never sees the signature.
    let mut other = request(model("gemini", "gemini-3-flash-preview"), history(stored));
    other.max_output_tokens = Some(32_000);
    let (_, error) = run(&provider, other).await;
    assert!(error.is_none(), "{error:?}");
    let contents = serde_json::to_string(&mock.requests()[2].body["contents"]).unwrap();
    assert!(!contents.contains(SIGNATURE), "{contents}");
    assert!(contents.contains("get_weather"), "{contents}");
}

#[tokio::test]
async fn a_bearer_token_is_refused() {
    let credential = blame_engine_protocol::rpc::Credential::Bearer {
        token: "t".into(),
        account: None,
        base_url: None,
    };
    let error = connect("gemini", &credential, &Options::default()).expect_err("refused");
    assert_eq!(error.kind, ErrorKind::Authentication);
}

#[tokio::test]
async fn http_errors_carry_their_kind_and_wait() {
    let mock = Mock::start(vec![
        Reply::json(429, json!({"error": {"code": 429, "status": "RESOURCE_EXHAUSTED",
            "message": "You exceeded your current quota, please check your plan and billing details.",
            "details": [{"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "17s"}]}})),
        Reply::json(503, json!({"error": {"code": 503, "status": "UNAVAILABLE", "message": "The model is overloaded. Please try again later."}})),
        Reply::json(400, json!({"error": {"code": 400, "status": "INVALID_ARGUMENT",
            "message": "The input token count (1200000) exceeds the maximum number of tokens allowed (1048576)."}})),
        Reply::json(400, json!({"error": {"code": 400, "status": "INVALID_ARGUMENT", "message": "API key not valid. Please pass a valid API key.",
            "details": [{"@type": "type.googleapis.com/google.rpc.ErrorInfo", "reason": "API_KEY_INVALID"}]}})),
    ]).await;
    let provider = gemini(&mock);
    let expected = [
        ErrorKind::RateLimited,
        ErrorKind::Overloaded,
        ErrorKind::ContextOverflow,
        ErrorKind::Authentication,
    ];
    for (at, kind) in expected.into_iter().enumerate() {
        let (_, error) = run(&provider, gemini_request(vec![user("hi")])).await;
        let error = error.expect("an error");
        assert_eq!(error.kind, kind, "reply {at}: {error:?}");
        if at == 0 {
            assert_eq!(error.retry_after, Some(std::time::Duration::from_secs(17)));
        }
    }
}
