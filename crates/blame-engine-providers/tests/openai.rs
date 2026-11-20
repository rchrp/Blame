//! The OpenAI Responses wire (API and ChatGPT subscription) and the Chat
//! Completions wire (OpenRouter, any compatible server) against a local
//! server.

mod support;

use blame_engine_core::ports::{ModelEvent, ModelMessage, ToolResultMessage};
use blame_engine_protocol::rpc::Credential;
use blame_engine_protocol::{AssistantBlock, StopReason, ToolOutcome, ToolResultBlock};
use blame_engine_providers::{Options, connect};
use serde_json::{Value, json};
use support::*;

const MODEL: &str = "gpt-5.4";
const CIPHERTEXT: &str = "gAAAAABqvzS422rw0Sm6-U6jyixkJN1KyDtw-F_nCKP4FW_xDBXl3FT7yvvB";

fn reasoning_item() -> Value {
    json!({"type": "reasoning", "id": "rs_1", "encrypted_content": CIPHERTEXT,
           "summary": [{"type": "summary_text", "text": "Need the weather tool."}]})
}

fn call_item(status: &str, arguments: &str) -> Value {
    json!({"type": "function_call", "id": "fc_1", "call_id": "call_1", "name": "get_weather",
           "arguments": arguments, "status": status})
}

/// A reply in the shape the Responses API streams it (from a recorded
/// reply, shortened): encrypted reasoning with a summary, then a call.
fn reply(model: &str) -> String {
    let response = |status: &str, output: Value, usage: Value| {
        json!({"id": "resp_1", "object": "response", "created_at": 0, "model": model,
               "status": status, "output": output, "usage": usage})
    };
    sse(&[
        (
            "response.created",
            json!({"type": "response.created", "sequence_number": 0,
            "response": response("in_progress", json!([]), Value::Null)}),
        ),
        (
            "response.output_item.added",
            json!({"type": "response.output_item.added", "sequence_number": 1,
            "output_index": 0, "item": {"type": "reasoning", "id": "rs_1", "summary": []}}),
        ),
        (
            "response.reasoning_summary_part.added",
            json!({"type": "response.reasoning_summary_part.added",
            "sequence_number": 2, "item_id": "rs_1", "output_index": 0, "summary_index": 0,
            "part": {"type": "summary_text", "text": ""}}),
        ),
        (
            "response.reasoning_summary_text.delta",
            json!({"type": "response.reasoning_summary_text.delta",
            "sequence_number": 3, "item_id": "rs_1", "output_index": 0, "summary_index": 0,
            "delta": "Need the weather tool."}),
        ),
        (
            "response.reasoning_summary_text.done",
            json!({"type": "response.reasoning_summary_text.done",
            "sequence_number": 4, "item_id": "rs_1", "output_index": 0, "summary_index": 0,
            "text": "Need the weather tool."}),
        ),
        (
            "response.output_item.done",
            json!({"type": "response.output_item.done", "sequence_number": 5,
            "output_index": 0, "item": reasoning_item()}),
        ),
        (
            "response.output_item.added",
            json!({"type": "response.output_item.added", "sequence_number": 6,
            "output_index": 1, "item": call_item("in_progress", "")}),
        ),
        (
            "response.function_call_arguments.delta",
            json!({"type": "response.function_call_arguments.delta",
            "sequence_number": 7, "item_id": "fc_1", "output_index": 1, "delta": "{\"city\":\"Pa"}),
        ),
        (
            "response.function_call_arguments.delta",
            json!({"type": "response.function_call_arguments.delta",
            "sequence_number": 8, "item_id": "fc_1", "output_index": 1, "delta": "ris\"}"}),
        ),
        (
            "response.function_call_arguments.done",
            json!({"type": "response.function_call_arguments.done",
            "sequence_number": 9, "item_id": "fc_1", "output_index": 1, "arguments": "{\"city\":\"Paris\"}"}),
        ),
        (
            "response.output_item.done",
            json!({"type": "response.output_item.done", "sequence_number": 10,
            "output_index": 1, "item": call_item("completed", "{\"city\":\"Paris\"}")}),
        ),
        (
            "response.completed",
            json!({"type": "response.completed", "sequence_number": 11,
            "response": response("completed",
                json!([reasoning_item(), call_item("completed", "{\"city\":\"Paris\"}")]),
                json!({"input_tokens": 1000, "input_tokens_details": {"cached_tokens": 800},
                       "output_tokens": 50, "output_tokens_details": {"reasoning_tokens": 30},
                       "total_tokens": 1050}))}),
        ),
    ])
}

