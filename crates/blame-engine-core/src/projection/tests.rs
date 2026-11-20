use super::*;
use blame_engine_protocol::{
    ApprovalDecision, ContextEdit, Delivery, ErrorInfo, Usage, WorkspaceRestore,
};

fn config() -> SessionConfig {
    SessionConfig {
        purpose: "development".into(),
        workspace_root: "/w".into(),
        model: ModelRef {
            provider: "p".into(),
            model: "m".into(),
        },
        reasoning: None,
        system_prompt: "system".into(),
        max_output_tokens: None,
        engine_tools: Vec::new(),
        client_tools: Vec::new(),
        tool_options: Default::default(),
        limits: Default::default(),
        checkpoints: false,
        kind: Default::default(),
        contract: None,
    }
}

/// A log from bodies, numbered from 1.
fn log(bodies: Vec<RecordBody>) -> Vec<Record> {
    std::iter::once(RecordBody::SessionCreated {
        config: Box::new(config()),
    })
    .chain(bodies)
    .enumerate()
    .map(|(index, body)| Record {
        seq: index as u64 + 1,
        at_ms: 0,
        body,
    })
    .collect()
}

fn t(id: &str) -> TurnId {
    TurnId::from(id)
}

fn user(turn: &str, text: &str) -> RecordBody {
    RecordBody::UserMessage {
        turn: t(turn),
        input: vec![UserBlock::Text { text: text.into() }],
        delivery: Delivery::Turn,
    }
}

fn steer(turn: &str, text: &str) -> RecordBody {
    RecordBody::UserMessage {
        turn: t(turn),
        input: vec![UserBlock::Text { text: text.into() }],
        delivery: Delivery::Steer,
    }
}

fn started(turn: &str, request: &str, attempt: u32) -> RecordBody {
    RecordBody::RequestStarted {
        turn: t(turn),
        request: RequestId::from(request),
        model: config().model,
        attempt,
        prefix_digest: String::new(),
    }
}

fn failed(turn: &str, request: &str, kind: ErrorKind) -> RecordBody {
    RecordBody::RequestFailed {
        turn: t(turn),
        request: RequestId::from(request),
        error: ErrorInfo {
            kind,
            message: "x".into(),
            retry_after_ms: None,
        },
    }
}

fn text_block(text: &str) -> AssistantBlock {
    AssistantBlock::Text {
        text: text.into(),
        native: None,
    }
}

fn call_block(call: &str, name: &str) -> AssistantBlock {
    AssistantBlock::ToolCall {
        call: ToolCallId::from(call),
        name: name.into(),
        input: json!({ "path": call }),
        native: None,
    }
}

fn reply(turn: &str, request: &str, blocks: Vec<AssistantBlock>) -> RecordBody {
    RecordBody::AssistantMessage {
        turn: t(turn),
        request: RequestId::from(request),
        blocks,
        stop: StopReason::EndTurn,
        usage: Usage::default(),
    }
}

fn finished(turn: &str, call: &str, outcome: ToolOutcome, text: &str) -> RecordBody {
    RecordBody::ToolCallFinished {
        turn: t(turn),
        call: ToolCallId::from(call),
        outcome,
        content: vec![ToolResultBlock::Text { text: text.into() }],
    }
}

fn ended(turn: &str) -> RecordBody {
    RecordBody::TurnEnded {
        turn: t(turn),
        outcome: blame_engine_protocol::TurnOutcome::Completed,
    }
}

fn u(text: &str) -> ModelMessage {
    ModelMessage::User(vec![UserBlock::Text { text: text.into() }])
}

fn a(text: &str) -> ModelMessage {
    ModelMessage::Assistant(vec![text_block(text)])
}

fn result(call: &str, outcome: ToolOutcome, text: &str) -> ToolResultMessage {
    ToolResultMessage {
        call: ToolCallId::from(call),
        outcome,
        content: vec![ToolResultBlock::Text { text: text.into() }],
    }
}

fn texts(message: &ModelMessage) -> Vec<String> {
    match message {
        ModelMessage::User(blocks) => blocks
            .iter()
            .map(|b| match b {
                UserBlock::Text { text } => text.clone(),
                _ => "?".into(),
            })
            .collect(),
        _ => panic!("not a user message: {message:?}"),
    }
}

