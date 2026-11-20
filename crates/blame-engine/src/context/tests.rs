//! Each rule on hand-written records, then the whole policy in a session that
//! is dropped and opened again.

use super::envelope::{decode, encode};
use super::images::{DUPLICATE, OMITTED, TOO_LARGE};
use super::json::Json;
use super::overlap::OVERLAP_MARKER;
use super::*;
use blame_engine_core::projection::request_digest;
use blame_engine_core::testing;
use blame_engine_protocol::{
    BlobRef, Delivery, ModelRef, Record, RequestId, StopReason, TurnId, Usage, UserBlock,
};
use serde_json::json;

/// A log written the way the driver writes it.
struct Log {
    records: Vec<Record>,
    requests: u32,
}

impl Log {
    fn new() -> Self {
        let mut log = Self {
            records: Vec::new(),
            requests: 0,
        };
        log.push(RecordBody::SessionCreated {
            config: testing::config(),
        });
        log.push(RecordBody::UserMessage {
            turn: TurnId::from("t1"),
            input: vec![UserBlock::Text { text: "go".into() }],
            delivery: Delivery::Turn,
        });
        log
    }

    fn push(&mut self, body: RecordBody) -> Seq {
        let seq = self.records.len() as Seq + 1;
        self.records.push(Record {
            seq,
            at_ms: 0,
            body,
        });
        seq
    }

    fn policy(&self) -> Vec<ContextEdit> {
        HarnessContextPolicy.edits(&View::new(&self.records), &[])
    }

    /// What the driver does for a new request: the policy's edits, then the
    /// request.
    fn send(&mut self) -> Vec<ContextEdit> {
        let edits = self.policy();
        if !edits.is_empty() {
            self.push(RecordBody::ContextEdited {
                edits: edits.clone(),
            });
        }
        self.request();
        edits
    }

    /// A request sent with no policy, as before the engine had one.
    fn request(&mut self) {
        self.requests += 1;
        self.push(RecordBody::RequestStarted {
            turn: TurnId::from("t1"),
            request: RequestId(format!("r{}", self.requests)),
            model: model(),
            attempt: 1,
            prefix_digest: String::new(),
        });
    }

    fn reply(&mut self, calls: &[(&str, &str, serde_json::Value)]) -> Seq {
        self.push(RecordBody::AssistantMessage {
            turn: TurnId::from("t1"),
            request: RequestId(format!("r{}", self.requests)),
            blocks: calls
                .iter()
                .map(|(call, name, input)| AssistantBlock::ToolCall {
                    call: ToolCallId::from(*call),
                    name: (*name).into(),
                    input: input.clone(),
                    native: None,
                })
                .collect(),
            stop: StopReason::ToolUse,
            usage: Usage::default(),
        })
    }

    fn result(&mut self, call: &str, content: Vec<ToolResultBlock>) -> Seq {
        self.push(RecordBody::ToolCallFinished {
            turn: TurnId::from("t1"),
            call: ToolCallId::from(call),
            outcome: ToolOutcome::Completed,
            content,
        })
    }

    /// A result stored as the runner returns it.
    fn harness_result(&mut self, call: &str, result: serde_json::Value) -> Seq {
        self.result(call, stored(&result, &[]))
    }

    fn compact(&mut self, through: Seq) {
        self.push(RecordBody::ContextCompacted {
            through,
            summary: "summary".into(),
            usage: Usage::default(),
        });
    }

    /// The result of `call` as the next request shows it.
    fn shown(&self, call: &str) -> Vec<ToolResultBlock> {
        View::new(&self.records)
            .messages()
            .into_iter()
            .find_map(|message| match message {
                blame_engine_core::ports::ModelMessage::ToolResults(results) => results
                    .into_iter()
                    .find(|result| result.call.0 == call)
                    .map(|result| result.content),
                _ => None,
            })
            .expect("the call is shown")
    }

    /// The decoded result of `call` as shown, as JSON text.
    fn shown_result(&self, call: &str) -> String {
        decode(&self.shown(call))
            .expect("a harness result")
            .result
            .to_text()
    }

    fn digest(&self) -> String {
        let view = View::new(&self.records);
        let config = view.config().unwrap();
        request_digest(
            &config.model,
            &config.system_prompt,
            &[],
            config.reasoning,
            &view.messages(),
        )
    }
}

fn model() -> ModelRef {
    testing::config().model
}

