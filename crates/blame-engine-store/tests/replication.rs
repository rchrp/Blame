mod common;

use blame_engine_core::ports::{BlobSource, SessionStore, StoreError};
use blame_engine_protocol::{RecordBody, ToolOutcome, ToolResultBlock};
use blame_engine_store::{ReplicationConfig, SqliteStore, StoreOptions};
use common::*;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

fn fast() -> ReplicationConfig {
    ReplicationConfig {
        batch_records: 4,
        batch_bytes: 1 << 20,
        backoff_base: Duration::from_millis(20),
        backoff_max: Duration::from_millis(200),
        idle_poll: Duration::from_millis(50),
    }
}

fn open(dir: &TempDir, remote: &Arc<FakeRemote>) -> SqliteStore {
    let options = StoreOptions {
        remote: Some(remote.clone()),
        replication: fast(),
        inline_blob_max: 64,
        ..StoreOptions::default()
    };
    SqliteStore::open(dir.db(), Arc::new(RealClock), options).unwrap()
}

struct Running {
    stop: CancellationToken,
    task: tokio::task::JoinHandle<()>,
}

fn start(store: &SqliteStore) -> Running {
    let stop = CancellationToken::new();
    let replicator = store.replicator().expect("a remote is configured");
    let task = tokio::spawn(replicator.run(stop.clone()));
    Running { stop, task }
}

impl Running {
    async fn stop(self) {
        self.stop.cancel();
        self.task.await.unwrap();
    }
}

async fn flushed(store: &SqliteStore) {
    assert!(
        store.wait_flushed(Duration::from_secs(10)).await.unwrap(),
        "not flushed: {:?}",
        store.replication_lag().await
    );
}

fn texts(log: &[blame_engine_protocol::Record]) -> Vec<String> {
    log.iter().map(|r| text_of(r).to_owned()).collect()
}

#[tokio::test]
async fn records_reach_the_remote_in_order_and_the_lag_closes() {
    let dir = TempDir::new("rep-basic");
    let remote = FakeRemote::new();
    let store = open(&dir, &remote);
    let (a, b) = (session("a"), session("b"));
    for i in 0..10 {
        store
            .append(&a, i, vec![notice(&format!("a{i}"))])
            .await
            .unwrap();
    }
    store
        .append(&b, 0, vec![notice("b0"), notice("b1")])
        .await
        .unwrap();

    let lag = store.replication_lag().await.unwrap();
    assert_eq!(lag.sessions.len(), 2);
    assert!(!lag.is_caught_up());

    let running = start(&store);
    flushed(&store).await;
    assert_eq!(
        texts(&remote.log(&a)),
        (0..10).map(|i| format!("a{i}")).collect::<Vec<_>>()
    );
    assert_eq!(texts(&remote.log(&b)), ["b0", "b1"]);
    // Batches obey the configured size and never skip ahead.
    remote.with(|s| {
        assert!(s.violations.is_empty(), "{:?}", s.violations);
        assert!(
            s.push_batches
                .iter()
                .all(|(_, first, last)| last - first < 4)
        );
    });

    // New appends keep flowing while it runs.
    store.append(&a, 10, vec![notice("late")]).await.unwrap();
    flushed(&store).await;
    assert_eq!(remote.log(&a).len(), 11);
    running.stop().await;
}

#[tokio::test]
async fn a_blob_is_on_the_remote_before_any_record_that_names_it() {
    let dir = TempDir::new("rep-blobs");
    let remote = FakeRemote::new();
    let store = open(&dir, &remote);
    let small = store.put_blob("image/png", vec![1; 10]).await.unwrap();
    let big = store.put_blob("image/png", vec![2; 5_000]).await.unwrap();
    let orphan = store.put_blob("text/plain", vec![3; 7]).await.unwrap();
    let body = RecordBody::ToolCallFinished {
        turn: "t".into(),
        call: "c".into(),
        outcome: ToolOutcome::Completed,
        content: vec![
            ToolResultBlock::Image {
                blob: small.clone(),
            },
            ToolResultBlock::Image { blob: big.clone() },
        ],
    };
    store.append(&session("s"), 0, vec![body]).await.unwrap();

    let running = start(&store);
    flushed(&store).await;
    running.stop().await;
    let events = remote.with(|s| s.events.clone());
    let at = |e: &Event| events.iter().position(|x| x == e).unwrap();
    let record = at(&Event::Record(session("s"), 1));
    assert!(at(&Event::Blob(small.sha256.clone())) < record);
    assert!(at(&Event::Blob(big.sha256.clone())) < record);
    // One nobody refers to yet still gets there.
    assert!(remote.with(|s| s.blobs.contains_key(&orphan.sha256)));
    assert_eq!(
        remote.with(|s| s.blobs[&big.sha256].clone()),
        vec![2; 5_000]
    );
    // Once is enough: nothing is sent again.
    let before = remote.with(|s| s.events.len());
    let again = start(&store);
    tokio::time::sleep(Duration::from_millis(150)).await;
    again.stop().await;
    assert_eq!(remote.with(|s| s.events.len()), before);
}

