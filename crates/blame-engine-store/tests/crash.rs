//! What survives a process that dies, and two engines on one file.
//!
//! The "children" are this very test binary started again on one of the
//! `child_*` tests below, which do nothing unless `STORE_CHILD_DIR` is set.

mod common;

use blame_engine_core::ports::{SessionStore, StoreError};
use blame_engine_store::{SqliteStore, StoreOptions};
use common::*;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

const SESSION: &str = "crashy";

fn child_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("STORE_CHILD_DIR").map(Into::into)
}

fn spawn_child(test: &str, dir: &Path) -> (Child, mpsc::Receiver<String>) {
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([test, "--exact", "--nocapture", "--test-threads=1"])
        .env("STORE_CHILD_DIR", dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let stdout = child.stdout.take().unwrap();
    let (lines, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if lines.send(line).is_err() {
                break;
            }
        }
    });
    (child, receiver)
}

fn open(db: &Path) -> SqliteStore {
    SqliteStore::open(db, std::sync::Arc::new(RealClock), StoreOptions::default()).unwrap()
}

/// Appends three records at a time as fast as it can, printing the last seq of
/// each batch only once `append` has returned.
#[tokio::test]
async fn child_append_loop() {
    let Some(dir) = child_dir() else { return };
    let store = open(&dir.join("engine.db"));
    let s = session(SESSION);
    let mut head = 0;
    loop {
        let bodies = (1..=3)
            .map(|k| notice(&format!("rec {}", head + k)))
            .collect();
        let records = store.append(&s, head, bodies).await.unwrap();
        head = records.last().unwrap().seq;
        println!("acked {head}");
    }
}

#[tokio::test]
async fn acknowledged_appends_survive_kill_9() {
    let dir = TempDir::new("kill9");
    let (mut child, lines) = spawn_child("child_append_loop", &dir.0);
    let mut last_acked = 0;
    let deadline = std::time::Instant::now() + Duration::from_secs(60);
    while last_acked < 150 && std::time::Instant::now() < deadline {
        if let Ok(line) = lines.recv_timeout(Duration::from_millis(100))
            && let Some(seq) = line.strip_prefix("acked ")
        {
            last_acked = seq.parse().unwrap();
        }
    }
    child.kill().unwrap(); // SIGKILL: no destructor, no flush, no checkpoint
    child.wait().unwrap();
    // What it printed after we last looked still counts as acknowledged.
    while let Ok(line) = lines.try_recv() {
        if let Some(seq) = line.strip_prefix("acked ") {
            last_acked = seq.parse().unwrap();
        }
    }
    assert!(
        last_acked >= 150,
        "the child made no progress ({last_acked})"
    );

    let store = open(&dir.db());
    let records = store.read(&session(SESSION), 0, None).await.unwrap();
    for (index, record) in records.iter().enumerate() {
        assert_eq!(record.seq, index as u64 + 1, "gap in the log");
        assert_eq!(text_of(record), format!("rec {}", record.seq));
    }
    let head = records.len() as u64;
    assert!(
        head >= last_acked,
        "an acknowledged append was lost: {head} < {last_acked}"
    );
    // Batches are all or nothing even when the process is killed inside one.
    assert_eq!(head % 3, 0);
    // And the log is still usable.
    let more = store
        .append(&session(SESSION), head, vec![notice("after")])
        .await
        .unwrap();
    assert_eq!(more[0].seq, head + 1);
}

/// Starts a write transaction on the file, inserts rows, and waits to be
/// killed before committing.
#[test]
fn child_abandoned_transaction() {
    let Some(dir) = child_dir() else { return };
    let raw = rusqlite::Connection::open(dir.join("engine.db")).unwrap();
    raw.execute_batch(
        "BEGIN IMMEDIATE;
         INSERT INTO records (session, seq, at_ms, body) VALUES ('crashy', 3, 1, '{\"type\":\"notice\",\"level\":\"info\",\"code\":\"x\",\"text\":\"ghost\"}');
         INSERT INTO records (session, seq, at_ms, body) VALUES ('crashy', 4, 1, '{\"type\":\"notice\",\"level\":\"info\",\"code\":\"x\",\"text\":\"ghost\"}');
         UPDATE sessions SET head = 4 WHERE id = 'crashy';",
    )
    .unwrap();
    println!("ready");
    std::thread::sleep(Duration::from_secs(120));
}

#[tokio::test]
async fn a_transaction_cut_short_by_a_crash_leaves_no_trace() {
    let dir = TempDir::new("midtx");
    let s = session(SESSION);
    {
        let store = open(&dir.db());
        store
            .append(&s, 0, vec![notice("one"), notice("two")])
            .await
            .unwrap();
    }
    let (mut child, lines) = spawn_child("child_abandoned_transaction", &dir.0);
    loop {
        let line = lines
            .recv_timeout(Duration::from_secs(30))
            .expect("child never got ready");
        if line.ends_with("ready") {
            break;
        }
    }
    child.kill().unwrap();
    child.wait().unwrap();

    let store = open(&dir.db());
    let records = store.read(&s, 0, None).await.unwrap();
    assert_eq!(
        records.iter().map(text_of).collect::<Vec<_>>(),
        ["one", "two"]
    );
    assert_eq!(store.sessions().await.unwrap()[0].head, 2);
    let next = store.append(&s, 2, vec![notice("three")]).await.unwrap();
    assert_eq!(next[0].seq, 3);
}

/// Appends 100 records to the shared session, retrying on conflicts.
#[tokio::test]
async fn child_contender() {
    let Some(dir) = child_dir() else { return };
    contend(&open(&dir.join("engine.db")), "child").await;
    println!("done");
}

async fn contend(store: &SqliteStore, who: &str) {
    let s = session(SESSION);
    let mut done = 0;
    while done < 100 {
        let head = store.sessions().await.unwrap()[0].head;
        match store
            .append(&s, head, vec![notice(&format!("{who} {done}"))])
            .await
        {
            Ok(_) => done += 1,
            Err(StoreError::Conflict { .. }) => {}
            Err(other) => panic!("{other}"),
        }
    }
}

#[tokio::test]
async fn two_engine_processes_on_one_file_never_interleave_wrongly() {
    let dir = TempDir::new("contend");
    let store = open(&dir.db());
    store
        .append(&session(SESSION), 0, vec![notice("start")])
        .await
        .unwrap();
    let (mut child, lines) = spawn_child("child_contender", &dir.0);
    contend(&store, "parent").await;
    loop {
        if lines
            .recv_timeout(Duration::from_secs(60))
            .expect("child never finished")
            .ends_with("done")
        {
            break;
        }
    }
    assert!(child.wait().unwrap().success());

    let records = store.read(&session(SESSION), 0, None).await.unwrap();
    assert_eq!(records.len(), 201);
    for (index, record) in records.iter().enumerate() {
        assert_eq!(record.seq, index as u64 + 1);
    }
    // Every acknowledged append is there exactly once, per writer in order.
    for who in ["parent", "child"] {
        let mine: Vec<_> = records
            .iter()
            .map(text_of)
            .filter_map(|t| t.strip_prefix(&format!("{who} ")))
            .map(|n| n.parse::<u32>().unwrap())
            .collect();
        assert_eq!(mine, (0..100).collect::<Vec<_>>());
    }
}
