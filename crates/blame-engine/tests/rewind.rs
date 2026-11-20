//! Rewinding a conversation and its files on a real git repository, and
//! undoing the rewind.

mod common;

use blame_engine_protocol::rpc::{ClientRequest, Rewound, ToolResult};
use blame_engine_protocol::{
    Record, RecordBody, ToolEffect, ToolOutcome, ToolResultBlock, ToolSpec, WorkspaceRestore,
};
use common::*;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

fn git(root: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(["-c", "user.email=test@example.com", "-c", "user.name=Test"])
        .args(args)
        .current_dir(root)
        .status()
        .expect("git runs");
    assert!(status.success(), "git {args:?}");
}

fn read(root: &Path, path: &str) -> Option<String> {
    std::fs::read_to_string(root.join(path)).ok()
}

fn ended_at(records: &[Record], nth: usize) -> u64 {
    records
        .iter()
        .filter(|r| matches!(r.body, RecordBody::TurnEnded { .. }))
        .nth(nth)
        .expect("a turn ended")
        .seq
}

#[tokio::test]
async fn a_rewind_puts_the_files_back_and_can_be_undone() {
    let workspace = temp_dir("rewind-repo");
    git(&workspace, &["init", "-q"]);
    std::fs::write(workspace.join("a.txt"), "one\n").unwrap();
    git(&workspace, &["add", "a.txt"]);
    git(&workspace, &["commit", "-q", "-m", "initial"]);

    let mock = mock(vec![
        tool_reply(&[("write", json!({ "path": "a.txt", "text": "two\n" }))]),
        text_reply(&["Changed a."]),
        tool_reply(&[("write", json!({ "path": "b.txt", "text": "new\n" }))]),
        text_reply(&["Added b."]),
        text_reply(&["Fresh start."]),
    ])
    .await;
    let mut client = FakeClient::new(&mock.base);
    // The client's own edit tool, writing into the workspace the engine
    // snapshots.
    let root: PathBuf = workspace.clone();
    client.tool = Box::new(move |_, input: &Value| {
        let path = input["path"].as_str().unwrap();
        std::fs::write(root.join(path), input["text"].as_str().unwrap()).unwrap();
        ToolResult {
            outcome: ToolOutcome::Completed,
            content: vec![ToolResultBlock::Text {
                text: format!("wrote {path}"),
            }],
        }
    });
    let client = Arc::new(client);
    let engine = Engine::ready(&temp_dir("rewind"), &[], client).await;
    let mut config = config(&workspace);
    config.checkpoints = true;
    config.client_tools = vec![ToolSpec {
        name: "write".into(),
        description: "Writes a file.".into(),
        input_schema: json!({"type": "object"}),
        effect: ToolEffect::WorkspaceWrite,
        ends_turn: false,
        needs_approval: false,
    }];
    let session = engine.create(config).await;
    engine.subscribe(&session, 0).await;
    engine.send(&session, "change a").await;
    engine.until_turn_ended().await;
    engine.send(&session, "add b").await;
    engine.until_turn_ended().await;
    assert_eq!(read(&workspace, "a.txt").as_deref(), Some("two\n"));
    assert_eq!(read(&workspace, "b.txt").as_deref(), Some("new\n"));

    // Back to the end of the first turn: b.txt goes, a.txt stays changed.
    let records = engine.records(&session).await;
    let first_end = ended_at(&records, 0);
    let rewound: Rewound = engine
        .call(ClientRequest::Rewind {
            session: session.clone(),
            to: first_end,
            restore_workspace: true,
        })
        .await;
    assert_eq!(read(&workspace, "a.txt").as_deref(), Some("two\n"));
    assert_eq!(read(&workspace, "b.txt"), None);
    let records = engine.records(&session).await;
    let finished = &records[rewound.finished as usize - 1];
    assert!(
        matches!(
            &finished.body,
            RecordBody::RewindFinished { to, workspace: WorkspaceRestore::Restored, .. } if *to == first_end
        ),
        "{finished:?}"
    );

    // Undone: the second turn and its file are back.
    let _: Value = engine
        .call(ClientRequest::UndoRewind {
            session: session.clone(),
        })
        .await;
    assert_eq!(read(&workspace, "b.txt").as_deref(), Some("new\n"));
    assert_eq!(read(&workspace, "a.txt").as_deref(), Some("two\n"));

    // All the way back: the files as committed, nothing the agent did left.
    let _: Rewound = engine
        .call(ClientRequest::Rewind {
            session: session.clone(),
            to: 1,
            restore_workspace: true,
        })
        .await;
    assert_eq!(read(&workspace, "a.txt").as_deref(), Some("one\n"));
    assert_eq!(read(&workspace, "b.txt"), None);
    let status = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(&workspace)
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&status.stdout), "", "a clean tree");

    // The model sees only what is in effect after the rewind.
    engine.send(&session, "start over").await;
    engine
        .until_record(|r| {
            matches!(r.body, RecordBody::TurnEnded { .. }) && r.seq > rewound.finished
        })
        .await;
    let last = sent_messages(&mock).pop().unwrap();
    let texts = last.to_string();
    assert!(texts.contains("start over"));
    assert!(
        !texts.contains("change a") && !texts.contains("add b"),
        "{texts}"
    );
    assert!(engine.shutdown().await.success());
}