/// The blocks the runner returns for `result` (`serde_json` writes keys in
/// order, as the test wrote them, because they are sorted alike), with
/// `images` after the text.
fn stored(result: &serde_json::Value, images: &[BlobRef]) -> Vec<ToolResultBlock> {
    let result = Json::parse(&result.to_string()).unwrap();
    encode(&result, !images.is_empty())
        .into_iter()
        .map(|text| ToolResultBlock::Text { text })
        .chain(
            images
                .iter()
                .map(|blob| ToolResultBlock::Image { blob: blob.clone() }),
        )
        .collect()
}

fn text_of(blocks: &[ToolResultBlock]) -> Vec<&str> {
    blocks
        .iter()
        .map(|block| match block {
            ToolResultBlock::Text { text } => text.as_str(),
            ToolResultBlock::Image { .. } => "<image>",
        })
        .collect()
}

fn lines(range: std::ops::Range<usize>) -> String {
    range
        .map(|n| format!("export const value{n} = {n}; // long enough to count\n"))
        .collect()
}

#[test]
fn a_run_does_not_repeat_its_command_from_its_first_request_on() {
    let mut log = Log::new();
    log.send();
    log.reply(&[(
        "c1",
        "run_task",
        json!({ "kind": "command", "command": "npm test" }),
    )]);
    log.harness_result(
        "c1",
        json!({ "data": { "command": "npm test", "exitCode": 0, "output": "passed" }, "status": "ok" }),
    );
    assert_eq!(log.send().len(), 1);
    assert_eq!(
        log.shown_result("c1"),
        r#"{"data":{"exitCode":0,"output":"passed"},"status":"ok"}"#
    );
    assert!(log.policy().is_empty(), "done once");

    // A result a request already sent as it was stays as it was.
    let mut log = Log::new();
    log.send();
    log.reply(&[("c1", "run_task", json!({ "command": "npm test" }))]);
    log.harness_result(
        "c1",
        json!({ "data": { "command": "npm test" }, "status": "ok" }),
    );
    log.request();
    assert!(log.policy().is_empty());
}

#[test]
fn long_advice_already_shown_is_dropped_from_later_results() {
    let advice = "Narrow the query to one directory or a symbol name; broad searches return \
too many matches to read.";
    let mut log = Log::new();
    log.send();
    log.reply(&[("c1", "search_code", json!({ "query": "a" }))]);
    log.harness_result(
        "c1",
        json!({ "data": { "matches": [] }, "guidance": advice, "status": "ok" }),
    );
    assert!(log.send().is_empty(), "the first one is shown whole");
    log.reply(&[("c2", "read_code", json!({ "target": "b.ts" }))]);
    log.harness_result(
        "c2",
        json!({
            "data": { "note": "short", "nested": { "recovery": advice } },
            "guidance": advice,
            "status": "blocked",
        }),
    );
    log.send();
    assert_eq!(
        log.shown_result("c2"),
        r#"{"data":{"nested":{},"note":"short"},"status":"blocked"}"#
    );
    assert!(log.shown_result("c1").contains(advice));
    assert!(log.policy().is_empty());
}

fn repair_plan() -> serde_json::Value {
    json!({
        "advisoryOnly": true,
        "repairFirst": [{ "input": { "kind": "command", "command": "npm test -- a.test.ts" } }],
        "requiredAfterRepair": [{ "input": { "kind": "project", "task": "typecheck" } }],
        "why": "The last run failed in a.test.ts after the edit of a.ts; rerun that selection \
    first, then the checks that cover the final source, before reporting the task as done. \
    Keep every check the task contract requires; a green run of another selection proves nothing here.",
    })
}

#[test]
fn a_repair_plan_shown_in_full_is_referenced_afterwards() {
    let mut log = Log::new();
    log.send();
    log.reply(&[("c1", "run_task", json!({ "command": "npm test" }))]);
    log.harness_result(
        "c1",
        json!({ "data": { "exitCode": 0, "validationRepair": repair_plan() }, "status": "ok" }),
    );
    log.send();
    log.reply(&[
        ("c2", "run_task", json!({ "command": "npm run lint" })),
        ("c3", "run_task", json!({ "command": "npm test" })),
    ]);
    log.harness_result(
        "c2",
        json!({ "data": { "exitCode": 0, "validationRepair": repair_plan() }, "status": "ok" }),
    );
    // A failed run needs the plan where it is.
    log.harness_result(
        "c3",
        json!({ "data": { "exitCode": 1, "validationRepair": repair_plan() }, "status": "ok" }),
    );
    log.send();
    assert_eq!(
        log.shown_result("c2"),
        format!(
            r#"{{"data":{{"exitCode":0,"validationRepair":{{"kind":"repair_plan_reference","advisoryOnly":true,"fullPlanToolCallId":"c1","instruction":"{}"}}}},"status":"ok"}}"#,
            rules_instruction()
        )
    );
    assert!(log.shown_result("c3").contains("repairFirst"));
    assert!(log.shown_result("c1").contains("repairFirst"));
    assert!(log.policy().is_empty());
}