#[tokio::test]
async fn an_unreachable_remote_never_delays_appends_and_is_retried_with_backoff() {
    let dir = TempDir::new("rep-down");
    let remote = FakeRemote::new();
    remote.with(|s| s.down = true);
    let store = open(&dir, &remote);
    let running = start(&store);
    let s = session("s");

    let started = Instant::now();
    for i in 0..30 {
        store
            .append(&s, i, vec![notice(&i.to_string())])
            .await
            .unwrap();
    }
    assert!(started.elapsed() < Duration::from_secs(5));

    tokio::time::sleep(Duration::from_millis(900)).await;
    let attempts = remote.with(|s| s.attempts.clone());
    assert!(
        attempts.len() >= 3,
        "it must keep trying: {}",
        attempts.len()
    );
    // 900 ms with a 20 ms base doubling to a 200 ms cap: a hot loop would be
    // hundreds of attempts.
    assert!(attempts.len() < 30, "no backoff: {}", attempts.len());
    let gaps: Vec<_> = attempts.windows(2).map(|w| w[1] - w[0]).collect();
    assert!(gaps.last().unwrap() > &(gaps[0] * 2), "{gaps:?}");
    let lag = store.replication_lag().await.unwrap();
    assert_eq!(lag.sessions[0].remote_head, 0);
    assert!(lag.last_error.as_deref().unwrap().contains("unreachable"));
    assert!(!store.wait_flushed(Duration::from_millis(50)).await.unwrap());

    // The network comes back: everything arrives, nothing lost, error cleared.
    remote.with(|s| s.down = false);
    flushed(&store).await;
    assert_eq!(remote.log(&s).len(), 30);
    assert_eq!(store.replication_lag().await.unwrap().last_error, None);
    running.stop().await;
}

#[tokio::test]
async fn a_remote_that_never_answers_does_not_block_the_loop() {
    let dir = TempDir::new("rep-hang");
    let remote = FakeRemote::new();
    remote.with(|s| s.hang = true);
    let store = open(&dir, &remote);
    let running = start(&store);
    let s = session("s");
    store.append(&s, 0, vec![notice("a")]).await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await; // the replicator is now stuck in push
    let started = Instant::now();
    store.append(&s, 1, vec![notice("b")]).await.unwrap();
    store.put_blob("image/png", vec![1; 1000]).await.unwrap();
    assert_eq!(store.read(&s, 0, None).await.unwrap().len(), 2);
    assert!(started.elapsed() < Duration::from_secs(2));
    running.stop().await; // cancelling still works
}

#[tokio::test]
async fn failures_duplicates_partial_and_lying_answers_lose_nothing() {
    let dir = TempDir::new("rep-quirks");
    let remote = FakeRemote::new();
    remote.with(|s| {
        s.fail_next = 2;
        s.quirks = [
            Quirk::StaleAck, // kept the records but says it holds none
            Quirk::Partial(1),
            Quirk::Inflated, // claims a seq nobody sent
            Quirk::Partial(2),
            Quirk::StaleAck,
        ]
        .into();
    });
    let store = open(&dir, &remote);
    let s = session("s");
    for i in 0..9 {
        store
            .append(&s, i, vec![notice(&format!("r{i}"))])
            .await
            .unwrap();
    }
    let running = start(&store);
    flushed(&store).await;
    running.stop().await;
    let log = remote.log(&s);
    assert_eq!(
        texts(&log),
        (0..9).map(|i| format!("r{i}")).collect::<Vec<_>>()
    );
    remote.with(|s| assert!(s.violations.is_empty(), "{:?}", s.violations));
    // The mark equals the head, not the inflated claim.
    assert_eq!(store.replication_lag().await.unwrap().sessions, []);
}