#[test]
fn failed_requests_are_never_shown_and_results_follow_call_order() {
    let records = log(vec![
        user("t1", "hi"),
        started("t1", "r1", 1),
        failed("t1", "r1", ErrorKind::Overloaded),
        started("t1", "r1", 2),
        reply(
            "t1",
            "r1",
            vec![
                text_block("reading"),
                call_block("c1", "read"),
                call_block("c2", "read"),
                call_block("c3", "write"),
            ],
        ),
        // Finished out of order, one denied, one never answered.
        finished("t1", "c2", ToolOutcome::Failed, "nope"),
        finished("t1", "c1", ToolOutcome::Completed, "one"),
        started("t1", "r2", 1),
        reply("t1", "r2", vec![text_block("done")]),
        ended("t1"),
    ]);
    let messages = View::new(&records).messages();
    assert_eq!(
        messages,
        vec![
            u("hi"),
            ModelMessage::Assistant(vec![
                text_block("reading"),
                call_block("c1", "read"),
                call_block("c2", "read"),
                call_block("c3", "write"),
            ]),
            ModelMessage::ToolResults(vec![
                result("c1", ToolOutcome::Completed, "one"),
                result("c2", ToolOutcome::Failed, "nope"),
                result("c3", ToolOutcome::Cancelled, MISSING_RESULT),
            ]),
            a("done"),
        ]
    );
}

#[test]
fn every_outcome_reaches_the_model_as_stored() {
    let outcomes = [
        ToolOutcome::Completed,
        ToolOutcome::Failed,
        ToolOutcome::Denied,
        ToolOutcome::Cancelled,
        ToolOutcome::Interrupted,
    ];
    let mut bodies = vec![
        user("t1", "go"),
        started("t1", "r1", 1),
        reply(
            "t1",
            "r1",
            (0..outcomes.len())
                .map(|i| call_block(&format!("c{i}"), "tool"))
                .collect(),
        ),
    ];
    for (i, outcome) in outcomes.iter().enumerate() {
        bodies.push(finished("t1", &format!("c{i}"), *outcome, "r"));
    }
    let records = log(bodies);
    let messages = View::new(&records).messages();
    let ModelMessage::ToolResults(results) = &messages[2] else {
        panic!("{messages:?}")
    };
    assert_eq!(
        results.iter().map(|r| r.outcome).collect::<Vec<_>>(),
        outcomes
    );
}

#[test]
fn a_steer_is_delivered_at_the_next_request_after_the_tool_results() {
    let records = log(vec![
        user("t1", "task"),
        started("t1", "r1", 1),
        // Arrives while the reply streams.
        steer("t1", "also this"),
        reply("t1", "r1", vec![call_block("c1", "read")]),
        steer("t1", "and that"),
        finished("t1", "c1", ToolOutcome::Completed, "file"),
        started("t1", "r2", 1),
    ]);
    let view = View::new(&records);
    let sent = view.messages_through(7);
    assert_eq!(sent.len(), 4);
    assert!(matches!(sent[1], ModelMessage::Assistant(_)));
    assert!(matches!(sent[2], ModelMessage::ToolResults(_)));
    assert_eq!(texts(&sent[3]), ["also this", "and that"]);
    // A steer not yet sent is part of the next request.
    let mut more = records.clone();
    more.push(Record {
        seq: 9,
        at_ms: 0,
        body: steer("t1", "later"),
    });
    let next = View::new(&more).messages();
    assert_eq!(
        texts(next.last().unwrap()),
        ["also this", "and that", "later"]
    );
    assert!(!View::new(&records).turn_state(&t("t1")).steer_pending);
    assert!(View::new(&more).turn_state(&t("t1")).steer_pending);
}

#[test]
fn a_queued_turn_joins_the_history_when_the_running_turn_ends() {
    let records = log(vec![
        user("t1", "first"),
        started("t1", "r1", 1),
        user("t2", "second"),
        reply("t1", "r1", vec![text_block("one")]),
    ]);
    let view = View::new(&records);
    assert_eq!(view.open_turns(), [&t("t1"), &t("t2")]);
    assert_eq!(view.messages(), vec![u("first"), a("one")]);

    let mut records = records;
    for body in [ended("t1"), started("t2", "r2", 1)] {
        let seq = records.len() as u64 + 1;
        records.push(Record {
            seq,
            at_ms: 0,
            body,
        });
    }
    let view = View::new(&records);
    assert_eq!(view.open_turns(), [&t("t2")]);
    assert_eq!(view.messages(), vec![u("first"), a("one"), u("second")]);
}

#[test]
fn turns_without_a_reply_merge_into_one_user_message() {
    let records = log(vec![
        user("t1", "first"),
        started("t1", "r1", 1),
        failed("t1", "r1", ErrorKind::Authentication),
        RecordBody::TurnEnded {
            turn: t("t1"),
            outcome: blame_engine_protocol::TurnOutcome::Interrupted,
        },
        user("t2", "second"),
    ]);
    let messages = View::new(&records).messages();
    assert_eq!(messages.len(), 1);
    assert_eq!(texts(&messages[0]), ["first", "second"]);
}