fn rules_instruction() -> &'static str {
    "Same visible repair plan. Rerun the failed selection before green checks; retain every \
required final-source check. No verification is admitted. read_code @checks returns the full plan."
}

fn whole_read(content: &str) -> serde_json::Value {
    json!({
        "data": { "content": content, "path": "a.ts", "view": "raw" },
        "receipt": "rcpt",
        "status": "ok",
    })
}

#[test]
fn a_large_stale_read_is_replaced_at_once() {
    let big = lines(0..800);
    assert!(big.len() as i64 > BATCH_MIN_SAVING_BYTES);
    let mut log = Log::new();
    log.send();
    log.reply(&[("c1", "read_code", json!({ "target": "a.ts" }))]);
    log.harness_result("c1", whole_read(&big));
    log.send();
    log.reply(&[("c2", "read_code", json!({ "target": "a.ts" }))]);
    log.harness_result("c2", whole_read(&big));
    let edits = log.send();
    assert_eq!(edits.len(), 2, "the stub and the removed source part");
    assert_eq!(
        text_of(&log.shown("c1")),
        [
            r#"{"data":{"path":"a.ts","view":"raw","receipt":"rcpt"},"status":"superseded_by_later_read"}"#
        ]
    );
    assert_eq!(log.shown("c2").len(), 2, "the latest read stays whole");
    assert!(log.policy().is_empty());
}

#[test]
fn a_small_stale_read_waits_for_a_compaction() {
    let small = lines(0..20);
    let mut log = Log::new();
    log.send();
    log.reply(&[("c1", "read_code", json!({ "target": "a.ts" }))]);
    log.harness_result("c1", whole_read(&small));
    log.send();
    log.reply(&[("c2", "read_code", json!({ "target": "a.ts" }))]);
    log.harness_result("c2", whole_read(&small));
    assert!(log.send().is_empty(), "not worth a cache write");
    log.reply(&[]);
    // Compacted up to the user's message: both reads stay in view.
    log.compact(2);
    let edits = log.send();
    assert!(!edits.is_empty());
    assert!(log.shown_result("c1").contains("superseded_by_later_read"));
    assert!(log.policy().is_empty());

    // Nothing at or before the compaction is edited.
    let mut log = Log::new();
    log.send();
    log.reply(&[("c1", "read_code", json!({ "target": "a.ts" }))]);
    let first = log.harness_result("c1", whole_read(&small));
    log.send();
    log.reply(&[("c2", "read_code", json!({ "target": "a.ts" }))]);
    log.harness_result("c2", whole_read(&small));
    log.compact(first);
    assert!(log.policy().iter().all(|edit| edit.target > first));
}

#[test]
fn an_earlier_read_loses_what_a_later_read_repeats() {
    let range = |content: String| {
        json!({
            "data": { "content": content, "path": "a.ts", "view": "range" },
            "receipt": "rcpt",
            "status": "ok",
        })
    };
    let mut log = Log::new();
    log.send();
    log.reply(&[
        (
            "c1",
            "read_code",
            json!({ "target": "a.ts", "range": [1, 20] }),
        ),
        (
            "c2",
            "read_code",
            json!({ "target": "a.ts", "range": [11, 30] }),
        ),
    ]);
    log.harness_result("c1", range(lines(0..20)));
    log.harness_result("c2", range(lines(10..30)));
    log.send();
    let expected = Json::object(vec![
        (
            "data",
            Some(Json::object(vec![
                (
                    "content",
                    Some(Json::str(format!("{}{OVERLAP_MARKER}", lines(0..10)))),
                ),
                ("path", Some(Json::str("a.ts"))),
                ("view", Some(Json::str("range"))),
            ])),
        ),
        ("receipt", Some(Json::str("rcpt"))),
        (
            "status",
            Some(Json::str("partially_superseded_by_later_read")),
        ),
    ]);
    assert_eq!(log.shown_result("c1"), expected.to_text());
    assert_eq!(
        log.shown("c1"),
        stored(&serde_json::from_str(&expected.to_text()).unwrap(), &[]),
        "encoded like any harness result"
    );
    assert!(log.shown_result("c2").contains("value29"));
    assert!(log.policy().is_empty());
}

