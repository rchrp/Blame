//! Helpers shared by the behavioural and crash tests.
#![allow(dead_code)]

use blame_engine_core::ports::{ModelMessage, ToolResultMessage};
use blame_engine_core::projection::{View, request_digest};
use blame_engine_core::testing::{World, config, standard_specs};
use blame_engine_core::{EngineOptions, RecoveryPolicy, Session};
use blame_engine_protocol::{
    AssistantBlock, Delivery, Record, RecordBody, SessionId, ToolCallId, ToolSpec, UserBlock,
};
use std::collections::HashMap;

pub fn sid() -> SessionId {
    SessionId::from("s1")
}

pub fn options(recovery: RecoveryPolicy) -> EngineOptions {
    EngineOptions {
        recovery,
        ..EngineOptions::default()
    }
}

pub fn text(text: &str) -> Vec<UserBlock> {
    vec![UserBlock::Text { text: text.into() }]
}

pub async fn create(world: &World) -> Session {
    Session::create(world.ports(), EngineOptions::default(), sid(), config())
        .await
        .expect("creates")
}

pub async fn open(world: &World, recovery: RecoveryPolicy) -> Session {
    Session::open(world.ports(), options(recovery), sid())
        .await
        .expect("opens")
}

/// Sends a turn and waits for the session to settle.
pub async fn turn(session: &Session, message: &str) {
    session
        .send(text(message), Delivery::Turn)
        .await
        .expect("accepted");
    session.wait_idle().await;
}

/// Lets the other tasks run until `condition` holds.
pub async fn until(mut condition: impl FnMut() -> bool) {
    for _ in 0..10_000 {
        if condition() {
            return;
        }
        tokio::task::yield_now().await;
    }
    panic!("the condition never held");
}

/// A short name per record, to compare logs at a glance.
pub fn kinds(records: &[Record]) -> Vec<&'static str> {
    records.iter().map(|r| kind(&r.body)).collect()
}

pub fn kind(body: &RecordBody) -> &'static str {
    match body {
        RecordBody::SessionCreated { .. } => "created",
        RecordBody::ConfigChanged { .. } => "config",
        RecordBody::UserMessage {
            delivery: Delivery::Turn,
            ..
        } => "user",
        RecordBody::UserMessage { .. } => "steer",
        RecordBody::CheckpointCreated { .. } => "checkpoint",
        RecordBody::TurnEnded { .. } => "ended",
        RecordBody::RequestStarted { .. } => "request",
        RecordBody::AssistantMessage { .. } => "reply",
        RecordBody::RequestFailed { .. } => "failed",
        RecordBody::ApprovalRequested { .. } => "approval?",
        RecordBody::ApprovalResolved { .. } => "approval",
        RecordBody::ToolCallStarted { .. } => "tool",
        RecordBody::ToolCallFinished { .. } => "result",
        RecordBody::ContextCompacted { .. } => "compacted",
        RecordBody::ContextEdited { .. } => "edited",
        RecordBody::RewindStarted { .. } => "rewind",
        RecordBody::RewindFinished { .. } => "rewound",
        RecordBody::RewindUndone { .. } => "undone",
        RecordBody::Notice { .. } => "notice",
    }
}

pub fn sorted_specs() -> Vec<ToolSpec> {
    let mut specs = standard_specs();
    specs.sort_by(|a, b| a.name.cmp(&b.name));
    specs
}

/// The invariants every log must keep, whatever happened to the engine.
pub fn check_invariants(records: &[Record], specs: &[ToolSpec]) {
    for (index, record) in records.iter().enumerate() {
        assert_eq!(record.seq, index as u64 + 1, "seqs are contiguous");
    }
    let messages = View::new(records).messages();
    let mut answered: HashMap<&ToolCallId, usize> = HashMap::new();
    for (index, message) in messages.iter().enumerate() {
        if let ModelMessage::Assistant(blocks) = message {
            let calls: Vec<&ToolCallId> = blocks
                .iter()
                .filter_map(|b| match b {
                    AssistantBlock::ToolCall { call, .. } => Some(call),
                    _ => None,
                })
                .collect();
            if calls.is_empty() {
                continue;
            }
            let Some(ModelMessage::ToolResults(results)) = messages.get(index + 1) else {
                panic!("calls without results: {message:?}");
            };
            let answered_calls: Vec<&ToolCallId> = results.iter().map(|r| &r.call).collect();
            assert_eq!(
                calls, answered_calls,
                "exactly one result per call, in order"
            );
            for call in calls {
                *answered.entry(call).or_default() += 1;
            }
        }
    }
    assert!(answered.values().all(|&n| n == 1), "a call answered twice");
    assert_digests(records, specs);
}

/// Every stored request digest is what the records before it give now:
/// reopening the session rebuilds the same bytes.
pub fn assert_digests(records: &[Record], specs: &[ToolSpec]) {
    for record in records {
        if let RecordBody::RequestStarted { prefix_digest, .. } = &record.body {
            let before = &records[..record.seq as usize - 1];
            let view = View::new(before);
            let config = view.config().expect("configured");
            let digest = request_digest(
                &config.model,
                &config.system_prompt,
                specs,
                config.reasoning,
                &view.messages(),
            );
            assert_eq!(
                &digest, prefix_digest,
                "digest of request at {}",
                record.seq
            );
        }
    }
}

/// `messages` with call ids renamed in order of appearance, to compare runs
/// whose ids differ.
pub fn normalized(messages: Vec<ModelMessage>) -> Vec<ModelMessage> {
    let mut names: HashMap<ToolCallId, ToolCallId> = HashMap::new();
    let mut rename = |call: &ToolCallId| {
        let next = ToolCallId(format!("c{}", names.len()));
        names.entry(call.clone()).or_insert(next).clone()
    };
    messages
        .into_iter()
        .map(|message| match message {
            ModelMessage::Assistant(blocks) => ModelMessage::Assistant(
                blocks
                    .into_iter()
                    .map(|block| match block {
                        AssistantBlock::ToolCall {
                            call,
                            name,
                            input,
                            native,
                        } => AssistantBlock::ToolCall {
                            call: rename(&call),
                            name,
                            input,
                            native,
                        },
                        other => other,
                    })
                    .collect(),
            ),
            ModelMessage::ToolResults(results) => ModelMessage::ToolResults(
                results
                    .into_iter()
                    .map(|result| ToolResultMessage {
                        call: rename(&result.call),
                        ..result
                    })
                    .collect(),
            ),
            other => other,
        })
        .collect()
}

pub fn user_texts(messages: &[ModelMessage]) -> Vec<String> {
    messages
        .iter()
        .filter_map(|m| match m {
            ModelMessage::User(blocks) => Some(blocks),
            _ => None,
        })
        .flatten()
        .filter_map(|b| match b {
            UserBlock::Text { text } => Some(text.clone()),
            _ => None,
        })
        .collect()
}