fn rewind_records(to: Seq, started_at: Seq) -> [RecordBody; 2] {
    [
        RecordBody::RewindStarted {
            to,
            checkpoint: None,
            undo_snapshot: None,
        },
        RecordBody::RewindFinished {
            started: started_at,
            to,
            workspace: WorkspaceRestore::NotRequested,
            unreverted_commands: Vec::new(),
        },
    ]
}

#[test]
fn a_rewind_removes_what_follows_and_an_undo_puts_it_back() {
    let mut bodies = vec![
        user("t1", "first"),                        // 2
        started("t1", "r1", 1),                     // 3
        reply("t1", "r1", vec![text_block("one")]), // 4
        ended("t1"),                                // 5
        user("t2", "second"),                       // 6
        started("t2", "r2", 1),                     // 7
        reply("t2", "r2", vec![text_block("two")]), // 8
        ended("t2"),                                // 9
    ];
    bodies.extend(rewind_records(5, 10)); // 10, 11
    let rewound = log(bodies.clone());
    assert_eq!(View::new(&rewound).messages(), vec![u("first"), a("one")]);

    let mut undone = bodies.clone();
    undone.push(RecordBody::RewindUndone { rewind: 11 });
    let undone = log(undone);
    assert_eq!(
        View::new(&undone).messages(),
        vec![u("first"), a("one"), u("second"), a("two")]
    );

    // An undo that is not right after its rewind does nothing.
    let mut late = bodies;
    late.push(user("t3", "third"));
    late.push(RecordBody::RewindUndone { rewind: 11 });
    let late = log(late);
    assert_eq!(
        View::new(&late).messages(),
        vec![u("first"), a("one"), u("third")]
    );
}

#[test]
fn rewinds_nest_and_the_first_turn_can_be_rewound() {
    let mut bodies = vec![
        user("t1", "first"),                        // 2
        started("t1", "r1", 1),                     // 3
        reply("t1", "r1", vec![text_block("one")]), // 4
        ended("t1"),                                // 5
    ];
    bodies.extend(rewind_records(1, 6)); // 6, 7
    bodies.push(user("t2", "again")); // 8
    bodies.push(started("t2", "r2", 1)); // 9
    bodies.push(reply("t2", "r2", vec![text_block("two")])); // 10
    bodies.push(ended("t2")); // 11
    bodies.extend(rewind_records(9, 12)); // 12, 13: cuts t2 mid-turn
    let records = log(bodies);
    let view = View::new(&records);
    assert_eq!(view.messages(), vec![u("again")]);
    assert!(view.open_turns().is_empty(), "the cut ends the turn");
}

#[test]
fn a_cut_in_the_middle_of_a_tool_exchange_still_answers_every_call() {
    let mut bodies = vec![
        user("t1", "go"),                                  // 2
        started("t1", "r1", 1),                            // 3
        reply("t1", "r1", vec![call_block("c1", "read")]), // 4
        finished("t1", "c1", ToolOutcome::Completed, "x"), // 5
        ended("t1"),                                       // 6
    ];
    bodies.extend(rewind_records(4, 7));
    bodies.push(user("t2", "next"));
    let records = log(bodies);
    let messages = View::new(&records).messages();
    assert_eq!(
        messages[2],
        ModelMessage::ToolResults(vec![result("c1", ToolOutcome::Cancelled, MISSING_RESULT)])
    );
    assert_eq!(messages[3], u("next"));
}

#[test]
fn a_compaction_replaces_what_it_covers_and_a_rewind_before_it_undoes_it() {
    let mut bodies = vec![
        user("t1", "first"),                               // 2
        started("t1", "r1", 1),                            // 3
        reply("t1", "r1", vec![call_block("c1", "read")]), // 4
        finished("t1", "c1", ToolOutcome::Completed, "x"), // 5
        started("t1", "r2", 1),                            // 6
        reply("t1", "r2", vec![text_block("one")]),        // 7
        ended("t1"),                                       // 8
        user("t2", "second"),                              // 9
        RecordBody::ContextCompacted {
            through: 8,
            summary: "they said first".into(),
            usage: Usage::default(),
        }, // 10
        started("t2", "r3", 1),                            // 11
    ];
    let records = log(bodies.clone());
    let view = View::new(&records);
    let messages = view.messages();
    assert_eq!(messages.len(), 1);
    assert_eq!(
        texts(&messages[0]),
        [
            format!("{SUMMARY_PREAMBLE}they said first"),
            "second".into()
        ]
    );
    // The summary input was the history it replaces.
    assert_eq!(View::new(&records[..9]).messages_through(8).len(), 4);

    bodies.extend(rewind_records(8, 12));
    let records = log(bodies);
    let messages = View::new(&records).messages();
    assert_eq!(messages.len(), 4, "the compacted turn is back verbatim");
}