#[test]
fn a_completed_edit_keeps_its_call_and_shows_a_historical_result() {
    let edit = |path: &str| json!({ "data": { "changes": [{ "path": path, "diff": "+1" }] }, "status": "ok" });
    let mut log = Log::new();
    log.send();
    log.reply(&[
        ("e1", "edit_code", json!({ "path": "a.ts" })),
        ("e2", "edit_code", json!({ "path": "b.ts" })),
    ]);
    log.harness_result("e1", edit("a.ts"));
    log.harness_result("e2", edit("b.ts"));
    assert!(log.send().is_empty(), "the latest edit of each file stays");
    log.reply(&[("c1", "read_code", json!({ "target": "a.ts" }))]);
    log.harness_result("c1", whole_read("export const a = 1;\n"));
    assert!(log.send().is_empty(), "a small rewrite waits");
    log.reply(&[]);
    log.compact(2);
    log.send();
    assert_eq!(
        text_of(&log.shown("e1")),
        [format!(
            "Historical completed edit (not an executable tool call): {}",
            edit("a.ts")
        )]
    );
    // b.ts was not read again: its edit is how the model knows the file.
    assert_eq!(log.shown("e2"), stored(&edit("b.ts"), &[]));
    let calls = View::new(&log.records)
        .messages()
        .iter()
        .filter(|message| {
            matches!(message, blame_engine_core::ports::ModelMessage::Assistant(blocks)
                if blocks.iter().any(|b| matches!(b, AssistantBlock::ToolCall { call, .. } if call.0 == "e1")))
        })
        .count();
    assert_eq!(calls, 1, "the call stays paired with its result");
    assert!(log.policy().is_empty());
}

fn blob(id: u8, bytes: u64) -> BlobRef {
    BlobRef {
        sha256: format!("{id:064x}"),
        media_type: "image/png".into(),
        bytes,
    }
}

const MIB: u64 = 1024 * 1024;

#[test]
fn images_are_sent_once_within_the_limits() {
    let ok = json!({ "status": "ok" });
    let mut log = Log::new();
    log.send();
    log.reply(&[("c1", "read_code", json!({ "target": "a.png" }))]);
    log.result("c1", stored(&ok, &[blob(1, 1000)]));
    log.send();
    log.reply(&[
        ("c2", "read_code", json!({ "target": "a.png" })),
        ("c3", "read_code", json!({ "target": "huge.png" })),
    ]);
    log.result("c2", stored(&ok, &[blob(1, 1000)]));
    log.result("c3", stored(&ok, &[blob(2, 4 * MIB)]));
    log.send();
    assert_eq!(text_of(&log.shown("c1"))[1], "<image>");
    assert_eq!(text_of(&log.shown("c2"))[1], DUPLICATE);
    assert_eq!(text_of(&log.shown("c3"))[1], TOO_LARGE);
    assert!(log.policy().is_empty());
}

#[test]
fn the_image_budget_evicts_the_oldest_in_one_large_step() {
    let ok = json!({ "status": "ok" });
    let mut log = Log::new();
    log.send();
    // 2.5 MiB each, 3.3 MiB once in base64: three are over the 8 MiB budget.
    for (index, call) in ["c1", "c2", "c3"].into_iter().enumerate() {
        log.reply(&[(call, "read_code", json!({ "target": call }))]);
        log.result(call, stored(&ok, &[blob(index as u8 + 1, 5 * MIB / 2)]));
        log.send();
    }
    assert_eq!(text_of(&log.shown("c1"))[1], OMITTED);
    assert_eq!(
        text_of(&log.shown("c2"))[1],
        OMITTED,
        "down to half the budget"
    );
    assert_eq!(text_of(&log.shown("c3"))[1], "<image>");
    assert!(log.policy().is_empty());
    // A new image fits next to the kept one; nothing evicted comes back.
    log.reply(&[("c4", "read_code", json!({ "target": "c4" }))]);
    log.result("c4", stored(&ok, &[blob(4, MIB)]));
    assert!(log.send().is_empty());
    assert_eq!(text_of(&log.shown("c1"))[1], OMITTED);
    assert_eq!(text_of(&log.shown("c4"))[1], "<image>");
}

