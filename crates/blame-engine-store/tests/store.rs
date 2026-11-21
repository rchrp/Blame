mod common;

use blame_engine_core::ports::{BlobSource, SessionStore, StoreError};
use blame_engine_protocol::{RecordBody, ToolResultBlock};
use blame_engine_store::{Durability, SqliteStore, StoreOptions};
use common::*;
use rusqlite::Connection;

fn open(dir: &TempDir) -> SqliteStore {
    SqliteStore::open(dir.db(), ManualClock::at(1_000), StoreOptions::default()).unwrap()
}

#[tokio::test]
async fn seqs_are_contiguous_from_one_and_survive_reopening() {
    let dir = TempDir::new("seqs");
    let s = session("s1");
    {
        let store = open(&dir);
        let first = store
            .append(&s, 0, vec![notice("a"), notice("b")])
            .await
            .unwrap();
        assert_eq!(first.iter().map(|r| r.seq).collect::<Vec<_>>(), [1, 2]);
        let second = store.append(&s, 2, vec![notice("c")]).await.unwrap();
        assert_eq!(second[0].seq, 3);
        assert_eq!(second[0].at_ms, 1_000);
    }
    let store = open(&dir);
    let all = store.read(&s, 0, None).await.unwrap();
    assert_eq!(all.iter().map(text_of).collect::<Vec<_>>(), ["a", "b", "c"]);
    let tail = store.read(&s, 1, Some(1)).await.unwrap();
    assert_eq!(tail.len(), 1);
    assert_eq!(tail[0].seq, 2);
    assert!(store.read(&s, 3, None).await.unwrap().is_empty());
    let listed = store.sessions().await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!((listed[0].head, listed[0].updated_at_ms), (3, 1_000));
}