#[test]
fn edits_change_how_blocks_are_shown_until_rewound() {
    let mut bodies = vec![
        user("t1", "first"),    // 2
        started("t1", "r1", 1), // 3
        reply(
            "t1",
            "r1",
            vec![text_block("thinking"), call_block("c1", "read")],
        ), // 4
        finished("t1", "c1", ToolOutcome::Completed, "a long file"), // 5
        RecordBody::ContextEdited {
            edits: vec![
                ContextEdit {
                    target: 5,
                    block: 0,
                    replacement: "[file elided]".into(),
                },
                ContextEdit {
                    target: 4,
                    block: 1,
                    replacement: "ignored: calls keep their shape".into(),
                },
                ContextEdit {
                    target: 2,
                    block: 0,
                    replacement: "first, edited".into(),
                },
            ],
        }, // 6
    ];
    let records = log(bodies.clone());
    let messages = View::new(&records).messages();
    assert_eq!(texts(&messages[0]), ["first, edited"]);
    assert_eq!(
        messages[1],
        ModelMessage::Assistant(vec![text_block("thinking"), call_block("c1", "read")])
    );
    assert_eq!(
        messages[2],
        ModelMessage::ToolResults(vec![result("c1", ToolOutcome::Completed, "[file elided]")])
    );
    bodies.extend(rewind_records(5, 7));
    let records = log(bodies);
    let messages = View::new(&records).messages();
    assert_eq!(texts(&messages[0]), ["first"]);
}

#[test]
fn an_empty_edit_removes_a_block_and_the_latest_edit_wins() {
    let multipart = RecordBody::ToolCallFinished {
        turn: t("t1"),
        call: ToolCallId::from("c1"),
        outcome: ToolOutcome::Completed,
        content: vec![
            ToolResultBlock::Text {
                text: "header".into(),
            },
            ToolResultBlock::Text {
                text: "section".into(),
            },
        ],
    };
    let edit = |block, replacement: &str| ContextEdit {
        target: 5,
        block,
        replacement: replacement.into(),
    };
    let records = log(vec![
        user("t1", "first"),                               // 2
        started("t1", "r1", 1),                            // 3
        reply("t1", "r1", vec![call_block("c1", "read")]), // 4
        multipart,                                         // 5
        RecordBody::ContextEdited {
            edits: vec![edit(0, "stub one")],
        }, // 6
        RecordBody::ContextEdited {
            edits: vec![edit(0, "stub two"), edit(1, "")],
        }, // 7
    ]);
    let view = View::new(&records);
    assert_eq!(view.edit_of(5, 0), Some("stub two"));
    assert_eq!(view.edit_of(5, 1), Some(""));
    assert_eq!(view.edit_of(4, 0), None);
    assert_eq!(
        view.result_record(&ToolCallId::from("c1")).map(|r| r.seq),
        Some(5)
    );
    assert_eq!(view.result_record(&ToolCallId::from("c2")), None);
    assert_eq!(
        view.messages()[2],
        ModelMessage::ToolResults(vec![result("c1", ToolOutcome::Completed, "stub two")])
    );
}

#[test]
fn the_configuration_follows_changes_and_rewinds() {
    let mut changed = config();
    changed.system_prompt = "other".into();
    let mut bodies = vec![RecordBody::ConfigChanged {
        config: Box::new(changed),
    }];
    let records = log(bodies.clone());
    assert_eq!(View::new(&records).config().unwrap().system_prompt, "other");
    bodies.extend(rewind_records(1, 3));
    let records = log(bodies);
    assert_eq!(
        View::new(&records).config().unwrap().system_prompt,
        "system"
    );
}

#[test]
fn the_same_records_give_the_same_digest() {
    let build = || {
        log(vec![
            user("t1", "hi"),
            started("t1", "r1", 1),
            reply("t1", "r1", vec![call_block("c1", "read")]),
            finished("t1", "c1", ToolOutcome::Completed, "x"),
        ])
    };
    let digest = |records: &[Record]| {
        let view = View::new(records);
        let config = view.config().unwrap();
        request_digest(
            &config.model,
            &config.system_prompt,
            &[],
            config.reasoning,
            &view.messages(),
        )
    };
    let first = digest(&build());
    assert_eq!(first, digest(&build()));
    assert!(first.starts_with("sha256:") && first.len() == 71);
    let mut other = build();
    other.push(Record {
        seq: 6,
        at_ms: 0,
        body: steer("t1", "x"),
    });
    assert_ne!(first, digest(&other));
}