#[tokio::test]
async fn replication_resumes_after_a_restart_where_it_stopped() {
    let dir = TempDir::new("rep-restart");
    let remote = FakeRemote::new();
    let s = session("s");
    {
        let store = open(&dir, &remote);
        for i in 0..8 {
            store
                .append(&s, i, vec![notice(&format!("r{i}"))])
                .await
                .unwrap();
        }
        // Let the first batch (records 1-4) through, then lose the network.
        remote.with(|st| st.quirks = [Quirk::Normal].into());
        let running = start(&store);
        let deadline = Instant::now() + Duration::from_secs(10);
        while remote.log(&s).len() < 4 {
            assert!(Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        remote.with(|st| st.down = true);
        running.stop().await;
        store.append(&s, 8, vec![notice("r8")]).await.unwrap();
    } // the engine exits with records unreplicated
    let acked = remote.log(&s).len() as u64;
    assert!((4..9).contains(&acked));

    remote.with(|st| {
        st.down = false;
        st.push_batches.clear();
    });
    let store = open(&dir, &remote);
    // The mark survived: only what is missing is lag.
    let lag = store.replication_lag().await.unwrap();
    assert!(lag.sessions[0].remote_head >= 4, "{lag:?}");
    let running = start(&store);
    flushed(&store).await;
    running.stop().await;
    assert_eq!(remote.log(&s).len(), 9);
    // It started right after what the remote held (never from record 1).
    let first = remote.with(|st| st.push_batches.first().unwrap().1);
    assert!(first > lag.sessions[0].remote_head, "{first} vs {lag:?}");
}

#[tokio::test]
async fn one_session_the_remote_rejects_does_not_hold_the_others_back() {
    let dir = TempDir::new("rep-poison");
    let remote = FakeRemote::new();
    remote.with(|s| {
        s.poisoned.insert(session("bad"));
    });
    let store = open(&dir, &remote);
    store
        .append(&session("bad"), 0, vec![notice("x")])
        .await
        .unwrap();
    store
        .append(&session("good"), 0, vec![notice("y")])
        .await
        .unwrap();
    let running = start(&store);
    let deadline = Instant::now() + Duration::from_secs(10);
    while remote.log(&session("good")).is_empty() {
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    store
        .append(&session("good"), 1, vec![notice("z")])
        .await
        .unwrap();
    while remote.log(&session("good")).len() < 2 {
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let lag = store.replication_lag().await.unwrap();
    assert_eq!(lag.sessions.len(), 1);
    assert_eq!(lag.sessions[0].session, session("bad"));
    assert!(lag.last_error.is_some());
    running.stop().await;
}

#[tokio::test]
async fn a_session_this_store_never_saw_is_hydrated_from_the_remote() {
    let remote = FakeRemote::new();
    let s = session("moved");
    // Machine one runs the session and replicates it.
    let first_dir = TempDir::new("hyd-one");
    {
        let store = open(&first_dir, &remote);
        for i in 0..7 {
            store
                .append(&s, i, vec![notice(&format!("r{i}"))])
                .await
                .unwrap();
        }
        let running = start(&store);
        flushed(&store).await;
        running.stop().await;
    }
    let original = remote.log(&s);

    // Machine two has never heard of it.
    remote.with(|st| {
        st.messy_pull = true;
        st.pull_limit = Some(3);
    });
    let dir = TempDir::new("hyd-two");
    let store = open(&dir, &remote);
    assert!(matches!(
        store.read(&s, 0, None).await,
        Err(StoreError::UnknownSession(_))
    ));
    assert_eq!(store.hydrate(&s).await.unwrap(), 7);
    let local = store.read(&s, 0, None).await.unwrap();
    assert_eq!(local, original, "same records, same seqs, same times");
    // Hydrating again is a no-op, and it did not make the replicator push back.
    assert_eq!(store.hydrate(&s).await.unwrap(), 7);
    assert!(store.replication_lag().await.unwrap().is_caught_up());
    // The session can now be continued here, then flows to the remote.
    store
        .append(&s, 7, vec![notice("continued")])
        .await
        .unwrap();
    let running = start(&store);
    flushed(&store).await;
    running.stop().await;
    assert_eq!(remote.log(&s).len(), 8);

    // Machine one is behind now: it catches up instead of conflicting.
    let behind = open(&first_dir, &remote);
    assert_eq!(behind.hydrate(&s).await.unwrap(), 8);
    assert_eq!(
        text_of(&behind.read(&s, 7, None).await.unwrap()[0]),
        "continued"
    );
    assert!(matches!(
        behind.append(&s, 7, vec![notice("stale")]).await,
        Err(StoreError::Conflict { .. })
    ));

    assert!(matches!(
        behind.hydrate(&session("nobody")).await,
        Err(StoreError::UnknownSession(_))
    ));
}

#[tokio::test]
async fn a_remote_answering_with_a_hole_is_refused_not_stored() {
    let remote = FakeRemote::new();
    let s = session("s");
    let dir_a = TempDir::new("hole-a");
    let a = open(&dir_a, &remote);
    a.append(&s, 0, vec![notice("1"), notice("2"), notice("3")])
        .await
        .unwrap();
    let running = start(&a);
    flushed(&a).await;
    running.stop().await;
    // Drop record 2 from what the remote will answer.
    remote.with(|st| {
        st.logs.get_mut(&s).unwrap().remove(1);
    });
    let dir_b = TempDir::new("hole-b");
    let b = open(&dir_b, &remote);
    let result = b.hydrate(&s).await;
    assert!(matches!(result, Err(StoreError::Io(_))), "{result:?}");
    assert!(matches!(
        b.read(&s, 0, None).await,
        Err(StoreError::UnknownSession(_))
    ));
}

#[tokio::test]
async fn blobs_of_a_hydrated_session_are_fetched_on_first_use() {
    let remote = FakeRemote::new();
    let dir_a = TempDir::new("blob-a");
    let a = open(&dir_a, &remote);
    let image = a.put_blob("image/png", vec![5; 4_000]).await.unwrap();
    let running = start(&a);
    flushed(&a).await;
    running.stop().await;

    let dir_b = TempDir::new("blob-b");
    let b = open(&dir_b, &remote);
    assert_eq!(
        b.blob(&image.sha256).await.unwrap().unwrap(),
        vec![5; 4_000]
    );
    // Now local: it works with the remote gone, and is not pushed back.
    remote.with(|s| s.down = true);
    assert_eq!(
        b.blob(&image.sha256).await.unwrap().unwrap(),
        vec![5; 4_000]
    );
    assert_eq!(
        b.blob(&"f".repeat(64)).await.err().map(|e| e.to_string()),
        Some("storage failed: remote unreachable".into())
    );
    assert!(b.replication_lag().await.unwrap().is_caught_up());

    // A remote that answers with other bytes than the address says is caught.
    remote.with(|s| {
        s.down = false;
        s.blobs.insert("a".repeat(64), vec![1, 2, 3]);
    });
    assert!(matches!(
        b.blob(&"a".repeat(64)).await,
        Err(StoreError::Corrupt(_))
    ));
}

#[tokio::test]
async fn without_a_remote_there_is_nothing_to_replicate() {
    let dir = TempDir::new("rep-none");
    let store = SqliteStore::open(dir.db(), Arc::new(RealClock), StoreOptions::default()).unwrap();
    assert!(store.replicator().is_none());
    store
        .append(&session("s"), 0, vec![notice("a")])
        .await
        .unwrap();
    assert!(store.replication_lag().await.unwrap().is_caught_up());
    assert!(matches!(
        store.hydrate(&session("s")).await,
        Err(StoreError::Io(_))
    ));
}

fn created(kind: blame_engine_protocol::SessionKind) -> RecordBody {
    let mut config: blame_engine_protocol::SessionConfig =
        serde_json::from_value(serde_json::json!({
            "purpose": "title",
            "workspace_root": "/w",
            "model": { "provider": "p", "model": "m" },
            "system_prompt": "s",
        }))
        .unwrap();
    config.kind = kind;
    RecordBody::SessionCreated {
        config: Box::new(config),
    }
}

#[tokio::test]
async fn a_task_stays_local_unless_it_asks_to_be_copied_and_can_be_deleted() {
    use blame_engine_protocol::SessionKind;
    let dir = TempDir::new("rep-tasks");
    let remote = FakeRemote::new();
    let store = open(&dir, &remote);
    let (local, copied, chat) = (session("local"), session("copied"), session("chat"));
    store
        .append(
            &local,
            0,
            vec![created(SessionKind::Task { replicate: false }), notice("t")],
        )
        .await
        .unwrap();
    store
        .append(
            &copied,
            0,
            vec![created(SessionKind::Task { replicate: true })],
        )
        .await
        .unwrap();
    store
        .append(&chat, 0, vec![created(SessionKind::Conversation)])
        .await
        .unwrap();
    store.append(&local, 2, vec![notice("more")]).await.unwrap();
    let running = start(&store);
    flushed(&store).await;
    running.stop().await;
    assert!(
        remote.log(&local).is_empty(),
        "a local task is never pushed"
    );
    assert_eq!(remote.log(&copied).len(), 1);
    assert_eq!(remote.log(&chat).len(), 1);

    let now = blame_engine_core::ports::Clock::now_ms(&RealClock);
    assert_eq!(
        store.local_sessions_before(now + 1).await.unwrap(),
        std::slice::from_ref(&local)
    );
    assert!(
        store
            .local_sessions_before(now - 60_000)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(store.delete(&local).await.unwrap());
    assert!(!store.delete(&local).await.unwrap());
    assert!(matches!(
        store.read(&local, 0, None).await,
        Err(StoreError::UnknownSession(_))
    ));
    assert_eq!(store.sessions().await.unwrap().len(), 2);
    assert!(
        store.append(&local, 0, vec![notice("again")]).await.is_ok(),
        "the id is free again"
    );
}