#[tokio::test]
async fn a_stale_head_is_a_conflict_and_changes_nothing() {
    let dir = TempDir::new("conflict");
    let store = open(&dir);
    let s = session("s1");
    store
        .append(&s, 0, vec![notice("a"), notice("b")])
        .await
        .unwrap();

    let stale = store.append(&s, 1, vec![notice("x")]).await;
    assert!(matches!(
        stale,
        Err(StoreError::Conflict {
            expected: 1,
            head: 2,
            ..
        })
    ));
    let ahead = store.append(&s, 5, vec![notice("x")]).await;
    assert!(matches!(
        ahead,
        Err(StoreError::Conflict {
            expected: 5,
            head: 2,
            ..
        })
    ));
    let again = store.append(&s, 0, vec![notice("x")]).await;
    assert!(matches!(again, Err(StoreError::SessionExists(_))));
    let unknown = store.append(&session("nope"), 3, vec![notice("x")]).await;
    assert!(matches!(unknown, Err(StoreError::UnknownSession(_))));
    assert!(matches!(
        store.read(&session("nope"), 0, None).await,
        Err(StoreError::UnknownSession(_))
    ));
    assert_eq!(store.read(&s, 0, None).await.unwrap().len(), 2);
    // An empty append writes nothing, not even a session.
    assert!(
        store
            .append(&session("empty"), 0, vec![])
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(store.sessions().await.unwrap().len(), 1);
}

#[tokio::test]
async fn two_stores_on_one_file_cannot_both_win() {
    let dir = TempDir::new("two");
    let a = open(&dir);
    let b = open(&dir);
    let s = session("shared");
    a.append(&s, 0, vec![notice("a1")]).await.unwrap();
    // `b` has never seen the session; its view is only the file's.
    assert!(matches!(
        b.append(&s, 0, vec![notice("b1")]).await,
        Err(StoreError::SessionExists(_))
    ));
    b.append(&s, 1, vec![notice("b2")]).await.unwrap();
    assert!(matches!(
        a.append(&s, 1, vec![notice("a2")]).await,
        Err(StoreError::Conflict {
            expected: 1,
            head: 2,
            ..
        })
    ));
    assert_eq!(a.read(&s, 0, None).await.unwrap().len(), 2);

    // Racing: many tasks on both stores append at the same head; exactly one
    // wins each round.
    let mut head = 2;
    for _ in 0..20 {
        let tasks: Vec<_> = (0..6)
            .map(|i| {
                let store = if i % 2 == 0 { a.clone() } else { b.clone() };
                let s = s.clone();
                tokio::spawn(
                    async move { store.append(&s, head, vec![notice(&i.to_string())]).await },
                )
            })
            .collect();
        let mut winners = 0;
        for task in tasks {
            match task.await.unwrap() {
                Ok(_) => winners += 1,
                Err(StoreError::Conflict { .. }) => {}
                Err(other) => panic!("{other}"),
            }
        }
        assert_eq!(winners, 1);
        head += 1;
    }
    let all = a.read(&s, 0, None).await.unwrap();
    assert_eq!(all.len() as u64, head);
}

#[tokio::test]
async fn an_append_is_all_or_nothing() {
    let dir = TempDir::new("atomic");
    let store = open(&dir);
    let s = session("s1");
    store.append(&s, 0, vec![notice("a")]).await.unwrap();

    // A trigger makes the third row of a batch fail, after two were inserted.
    let raw = Connection::open(dir.db()).unwrap();
    raw.execute_batch(
        "CREATE TRIGGER boom BEFORE INSERT ON records WHEN new.seq = 4
         BEGIN SELECT RAISE(ABORT, 'boom'); END;",
    )
    .unwrap();
    let failed = store
        .append(
            &s,
            1,
            vec![notice("b"), notice("c"), notice("d"), notice("e")],
        )
        .await;
    assert!(matches!(failed, Err(StoreError::Io(_))), "{failed:?}");
    assert_eq!(store.read(&s, 0, None).await.unwrap().len(), 1);
    assert_eq!(store.sessions().await.unwrap()[0].head, 1);

    // The same for a session that does not exist yet: no half-created one.
    raw.execute_batch("DROP TRIGGER boom; CREATE TRIGGER boom BEFORE INSERT ON records WHEN new.seq = 2 BEGIN SELECT RAISE(ABORT, 'boom'); END;").unwrap();
    let fresh = session("fresh");
    assert!(
        store
            .append(&fresh, 0, vec![notice("x"), notice("y")])
            .await
            .is_err()
    );
    assert!(matches!(
        store.read(&fresh, 0, None).await,
        Err(StoreError::UnknownSession(_))
    ));

    raw.execute_batch("DROP TRIGGER boom").unwrap();
    let ok = store
        .append(&s, 1, vec![notice("b"), notice("c")])
        .await
        .unwrap();
    assert_eq!(ok.last().unwrap().seq, 3);
}

#[tokio::test]
async fn time_never_runs_backwards_within_a_session() {
    let dir = TempDir::new("time");
    let clock = ManualClock::at(5_000);
    let store = SqliteStore::open(dir.db(), clock.clone(), StoreOptions::default()).unwrap();
    let s = session("s1");
    let first = store
        .append(&s, 0, vec![notice("a"), notice("b")])
        .await
        .unwrap();
    assert_eq!(first[1].at_ms, 5_000);
    clock.set(2_000); // the system clock stepped back
    let second = store.append(&s, 2, vec![notice("c")]).await.unwrap();
    assert_eq!(second[0].at_ms, 5_000);
    clock.set(9_000);
    let third = store.append(&s, 3, vec![notice("d")]).await.unwrap();
    assert_eq!(third[0].at_ms, 9_000);
    // Another session is not held back by this one.
    clock.set(100);
    let other = store
        .append(&session("s2"), 0, vec![notice("x")])
        .await
        .unwrap();
    assert_eq!(other[0].at_ms, 100);
}

#[tokio::test]
async fn damaged_rows_are_reported_never_skipped() {
    let dir = TempDir::new("corrupt");
    let store = open(&dir);
    let s = session("s1");
    store
        .append(&s, 0, vec![notice("a"), notice("b"), notice("c")])
        .await
        .unwrap();
    let raw = Connection::open(dir.db()).unwrap();

    raw.execute(
        "UPDATE records SET body = '{\"type\":\"notice\"' WHERE seq = 2",
        [],
    )
    .unwrap();
    let broken = store.read(&s, 0, None).await;
    assert!(
        matches!(&broken, Err(StoreError::Corrupt(m)) if m.contains("record 2")),
        "{broken:?}"
    );
    // Reading only what comes after the damage still works.
    assert_eq!(store.read(&s, 2, None).await.unwrap().len(), 1);

    raw.execute("UPDATE records SET body = X'00ff' WHERE seq = 2", [])
        .unwrap();
    assert!(matches!(
        store.read(&s, 0, None).await,
        Err(StoreError::Corrupt(_))
    ));

    raw.execute(
        "UPDATE records SET body = '{\"type\":\"no_such_record\"}' WHERE seq = 2",
        [],
    )
    .unwrap();
    assert!(matches!(
        store.read(&s, 0, None).await,
        Err(StoreError::Corrupt(_))
    ));

    // A missing row is a gap, not a shorter log.
    raw.execute("DELETE FROM records WHERE seq = 2", [])
        .unwrap();
    assert!(matches!(
        store.read(&s, 0, None).await,
        Err(StoreError::Corrupt(_))
    ));
    // Missing tail: head says 3, the rows stop at 2.
    raw.execute("DELETE FROM records WHERE seq = 3", [])
        .unwrap();
    assert!(matches!(
        store.read(&s, 1, None).await,
        Err(StoreError::Corrupt(_))
    ));
}

#[tokio::test]
async fn a_file_that_is_not_ours_or_is_newer_is_refused() {
    let dir = TempDir::new("version");
    drop(open(&dir));
    let raw = Connection::open(dir.db()).unwrap();
    let version: i32 = raw
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(version, 1);
    raw.pragma_update(None, "user_version", 99).unwrap();
    let err = SqliteStore::open(dir.db(), ManualClock::at(0), StoreOptions::default()).err();
    assert!(matches!(err, Some(StoreError::Corrupt(m)) if m.contains("99")));

    let other = TempDir::new("foreign");
    Connection::open(other.db())
        .unwrap()
        .execute_batch("CREATE TABLE unrelated (x)")
        .unwrap();
    assert!(matches!(
        SqliteStore::open(other.db(), ManualClock::at(0), StoreOptions::default()).err(),
        Some(StoreError::Corrupt(_))
    ));

    let garbage = TempDir::new("garbage");
    std::fs::write(garbage.db(), vec![7u8; 4096]).unwrap();
    assert!(matches!(
        SqliteStore::open(garbage.db(), ManualClock::at(0), StoreOptions::default()).err(),
        Some(StoreError::Corrupt(_))
    ));
}

#[tokio::test]
async fn blobs_are_stored_once_and_come_back_intact() {
    let dir = TempDir::new("blobs");
    let options = StoreOptions {
        inline_blob_max: 1024,
        ..StoreOptions::default()
    };
    let store = SqliteStore::open(dir.db(), ManualClock::at(0), options).unwrap();
    let small = vec![1u8; 100];
    let big: Vec<u8> = (0..300_000u32).map(|i| (i * 7) as u8).collect();

    let a = store.put_blob("image/png", small.clone()).await.unwrap();
    let b = store.put_blob("image/png", small.clone()).await.unwrap();
    assert_eq!(a, b);
    assert_eq!(a.bytes, 100);
    assert_eq!(a.sha256.len(), 64);
    let c = store.put_blob("image/png", big.clone()).await.unwrap();
    let d = store.put_blob("image/jpeg", big.clone()).await.unwrap();
    assert_eq!(c.sha256, d.sha256);

    assert_eq!(store.blob(&a.sha256).await.unwrap().unwrap(), small);
    assert_eq!(store.blob(&c.sha256).await.unwrap().unwrap(), big);
    assert_eq!(store.blob(&"0".repeat(64)).await.unwrap(), None);
    assert_eq!(store.blob("../../etc/passwd").await.unwrap(), None);

    let raw = Connection::open(dir.db()).unwrap();
    let rows: i64 = raw
        .query_row("SELECT count(*) FROM blobs", [], |r| r.get(0))
        .unwrap();
    assert_eq!(rows, 2);
    let inline: i64 = raw
        .query_row(
            "SELECT count(*) FROM blobs WHERE data IS NOT NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(inline, 1, "the small one is a row, the big one a file");
    let files: Vec<_> = std::fs::read_dir(dir.0.join("engine.db-blobs"))
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    assert_eq!(files, std::slice::from_ref(&c.sha256));

    // Damage is noticed on the way out, not passed to a model.
    let path = dir.0.join("engine.db-blobs").join(&c.sha256);
    let mut bytes = std::fs::read(&path).unwrap();
    bytes[10] ^= 1;
    std::fs::write(&path, bytes).unwrap();
    assert!(matches!(
        store.blob(&c.sha256).await,
        Err(StoreError::Corrupt(_))
    ));
    std::fs::remove_file(&path).unwrap();
    assert!(matches!(
        store.blob(&c.sha256).await,
        Err(StoreError::Corrupt(_))
    ));
    // Storing it again heals the file.
    store.put_blob("image/png", big.clone()).await.unwrap();
    assert_eq!(store.blob(&c.sha256).await.unwrap().unwrap(), big);
    raw.execute(
        "UPDATE blobs SET data = X'ff' WHERE sha256 = ?1",
        [&a.sha256],
    )
    .unwrap();
    assert!(matches!(
        store.blob(&a.sha256).await,
        Err(StoreError::Corrupt(_))
    ));
}

#[tokio::test]
async fn a_record_can_carry_a_blob_ref_through_the_log() {
    let dir = TempDir::new("blobref");
    let store = open(&dir);
    let image = store.put_blob("image/png", vec![9; 10]).await.unwrap();
    let s = session("s1");
    let body = RecordBody::ToolCallFinished {
        turn: "t1".into(),
        call: "c1".into(),
        outcome: blame_engine_protocol::ToolOutcome::Completed,
        content: vec![ToolResultBlock::Image {
            blob: image.clone(),
        }],
    };
    store.append(&s, 0, vec![body.clone()]).await.unwrap();
    let back = store.read(&s, 0, None).await.unwrap();
    assert_eq!(back[0].body, body);
}

#[tokio::test]
async fn every_durability_level_works() {
    for durability in [Durability::Full, Durability::OsCrash, Durability::Relaxed] {
        let dir = TempDir::new("levels");
        let options = StoreOptions {
            durability,
            ..StoreOptions::default()
        };
        let store = SqliteStore::open(dir.db(), ManualClock::at(0), options).unwrap();
        store
            .append(&session("s"), 0, vec![notice("a")])
            .await
            .unwrap();
        let raw = Connection::open(dir.db()).unwrap();
        let mode: String = raw
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        assert_eq!(mode, "wal");
    }
}

#[tokio::test]
async fn deleting_a_session_removes_the_blobs_only_it_names() {
    let dir = TempDir::new("delete-blobs");
    let options = StoreOptions {
        inline_blob_max: 1024,
        ..StoreOptions::default()
    };
    let store = SqliteStore::open(dir.db(), ManualClock::at(0), options).unwrap();
    // Its own screenshot (a file beside the database), and one another
    // conversation took too (inline).
    let own = store.put_blob("image/png", vec![7; 4096]).await.unwrap();
    let shared = store.put_blob("image/png", vec![3; 16]).await.unwrap();
    let image = |blob: &blame_engine_protocol::BlobRef| RecordBody::ToolCallFinished {
        turn: "t1".into(),
        call: "c1".into(),
        outcome: blame_engine_protocol::ToolOutcome::Completed,
        content: vec![ToolResultBlock::Image { blob: blob.clone() }],
    };
    let (story, chat) = (session("story"), session("chat"));
    store
        .append(&story, 0, vec![image(&own), image(&shared)])
        .await
        .unwrap();
    store.append(&chat, 0, vec![image(&shared)]).await.unwrap();
    let file = dir.0.join("engine.db-blobs").join(&own.sha256);
    assert!(file.exists());

    assert!(store.delete(&story).await.unwrap());
    assert_eq!(store.blob(&own.sha256).await.unwrap(), None);
    assert!(!file.exists(), "its file goes with it");
    assert_eq!(
        store.blob(&shared.sha256).await.unwrap(),
        Some(vec![3; 16]),
        "the chat still shows it"
    );
    assert!(store.delete(&chat).await.unwrap());
    assert_eq!(store.blob(&shared.sha256).await.unwrap(), None);
}