#[test]
fn turn_state_tracks_attempts_calls_and_approvals() {
    let records = log(vec![
        user("t1", "go"),                               // 2
        started("t1", "r1", 1),                         // 3
        failed("t1", "r1", ErrorKind::ContextOverflow), // 4
        started("t1", "r1", 2),                         // 5
        reply(
            "t1",
            "r1",
            vec![call_block("c1", "deploy"), call_block("c2", "read")],
        ),
        RecordBody::ApprovalRequested {
            turn: t("t1"),
            call: ToolCallId::from("c1"),
        },
        RecordBody::ApprovalResolved {
            turn: t("t1"),
            call: ToolCallId::from("c1"),
            decision: ApprovalDecision::Approved,
        },
        RecordBody::ToolCallStarted {
            turn: t("t1"),
            call: ToolCallId::from("c1"),
            name: "deploy".into(),
            effect: ToolEffect::External,
        },
    ]);
    let view = View::new(&records);
    let state = view.turn_state(&t("t1"));
    assert_eq!(state.requests, 1);
    let last = state.last_request.as_ref().unwrap();
    assert_eq!((last.attempt, last.overflows), (2, 1));
    assert!(matches!(
        last.outcome,
        RequestOutcome::Replied {
            has_calls: true,
            ..
        }
    ));
    assert_eq!(state.calls.len(), 2);
    assert_eq!(state.calls[0].approval, ApprovalState::Approved);
    assert_eq!(state.calls[0].starts, 1);
    assert_eq!(state.pending_calls().count(), 2);
    assert_eq!(
        unreverted_commands(&view, 2),
        vec![describe_call("deploy", &json!({ "path": "c1" }))]
    );
}

#[test]
fn breakpoints_mark_this_request_and_the_previous_one() {
    assert!(cache_breakpoints(&[]).is_empty());
    assert_eq!(cache_breakpoints(&[u("a")]), vec![0]);
    assert_eq!(cache_breakpoints(&[u("a"), a("b"), u("c")]), vec![0, 2]);
}

#[test]
fn a_compaction_cut_keeps_a_tail_and_starts_a_step() {
    let records = log(vec![
        user("t1", "first"),                        // 2
        started("t1", "r1", 1),                     // 3
        reply("t1", "r1", vec![text_block("one")]), // 4
        ended("t1"),                                // 5
        user("t2", "second"),                       // 6
        started("t2", "r2", 1),                     // 7
        reply("t2", "r2", vec![text_block("two")]), // 8
    ]);
    let view = View::new(&records);
    assert_eq!(
        view.compaction_cut(0),
        Some(6),
        "summarise up to the last step"
    );
    assert_eq!(
        view.compaction_cut(1_000_000),
        Some(2),
        "keep as much as possible"
    );
    let tiny = log(vec![user("t1", "only")]);
    assert_eq!(View::new(&tiny).compaction_cut(0), None);
}

#[test]
fn the_checkpoint_for_a_rewind_is_the_first_one_with_no_write_before_it() {
    let checkpoint = |turn: &str, id: &str| RecordBody::CheckpointCreated {
        turn: t(turn),
        checkpoint: blame_engine_protocol::CheckpointId::from(id),
        snapshot: format!("snap-{id}"),
    };
    let write = RecordBody::ToolCallStarted {
        turn: t("t1"),
        call: ToolCallId::from("c1"),
        name: "write".into(),
        effect: ToolEffect::WorkspaceWrite,
    };
    let records = log(vec![
        user("t1", "first"),    // 2
        checkpoint("t1", "k1"), // 3
        write,                  // 4
        ended("t1"),            // 5
        user("t2", "second"),   // 6
        checkpoint("t2", "k2"), // 7
    ]);
    let view = View::new(&records);
    assert_eq!(
        checkpoint_for(&view, 1),
        Some(Some(("k1".into(), "snap-k1".into())))
    );
    assert_eq!(checkpoint_for(&view, 3), None, "a write comes first");
    assert_eq!(
        checkpoint_for(&view, 5),
        Some(Some(("k2".into(), "snap-k2".into())))
    );
    assert_eq!(checkpoint_for(&view, 7), Some(None));
}
