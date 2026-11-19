//! The JSON shapes clients and stored sessions depend on.

use blame_engine_protocol::rpc::{
    ClientRequest, EngineNotification, Message, Outcome, RpcError, Version,
};
use blame_engine_protocol::{
    AssistantBlock, Delivery, ModelRef, NativeItem, Record, RecordBody, SessionId, ToolCallId,
    TurnId, UserBlock,
};
use serde_json::{Value, json};

fn round_trip<T>(value: &T) -> Value
where
    T: serde::Serialize + serde::de::DeserializeOwned + PartialEq + std::fmt::Debug,
{
    let encoded = serde_json::to_value(value).expect("serializes");
    let decoded: T = serde_json::from_value(encoded.clone()).expect("deserializes");
    assert_eq!(&decoded, value);
    encoded
}

#[test]
fn a_record_is_one_flat_object() {
    let record = Record {
        seq: 2,
        at_ms: 1_700_000_000_000,
        body: RecordBody::UserMessage {
            turn: TurnId::from("turn-1"),
            input: vec![UserBlock::Text {
                text: "hello".into(),
            }],
            delivery: Delivery::Turn,
        },
    };
    assert_eq!(
        round_trip(&record),
        json!({
            "seq": 2,
            "at_ms": 1_700_000_000_000u64,
            "type": "user_message",
            "turn": "turn-1",
            "input": [{ "type": "text", "text": "hello" }],
            "delivery": "turn",
        })
    );
}

#[test]
fn a_native_item_is_kept_verbatim_and_omitted_when_absent() {
    let native = NativeItem {
        wire: "anthropic-messages".into(),
        model: ModelRef {
            provider: "anthropic".into(),
            model: "m".into(),
        },
        item: json!({ "type": "thinking", "thinking": "…", "signature": "c2ln" }),
    };
    let with = AssistantBlock::Reasoning {
        text: "…".into(),
        native: Some(native),
    };
    assert_eq!(round_trip(&with)["native"]["item"]["signature"], "c2ln");

    let without = AssistantBlock::ToolCall {
        call: ToolCallId::from("call-1"),
        name: "read_code".into(),
        input: json!({ "path": "a.ts" }),
        native: None,
    };
    assert!(round_trip(&without).get("native").is_none());
}

#[test]
fn requests_responses_and_notifications_are_json_rpc() {
    let request: Message<ClientRequest> = Message::Request {
        jsonrpc: Version::V2,
        id: 7,
        call: ClientRequest::Subscribe {
            session: SessionId::from("s"),
            after: 12,
        },
    };
    assert_eq!(
        round_trip(&request),
        json!({
            "jsonrpc": "2.0",
            "id": 7,
            "method": "session/subscribe",
            "params": { "session": "s", "after": 12 },
        })
    );

    let response: Message<ClientRequest> = Message::Response {
        jsonrpc: Version::V2,
        id: 7,
        outcome: Outcome::Error(RpcError {
            code: -32000,
            message: "no".into(),
            data: None,
        }),
    };
    assert_eq!(
        round_trip(&response),
        json!({ "jsonrpc": "2.0", "id": 7, "error": { "code": -32000, "message": "no" } })
    );

    let notification: Message<EngineNotification> = Message::Notification {
        jsonrpc: Version::V2,
        call: EngineNotification::Record {
            session: SessionId::from("s"),
            record: Record {
                seq: 1,
                at_ms: 0,
                body: RecordBody::RewindUndone { rewind: 9 },
            },
        },
    };
    let encoded = round_trip(&notification);
    assert_eq!(encoded["method"], "session/record");
    assert!(encoded.get("id").is_none());
}

#[test]
fn a_request_without_parameters_and_a_null_result_parse() {
    let shutdown: Message<ClientRequest> = serde_json::from_value(
        json!({ "jsonrpc": "2.0", "id": 1, "method": "shutdown", "params": {} }),
    )
    .expect("parses");
    assert!(matches!(
        shutdown,
        Message::Request {
            call: ClientRequest::Shutdown {},
            ..
        }
    ));

    let done: Message<ClientRequest> =
        serde_json::from_value(json!({ "jsonrpc": "2.0", "id": 1, "result": null }))
            .expect("parses");
    assert!(matches!(
        done,
        Message::Response {
            outcome: Outcome::Result(Value::Null),
            ..
        }
    ));
}
