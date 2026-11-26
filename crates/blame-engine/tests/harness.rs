//! The harness as a child process of the engine: against a fake runner that
//! speaks the runner's protocol, and against the real one when it is built.

mod common;

use blame_engine_protocol::rpc::ClientRequest;
use blame_engine_protocol::{Record, RecordBody, ToolOutcome, ToolResultBlock, TurnOutcome};
use common::*;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

fn node() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join("node"))
        .find(|candidate| candidate.is_file())
}

fn harness_args(command: &[&str]) -> String {
    serde_json::to_string(command).unwrap()
}

fn harness_config(workspace: &Path) -> blame_engine_protocol::SessionConfig {
    let mut config = config(workspace);
    config.engine_tools = vec!["harness".into()];
    config.client_tools = Vec::new();
    config.tool_options.insert(
        "harness".into(),
        json!({ "taskContract": { "objective": "test the harness" } }),
    );
    config
}

fn results(records: &[Record]) -> Vec<(ToolOutcome, Vec<ToolResultBlock>)> {
    records
        .iter()
        .filter_map(|r| match &r.body {
            RecordBody::ToolCallFinished {
                outcome, content, ..
            } => Some((*outcome, content.clone())),
            _ => None,
        })
        .collect()
}

fn runner_log(path: &Path) -> Vec<Value> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