#[test]
fn the_same_records_give_the_same_request_after_a_reopen() {
    let big = lines(0..800);
    let mut log = Log::new();
    log.send();
    log.reply(&[
        ("c1", "read_code", json!({ "target": "a.ts" })),
        ("c2", "run_task", json!({ "command": "npm test" })),
    ]);
    log.harness_result("c1", whole_read(&big));
    log.harness_result(
        "c2",
        json!({ "data": { "command": "npm test", "validationRepair": repair_plan() }, "status": "ok" }),
    );
    log.send();
    log.reply(&[
        ("c3", "read_code", json!({ "target": "a.ts" })),
        ("c4", "run_task", json!({ "command": "npm test" })),
        ("c5", "read_code", json!({ "target": "a.png" })),
    ]);
    log.harness_result("c3", whole_read(&big));
    log.harness_result(
        "c4",
        json!({ "data": { "command": "npm test", "validationRepair": repair_plan() }, "status": "ok" }),
    );
    log.result("c5", stored(&json!({ "status": "ok" }), &[blob(1, 10)]));
    let edits = log.send();
    let rewritten: std::collections::BTreeSet<Seq> = edits.iter().map(|e| e.target).collect();
    assert_eq!(
        rewritten.len(),
        2,
        "the stale read, and the echo and plan of the new run"
    );
    assert!(log.shown_result("c1").contains("superseded_by_later_read"));
    assert!(log.shown_result("c4").contains("repair_plan_reference"));
    let digest = log.digest();
    // Opening the session again folds the same records: the policy finds
    // nothing new to do, so the next request starts with the same bytes.
    let reopened = Log {
        records: log.records.clone(),
        requests: log.requests,
    };
    assert!(reopened.policy().is_empty());
    assert_eq!(reopened.digest(), digest);
}

/// The policy in a live session: a turn, the session dropped and opened
/// again from its store, another turn.
#[tokio::test]
async fn a_reopened_session_sends_the_prefix_it_sent_before() {
    use blame_engine_core::ports::{ModelMessage, ToolOutput};
    use blame_engine_core::testing::{Behavior, Script, ScriptedProvider, ScriptedTools, World};
    use blame_engine_core::{EngineOptions, Session};
    use std::sync::Arc;

    let big = lines(0..800);
    let tools = ScriptedTools::new(
        vec![testing::spec(
            "read_code",
            blame_engine_protocol::ToolEffect::ReadOnly,
        )],
        move |_, _| {
            Behavior::Output(ToolOutput {
                outcome: ToolOutcome::Completed,
                content: stored(&whole_read(&big), &[]),
            })
        },
    );
    let world = World::new(ScriptedProvider::new()).with_tools(tools);
    world
        .provider
        .push(Script::tool_calls(&[(
            "read_code",
            json!({ "target": "a.ts" }),
        )]))
        .push(Script::tool_calls(&[(
            "read_code",
            json!({ "target": "a.ts" }),
        )]))
        .push(Script::text("read twice"))
        .push(Script::text("again"));
    let ports = || {
        let mut ports = world.ports();
        ports.context_policy = Arc::new(HarnessContextPolicy);
        ports
    };
    let id = blame_engine_protocol::SessionId::from("s1");
    let session = Session::create(
        ports(),
        EngineOptions::default(),
        id.clone(),
        testing::config(),
    )
    .await
    .unwrap();
    session
        .send(
            vec![UserBlock::Text {
                text: "read".into(),
            }],
            Delivery::Turn,
        )
        .await
        .unwrap();
    session.wait_idle().await;
    let edited = |records: &[Record]| {
        records
            .iter()
            .filter(|r| matches!(r.body, RecordBody::ContextEdited { .. }))
            .count()
    };
    let before = session.records().await;
    assert_eq!(edited(&before), 1, "the stale read, replaced");
    drop(session);

    let session = Session::open(ports(), EngineOptions::default(), id)
        .await
        .unwrap();
    session
        .send(
            vec![UserBlock::Text {
                text: "again".into(),
            }],
            Delivery::Turn,
        )
        .await
        .unwrap();
    session.wait_idle().await;
    assert_eq!(edited(&session.records().await), 1, "no edit on reopen");
    let requests = world.provider.request_messages();
    let last_of_first_turn = &requests[2];
    let reopened: &[ModelMessage] = &requests[3];
    assert_eq!(
        &reopened[..last_of_first_turn.len()],
        &last_of_first_turn[..],
        "the reopened session sends the same prefix"
    );
}