fn text_reply(model: &str) -> String {
    let message = json!({"type": "message", "id": "msg_1", "role": "assistant", "status": "completed",
        "content": [{"type": "output_text", "text": "Sunny.", "annotations": []}]});
    sse(&[
        (
            "response.created",
            json!({"type": "response.created", "sequence_number": 0,
            "response": {"id": "resp_2", "object": "response", "created_at": 0, "model": model,
                         "status": "in_progress", "output": []}}),
        ),
        (
            "response.output_item.added",
            json!({"type": "response.output_item.added", "sequence_number": 1,
            "output_index": 0, "item": {"type": "message", "id": "msg_1", "role": "assistant",
                                         "status": "in_progress", "content": []}}),
        ),
        (
            "response.output_text.delta",
            json!({"type": "response.output_text.delta", "sequence_number": 2,
            "item_id": "msg_1", "output_index": 0, "content_index": 0, "delta": "Sunny."}),
        ),
        (
            "response.output_item.done",
            json!({"type": "response.output_item.done", "sequence_number": 3,
            "output_index": 0, "item": message}),
        ),
        (
            "response.completed",
            json!({"type": "response.completed", "sequence_number": 4,
            "response": {"id": "resp_2", "object": "response", "created_at": 0, "model": model,
                         "status": "completed", "output": [message],
                         "usage": {"input_tokens": 10, "output_tokens": 2, "total_tokens": 12}}}),
        ),
    ])
}

fn openai(mock: &Mock) -> blame_engine_providers::Provider {
    let credential = api_key("sk-test", &format!("{}/v1", mock.base));
    connect("openai", &credential, &Options::default()).expect("provider")
}

fn native(provider: &str, item: Value) -> blame_engine_protocol::NativeItem {
    blame_engine_protocol::NativeItem {
        wire: "openai-responses".into(),
        model: model(provider, MODEL),
        item,
    }
}

#[tokio::test]
async fn a_forced_tool_reaches_the_wire_as_the_tool_choice() {
    let mock = Mock::start(vec![Reply::sse(&reply(MODEL))]).await;
    let mut forced = request(model("openai", MODEL), vec![user("Weather in Paris?")]);
    forced.forced_tool = Some("read_file".into());
    let (_, error) = run(&openai(&mock), forced).await;
    assert!(error.is_none(), "{error:?}");
    assert_eq!(
        mock.only_request().body["tool_choice"],
        json!({"type": "function", "name": "read_file"})
    );
}

#[test]
fn only_providers_that_honour_a_forced_choice_are_asked_to_force_one() {
    let forces = |provider: &str| blame_engine_providers::forces_tool(&model(provider, MODEL));
    assert!(forces("openai"));
    assert!(forces("gemini"));
    for provider in [
        "anthropic",
        "claude-code",
        "chatgpt",
        "openrouter",
        "openai-compatible",
    ] {
        assert!(!forces(provider), "{provider}");
    }
}