fn tool_names(request: &Value) -> Vec<String> {
    request["tools"]
        .as_array()
        .map(|tools| {
            tools
                .iter()
                .map(|t| t["name"].as_str().unwrap().to_owned())
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::test]
async fn the_harness_runs_as_a_child_restarts_and_ends_the_turn() {
    let Some(node) = node() else {
        eprintln!("skipped: node is not on PATH");
        return;
    };
    let dir = temp_dir("harness-fake");
    let log = dir.join("runner.log");
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-runner.mjs");
    let command = harness_args(&[
        node.to_str().unwrap(),
        script.to_str().unwrap(),
        log.to_str().unwrap(),
    ]);
    let mock = mock(vec![
        tool_reply(&[("read_code", json!({ "target": "a.ts" }))]),
        tool_reply(&[("crash", json!({}))]),
        tool_reply(&[(
            "edit_code",
            json!({ "path": "out.txt", "text": "made by the harness" }),
        )]),
        tool_reply(&[("finish_task", json!({ "summary": "all done" }))]),
    ])
    .await;
    let client = Arc::new(FakeClient::new(&mock.base));
    let engine = Engine::ready(&dir.join("data"), &["--harness-command", &command], client).await;
    let workspace = temp_dir("harness-fake-workspace");
    let session = engine.create(harness_config(&workspace)).await;
    engine.subscribe(&session, 0).await;
    engine.send(&session, "go").await;
    let records = records_of(&engine.until_turn_ended().await);

    let results = results(&records);
    assert_eq!(results.len(), 4);
    // Text and an image, the image kept as a blob.
    assert_eq!(results[0].0, ToolOutcome::Completed);
    assert!(matches!(
        &results[0].1[..],
        [ToolResultBlock::Text { text }, ToolResultBlock::Image { blob }]
            if text.contains("blame_tool_result_v2") && blob.media_type == "image/png"
    ));
    // The harness died during the call: unknown, and restarted for the next.
    assert_eq!(results[1].0, ToolOutcome::Interrupted);
    assert_eq!(results[2].0, ToolOutcome::Completed);
    assert_eq!(
        std::fs::read_to_string(workspace.join("out.txt")).unwrap(),
        "made by the harness"
    );
    assert!(
        matches!(&results[3].1[..], [ToolResultBlock::Text { text }] if text == "Done: all done")
    );
    // finish_task ends the turn: no request after it.
    assert!(matches!(
        &records.last().unwrap().body,
        RecordBody::TurnEnded {
            outcome: TurnOutcome::Completed,
            ..
        }
    ));
    let requests = mock.requests();
    assert_eq!(requests.len(), 4);
    assert_eq!(
        tool_names(&requests[0].body),
        [
            "ask_client",
            "crash",
            "edit_code",
            "finish_task",
            "read_code",
            "slow"
        ],
        "described by the harness, in a stable order"
    );
    let described = requests[0].body["tools"].to_string();
    assert!(
        described.contains(&format!("Reads code for {session}.")),
        "{described}"
    );
    // The image reached the model as an image.
    assert!(requests[1].body.to_string().contains("iVBORw0KGgo"));

    let messages = runner_log(&log);
    let starts = messages
        .iter()
        .filter(|m| m.get("started").is_some())
        .count();
    assert_eq!(starts, 2, "started again after it died");
    let call = messages
        .iter()
        .find(|m| m["call"]["tool"] == "read_code")
        .unwrap();
    assert_eq!(
        call["call"]["workspaceRoot"],
        workspace.display().to_string()
    );
    assert_eq!(
        call["call"]["taskContract"]["objective"],
        "test the harness"
    );
    assert_eq!(call["call"]["taskContract"]["session_id"], session.0);
    assert_eq!(call["call"]["toolContext"]["sessionId"], session.0);

    assert!(engine.shutdown().await.success());
    let stopped = runner_log(&log)
        .iter()
        .filter(|m| m.get("stopped").is_some())
        .count();
    assert_eq!(stopped, 1, "the engine stops its harness when it stops");
}

#[tokio::test]
async fn an_interrupt_cancels_the_harness_call() {
    let Some(node) = node() else {
        eprintln!("skipped: node is not on PATH");
        return;
    };
    let dir = temp_dir("harness-cancel");
    let log = dir.join("runner.log");
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-runner.mjs");
    let command = harness_args(&[
        node.to_str().unwrap(),
        script.to_str().unwrap(),
        log.to_str().unwrap(),
    ]);
    let mock = mock(vec![tool_reply(&[("slow", json!({}))])]).await;
    let client = Arc::new(FakeClient::new(&mock.base));
    let engine = Engine::ready(&dir.join("data"), &["--harness-command", &command], client).await;
    let session = engine
        .create(harness_config(&temp_dir("harness-cancel-workspace")))
        .await;
    engine.subscribe(&session, 0).await;
    engine.send(&session, "go").await;
    engine
        .until_record(|r| matches!(r.body, RecordBody::ToolCallStarted { .. }))
        .await;
    let _: Value = engine
        .call(ClientRequest::Interrupt {
            session: session.clone(),
        })
        .await;
    let records = records_of(&engine.until_turn_ended().await);
    assert_eq!(results(&records)[0].0, ToolOutcome::Cancelled);
    assert!(matches!(
        &records.last().unwrap().body,
        RecordBody::TurnEnded {
            outcome: TurnOutcome::Interrupted,
            ..
        }
    ));
    assert!(
        runner_log(&log).iter().any(|m| m["cancel"] == true),
        "the runner was told to stop"
    );
    assert!(engine.shutdown().await.success());
}

#[tokio::test]
async fn harness_calls_carry_the_context_generation() {
    let Some(node) = node() else {
        eprintln!("skipped: node is not on PATH");
        return;
    };
    let dir = temp_dir("harness-generation");
    let log = dir.join("runner.log");
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-runner.mjs");
    let command = harness_args(&[
        node.to_str().unwrap(),
        script.to_str().unwrap(),
        log.to_str().unwrap(),
    ]);
    let mock = mock(vec![
        tool_reply(&[("read_code", json!({ "target": "a.ts" }))]),
        text_reply(&["read it"]),
        text_reply(&["the summary"]),
        tool_reply(&[("read_code", json!({ "target": "a.ts" }))]),
        text_reply(&["read it again"]),
    ])
    .await;
    let client = Arc::new(FakeClient::new(&mock.base));
    let engine = Engine::ready(&dir.join("data"), &["--harness-command", &command], client).await;
    let session = engine
        .create(harness_config(&temp_dir("harness-generation-workspace")))
        .await;
    engine.subscribe(&session, 0).await;
    engine.send(&session, "read").await;
    engine.until_turn_ended().await;
    let _: Value = engine
        .call(ClientRequest::Compact {
            session: session.clone(),
        })
        .await;
    engine.send(&session, "read again").await;
    engine.until_turn_ended().await;

    let through = engine
        .records(&session)
        .await
        .iter()
        .find_map(|r| match &r.body {
            RecordBody::ContextCompacted { through, .. } => Some(*through),
            _ => None,
        })
        .expect("compacted");
    let generations: Vec<Value> = runner_log(&log)
        .iter()
        .filter(|m| m["call"]["tool"] == "read_code")
        .map(|m| m["call"]["toolContext"]["metadata"]["contextGeneration"].clone())
        .collect();
    // A read before the compaction no longer counts as in context after it.
    assert_eq!(
        generations,
        [json!("initial"), json!(format!("compaction:{through}"))]
    );
    assert!(engine.shutdown().await.success());
}

/// `blame-harness`, built next to this test (`cargo build -p blame-harness`).
fn real_harness() -> Option<PathBuf> {
    let name = if cfg!(windows) {
        "blame-harness.exe"
    } else {
        "blame-harness"
    };
    // The test binary sits in `target/<profile>/deps/` or, with newer Cargo,
    // in `target/<profile>/build/<crate>/<hash>/out/`: the harness is in the
    // profile directory above either.
    std::env::current_exe()
        .ok()?
        .ancestors()
        .skip(1)
        .map(|dir| dir.join(name))
        .find(|binary| binary.is_file())
}

#[tokio::test]
async fn harness_questions_reach_the_client_and_back() {
    let Some(node) = node() else {
        eprintln!("skipped: node is not on PATH");
        return;
    };
    let dir = temp_dir("harness-asks");
    let log = dir.join("runner.log");
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-runner.mjs");
    let command = harness_args(&[
        node.to_str().unwrap(),
        script.to_str().unwrap(),
        log.to_str().unwrap(),
    ]);
    let mock = mock(vec![
        tool_reply(&[("ask_client", json!({}))]),
        tool_reply(&[("finish_task", json!({ "summary": "asked" }))]),
    ])
    .await;
    let client = Arc::new(FakeClient::new(&mock.base));
    let engine = Engine::ready(
        &dir.join("data"),
        &["--harness-command", &command],
        client.clone(),
    )
    .await;
    let workspace = temp_dir("harness-asks-workspace");
    let session = engine.create(harness_config(&workspace)).await;
    engine.subscribe(&session, 0).await;
    engine.send(&session, "ask").await;
    let records = records_of(&engine.until_turn_ended().await);
    let results = results(&records);
    let text = match &results[0].1[..] {
        [ToolResultBlock::Text { text }] => text.clone(),
        other => panic!("{other:?}"),
    };
    assert!(text.contains("granted-by-the-client"), "{text}");
    let asks = client.harness_asks.lock().unwrap().clone();
    assert_eq!(asks.len(), 1);
    assert_eq!(asks[0].0, session);
    assert_eq!(asks[0].1, "commandCredentials");
    assert!(engine.shutdown().await.success());
}

#[tokio::test]
async fn the_real_harness_describes_its_tools_and_reads_code() {
    let Some(harness) = real_harness() else {
        eprintln!("skipped: blame-harness is not built");
        return;
    };
    let command = harness_args(&[harness.to_str().unwrap(), "serve", "--asks"]);
    let mock = mock(vec![
        tool_reply(&[("read_code", json!({ "target": "note.txt", "view": "raw" }))]),
        // A command gets the GitHub token the client grants.
        tool_reply(&[(
            "run_task",
            json!({ "kind": "command", "command": "printf 'token=%s' \"$GH_TOKEN\"" }),
        )]),
        text_reply(&["It says hello."]),
    ])
    .await;
    let client = Arc::new(FakeClient::new(&mock.base));
    let engine = Engine::ready(
        &temp_dir("harness-real"),
        &["--harness-command", &command],
        client,
    )
    .await;
    let workspace = temp_dir("harness-real-workspace");
    // Over three lines: the content leaves the JSON line for its own section.
    std::fs::write(
        workspace.join("note.txt"),
        "hello from \"the\" file\nsecond\nthird\nfourth\n",
    )
    .unwrap();
    let session = engine.create(harness_config(&workspace)).await;
    engine.subscribe(&session, 0).await;
    engine.send(&session, "read the note").await;
    let records = records_of(
        &tokio::time::timeout(Duration::from_secs(60), engine.until_turn_ended())
            .await
            .expect("the turn ends"),
    );
    let requests = mock.requests();
    assert_eq!(
        tool_names(&requests[0].body),
        [
            "edit_code",
            "finish_task",
            "read_code",
            "run_task",
            "search_code"
        ]
    );
    for tool in requests[0].body["tools"].as_array().unwrap() {
        assert_eq!(tool["input_schema"]["type"], "object", "{tool}");
    }
    let results = results(&records);
    assert_eq!(results[0].0, ToolOutcome::Completed, "{:?}", results[0].1);
    let text: String = results[0]
        .1
        .iter()
        .map(|block| match block {
            ToolResultBlock::Text { text } => text.clone(),
            ToolResultBlock::Image { .. } => String::new(),
        })
        .collect();
    assert!(text.contains("blame_tool_result_v2"), "{text}");
    assert!(text.contains("hello from \"the\" file"), "{text}");
    assert!(requests[1].body.to_string().contains("hello from"));
    assert!(
        requests[2]
            .body
            .to_string()
            .contains("token=granted-by-the-client"),
        "the command ran with the client's credentials"
    );
    assert!(engine.shutdown().await.success());
}

#[tokio::test]
async fn a_session_gets_only_the_harness_tools_its_options_keep() {
    let Some(harness) = real_harness() else {
        eprintln!("skipped: blame-harness is not built");
        return;
    };
    let command = harness_args(&[harness.to_str().unwrap(), "serve"]);
    let workspace = temp_dir("harness-kept-workspace");
    let marker = workspace.join("ran.txt");
    let mock = mock(vec![
        // The model asks for a tool it was not offered.
        tool_reply(&[(
            "run_task",
            json!({ "kind": "command", "command": format!("echo ran > '{}'", marker.display()) }),
        )]),
        text_reply(&["I only read."]),
    ])
    .await;
    let client = Arc::new(FakeClient::new(&mock.base));
    let engine = Engine::ready(
        &temp_dir("harness-kept"),
        &["--harness-command", &command],
        client,
    )
    .await;
    let mut config = harness_config(&workspace);
    config.tool_options.insert(
        "harness".into(),
        json!({
            "taskContract": { "objective": "read only" },
            "tools": ["search_code", "read_code"],
        }),
    );
    let session = engine.create(config).await;
    engine.subscribe(&session, 0).await;
    engine.send(&session, "run something").await;
    let records = records_of(
        &tokio::time::timeout(Duration::from_secs(60), engine.until_turn_ended())
            .await
            .expect("the turn ends"),
    );
    let requests = mock.requests();
    assert_eq!(tool_names(&requests[0].body), ["read_code", "search_code"]);
    let results = results(&records);
    assert_ne!(results[0].0, ToolOutcome::Completed, "{:?}", results[0].1);
    assert!(
        !marker.exists(),
        "a tool the session was not offered never runs"
    );
    assert!(engine.shutdown().await.success());
}

// A chat in the person's folder: a git command that changes the repository
// waits for their approval and then runs; without the option it is refused.
#[tokio::test]
async fn a_chats_git_change_runs_once_the_person_approves_it() {
    let Some(harness) = real_harness() else {
        eprintln!("skipped: blame-harness is not built");
        return;
    };
    let command = harness_args(&[harness.to_str().unwrap(), "serve"]);
    for approve in [true, false] {
        let workspace = temp_dir(if approve { "git-approve" } else { "git-refuse" });
        for args in [
            vec!["init", "-q", "--initial-branch=main"],
            vec![
                "-c",
                "user.email=t@t",
                "-c",
                "user.name=t",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "init",
            ],
        ] {
            let status = std::process::Command::new("git")
                .args(&args)
                .current_dir(&workspace)
                .status()
                .unwrap();
            assert!(status.success());
        }
        let mock = mock(vec![
            tool_reply(&[(
                "run_task",
                json!({ "kind": "command", "command": "git branch feature" }),
            )]),
            text_reply(&["Done."]),
        ])
        .await;
        let client = Arc::new(FakeClient::new(&mock.base));
        let engine = Engine::ready(
            &temp_dir("git-approval-engine"),
            &["--harness-command", &command],
            client,
        )
        .await;
        let mut config = harness_config(&workspace);
        let mut options = json!({
            "taskContract": {
                "effect_requirement": "none",
                "environment": { "isolated": false, "managedPreview": false },
            },
        });
        if approve {
            options["approveGitChanges"] = json!(true);
        }
        config.tool_options.insert("harness".into(), options);
        let session = engine.create(config).await;
        engine.subscribe(&session, 0).await;
        engine.send(&session, "make a feature branch").await;
        let records = records_of(
            &tokio::time::timeout(Duration::from_secs(60), engine.until_turn_ended())
                .await
                .expect("the turn ends"),
        );
        let asked = kinds(&records).contains(&"approval?");
        let branch = std::process::Command::new("git")
            .args(["branch", "--list", "feature"])
            .current_dir(&workspace)
            .output()
            .unwrap();
        let made = !String::from_utf8_lossy(&branch.stdout).trim().is_empty();
        let results = results(&records);
        if approve {
            assert!(asked, "the person is asked: {:?}", kinds(&records));
            assert_eq!(results[0].0, ToolOutcome::Completed, "{:?}", results[0].1);
            assert!(made, "the approved command ran");
        } else {
            assert!(!asked);
            assert!(!made, "refused without the chat's option");
            let text = format!("{:?}", results[0].1);
            assert!(text.contains("Git mutations are unavailable"), "{text}");
        }
        assert!(engine.shutdown().await.success());
    }
}