#[tokio::test]
async fn sends_a_stateless_request_and_reads_the_reply() {
    let mock = Mock::start(vec![Reply::sse(&reply(MODEL))]).await;
    let (events, error) = run(
        &openai(&mock),
        request(model("openai", MODEL), vec![user("Weather in Paris?")]),
    )
    .await;
    assert!(error.is_none(), "{error:?}");

    let sent = mock.only_request();
    assert_eq!(sent.target, "/v1/responses");
    assert_eq!(sent.header("authorization"), Some("Bearer sk-test"));
    let body = &sent.body;
    assert_eq!(body["model"], MODEL);
    assert_eq!(body["instructions"], "You are a test.");
    assert_eq!(
        body["input"],
        json!([{"type": "message", "role": "user",
        "content": [{"type": "input_text", "text": "Weather in Paris?"}]}])
    );
    // Nothing kept on OpenAI's side: reasoning travels encrypted.
    assert_eq!(body["store"], false);
    assert_eq!(body["include"], json!(["reasoning.encrypted_content"]));
    // The cache key routes the session to the server holding its prefix;
    // the long-lived prefix asks for the extended retention.
    assert_eq!(body["prompt_cache_key"], "session-1");
    assert_eq!(body["prompt_cache_retention"], "24h");
    assert_eq!(body["reasoning"]["effort"], "high");
    assert_eq!(body["max_output_tokens"], 1000);
    let tools: Vec<&str> = body["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .map(|tool| tool["name"].as_str().expect("name"))
        .collect();
    assert_eq!(tools, ["get_weather", "read_file"]);

    assert!(events.contains(&ModelEvent::ReasoningDelta {
        index: 0,
        text: "Need the weather tool.".into()
    }));
    assert!(events.contains(&ModelEvent::ToolInputDelta {
        index: 1,
        json: "ris\"}".into()
    }));
    let finished: Vec<(u32, AssistantBlock)> = events
        .iter()
        .filter_map(|event| match event {
            ModelEvent::BlockFinished { index, block } => Some((*index, block.clone())),
            _ => None,
        })
        .collect();
    assert_eq!(
        finished,
        [
            (
                0,
                AssistantBlock::Reasoning {
                    text: "Need the weather tool.".into(),
                    native: Some(native("openai", reasoning_item())),
                }
            ),
            (
                1,
                AssistantBlock::ToolCall {
                    call: "call_1".into(),
                    name: "get_weather".into(),
                    input: json!({"city": "Paris"}),
                    native: Some(native(
                        "openai",
                        call_item("completed", "{\"city\":\"Paris\"}")
                    )),
                }
            ),
        ]
    );
    let Some(ModelEvent::Finished { stop, usage }) = events.last() else {
        panic!("{events:#?}")
    };
    assert_eq!(*stop, StopReason::ToolUse);
    // OpenAI's input counts the cached tokens; ours does not.
    assert_eq!(usage.input_tokens, Some(200));
    assert_eq!(usage.cache_read_tokens, Some(800));
    assert_eq!(usage.output_tokens, Some(50));
    assert_eq!(usage.reasoning_tokens, Some(30));
    // gpt-5.4 at the catalog's list price: $2.50 in, $0.25 cached, $15 out
    // per million tokens.
    assert_eq!(usage.cost_micro_usd, Some(500 + 200 + 750));
}

fn history(blocks: Vec<AssistantBlock>) -> Vec<ModelMessage> {
    vec![
        user("Weather in Paris?"),
        ModelMessage::Assistant(blocks),
        ModelMessage::ToolResults(vec![ToolResultMessage {
            call: "call_1".into(),
            outcome: ToolOutcome::Failed,
            content: vec![ToolResultBlock::Text {
                text: "service down".into(),
            }],
        }]),
    ]
}

#[tokio::test]
async fn replays_encrypted_reasoning_to_the_model_that_wrote_it() {
    let mock = Mock::start(vec![
        Reply::sse(&reply(MODEL)),
        Reply::sse(&text_reply(MODEL)),
        Reply::sse(&text_reply("gpt-5.2")),
    ])
    .await;
    let provider = openai(&mock);
    let (events, _) = run(
        &provider,
        request(model("openai", MODEL), vec![user("Weather in Paris?")]),
    )
    .await;
    let stored: Vec<AssistantBlock> =
        serde_json::from_value(serde_json::to_value(finished_blocks(&events)).unwrap()).unwrap();

    let (events, error) = run(
        &provider,
        request(model("openai", MODEL), history(stored.clone())),
    )
    .await;
    assert!(error.is_none(), "{error:?}");
    assert_eq!(
        finished_blocks(&events),
        [AssistantBlock::Text {
            text: "Sunny.".into(),
            native: Some(native(
                "openai",
                json!({"type": "message", "id": "msg_1", "role": "assistant",
            "status": "completed", "content": [{"type": "output_text", "text": "Sunny.", "annotations": []}]})
            )),
        }]
    );
    let input = mock.requests()[1].body["input"].clone();
    let items = input.as_array().expect("input");
    assert_eq!(items.len(), 4, "{input:#}");
    assert_eq!(items[1]["encrypted_content"], CIPHERTEXT, "{input:#}");
    assert_eq!(items[1]["id"], "rs_1");
    assert_eq!(items[2]["type"], "function_call");
    assert_eq!(items[2]["call_id"], "call_1");
    assert_eq!(items[3]["type"], "function_call_output");
    assert_eq!(items[3]["call_id"], "call_1");

    // Another model cannot read the ciphertext: it is not sent.
    let (_, error) = run(
        &provider,
        request(model("openai", "gpt-5.2"), history(stored)),
    )
    .await;
    assert!(error.is_none(), "{error:?}");
    let input = serde_json::to_string(&mock.requests()[2].body["input"]).unwrap();
    assert!(!input.contains(CIPHERTEXT), "{input}");
    assert!(input.contains("call_1"), "{input}");
}

#[tokio::test]
async fn the_chatgpt_subscription_sends_its_token_account_and_session() {
    let mock = Mock::start(vec![Reply::sse(&reply(MODEL))]).await;
    let credential = Credential::Bearer {
        token: "chatgpt-access".into(),
        account: Some("acct_1".into()),
        base_url: Some(format!("{}/backend-api/codex", mock.base)),
    };
    let provider = connect("chatgpt", &credential, &Options::default()).expect("provider");
    let (events, error) = run(
        &provider,
        request(model("chatgpt", MODEL), vec![user("Weather in Paris?")]),
    )
    .await;
    assert!(error.is_none(), "{error:?}");
    let sent = mock.only_request();
    assert_eq!(sent.target, "/backend-api/codex/responses");
    assert_eq!(sent.header("authorization"), Some("Bearer chatgpt-access"));
    assert_eq!(sent.header("chatgpt-account-id"), Some("acct_1"));
    assert_eq!(sent.header("originator"), Some("blame"));
    // The backend routes its prompt cache by this header.
    assert_eq!(sent.header("session-id"), Some("session-1"));
    assert_eq!(
        sent.body["instructions"], "You are a test.",
        "the session's prompt alone"
    );
    assert_eq!(sent.body["store"], false);
    let Some(ModelEvent::Finished { usage, .. }) = events.last() else {
        panic!("{events:#?}")
    };
    assert_eq!(
        usage.cost_micro_usd, None,
        "a subscription has no per-token price"
    );
    // Its items belong to the subscription, not to the API.
    assert_eq!(
        finished_blocks(&events)[0],
        AssistantBlock::Reasoning {
            text: "Need the weather tool.".into(),
            native: Some(native("chatgpt", reasoning_item())),
        }
    );
}

fn chat_reply(model: &str) -> String {
    let chunk = |delta: Value, finish: Value| {
        json!({"id": "chatcmpl-1", "object": "chat.completion.chunk",
        "created": 1, "model": model, "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]})
    };
    let mut body = data_lines(&[
        chunk(json!({"role": "assistant", "content": "Hel"}), Value::Null),
        chunk(json!({"content": "lo."}), json!("stop")),
        json!({"id": "chatcmpl-1", "object": "chat.completion.chunk", "created": 1, "model": model, "choices": [],
               "usage": {"prompt_tokens": 100, "completion_tokens": 3, "total_tokens": 103,
                         "prompt_tokens_details": {"cached_tokens": 60}}}),
    ]);
    body.push_str("data: [DONE]\n\n");
    body
}

#[tokio::test]
async fn openrouter_speaks_chat_completions() {
    let mock = Mock::start(vec![Reply::sse(&chat_reply("anthropic/claude-sonnet-4.6"))]).await;
    let credential = api_key("sk-or-test", &format!("{}/api/v1", mock.base));
    let provider = connect("openrouter", &credential, &Options::default()).expect("provider");
    let request = request(
        model("openrouter", "anthropic/claude-sonnet-4.6"),
        vec![user("hi")],
    );
    let (events, error) = run(&provider, request).await;
    assert!(error.is_none(), "{error:?}");
    let sent = mock.only_request();
    assert_eq!(sent.target, "/api/v1/chat/completions");
    assert_eq!(sent.header("authorization"), Some("Bearer sk-or-test"));
    assert_eq!(sent.body["model"], "anthropic/claude-sonnet-4.6");
    assert_eq!(
        sent.body["messages"][0],
        json!({"role": "system", "content": [{"type": "text", "text": "You are a test."}]})
    );
    let tools: Vec<&str> = sent.body["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .map(|tool| tool["function"]["name"].as_str().expect("name"))
        .collect();
    assert_eq!(tools, ["get_weather", "read_file"]);
    assert!(events.contains(&ModelEvent::TextDelta {
        index: 0,
        text: "Hel".into()
    }));
    let Some(ModelEvent::Finished { stop, usage }) = events.last() else {
        panic!("{events:#?}")
    };
    assert_eq!(*stop, StopReason::EndTurn);
    assert_eq!(usage.input_tokens, Some(40));
    assert_eq!(usage.cache_read_tokens, Some(60));
}

#[tokio::test]
async fn a_compatible_server_needs_no_key() {
    let mock = Mock::start(vec![
        Reply::sse(&chat_reply("qwen3-coder")),
        Reply::sse(&chat_reply("qwen3-coder")),
    ])
    .await;
    let keyless = api_key("", &format!("{}/v1", mock.base));
    let provider = connect("openai-compatible", &keyless, &Options::default()).expect("provider");
    let (events, error) = run(
        &provider,
        request(model("openai-compatible", "qwen3-coder"), vec![user("hi")]),
    )
    .await;
    assert!(error.is_none(), "{error:?}");
    assert_eq!(finished_blocks(&events).len(), 1);
    let sent = &mock.requests()[0];
    assert_eq!(sent.target, "/v1/chat/completions");
    assert_eq!(sent.header("authorization"), None);

    let keyed = api_key("local-key", &format!("{}/v1", mock.base));
    let provider = connect("openai-compatible", &keyed, &Options::default()).expect("provider");
    let (_, error) = run(
        &provider,
        request(model("openai-compatible", "qwen3-coder"), vec![user("hi")]),
    )
    .await;
    assert!(error.is_none(), "{error:?}");
    assert_eq!(
        mock.requests()[1].header("authorization"),
        Some("Bearer local-key")
    );

    let missing = Credential::ApiKey {
        key: String::new(),
        base_url: None,
    };
    assert!(connect("openai-compatible", &missing, &Options::default()).is_err());
}

#[tokio::test]
async fn http_errors_carry_their_kind_and_wait() {
    let mock = Mock::start(vec![
        Reply::json(429, json!({"error": {"code": "rate_limit_exceeded", "type": "requests",
            "message": "Rate limit reached for gpt-5.4. Please try again in 1.5s."}}))
            .with_header("retry-after-ms", "1500"),
        Reply::json(429, json!({"error": {"code": "insufficient_quota", "type": "insufficient_quota",
            "message": "You exceeded your current quota, please check your plan and billing details."}})),
        Reply::json(400, json!({"error": {"code": "context_length_exceeded", "type": "invalid_request_error",
            "message": "Your input exceeds the context window of this model."}})),
        Reply::json(401, json!({"error": {"code": "invalid_api_key", "message": "Incorrect API key provided."}})),
        Reply::json(500, json!({"error": {"code": "server_error", "message": "The server had an error."}})),
    ]).await;
    let provider = openai(&mock);
    let expected = [
        blame_engine_protocol::ErrorKind::RateLimited,
        blame_engine_protocol::ErrorKind::Billing,
        blame_engine_protocol::ErrorKind::ContextOverflow,
        blame_engine_protocol::ErrorKind::Authentication,
        blame_engine_protocol::ErrorKind::Overloaded,
    ];
    for (at, kind) in expected.into_iter().enumerate() {
        let (events, error) =
            run(&provider, request(model("openai", MODEL), vec![user("hi")])).await;
        let error = error.expect("an error");
        assert_eq!(error.kind, kind, "reply {at}: {error:?}");
        assert!(events.is_empty());
        if at == 0 {
            assert_eq!(
                error.retry_after,
                Some(std::time::Duration::from_millis(1500))
            );
        }
    }
    assert_eq!(
        mock.requests().len(),
        5,
        "never retried inside the provider"
    );
}
