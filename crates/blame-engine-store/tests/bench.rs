//! Numbers for the report, not assertions about speed:
//!
//! ```bash
//! cargo test -p blame-engine-store --release --test bench -- --ignored --nocapture
//! ```

mod common;

use blame_engine_core::ports::SessionStore;
use blame_engine_store::{Durability, SqliteStore, StoreOptions};
use common::*;
use std::sync::Arc;
use std::time::{Duration, Instant};

fn report(label: &str, mut latencies: Vec<Duration>, total: Duration) {
    latencies.sort();
    let at = |p: f64| latencies[((latencies.len() - 1) as f64 * p) as usize].as_secs_f64() * 1e3;
    println!(
        "{label:<34} {:>7.0} appends/s   p50 {:>6.2} ms   p95 {:>6.2} ms   p99 {:>6.2} ms   max {:>6.2} ms",
        latencies.len() as f64 / total.as_secs_f64(),
        at(0.5),
        at(0.95),
        at(0.99),
        at(1.0),
    );
}

/// One model request stores about three records (request started, reply, tool
/// call started) of a few KB each; this is that, as one append.
fn batch(round: u64) -> Vec<blame_engine_protocol::RecordBody> {
    let text = "x".repeat(2_000);
    (0..3)
        .map(|k| notice(&format!("{round}-{k} {text}")))
        .collect()
}

async fn sequential(durability: Durability, appends: u64) -> (Vec<Duration>, Duration) {
    let dir = TempDir::new("bench");
    let options = StoreOptions {
        durability,
        ..StoreOptions::default()
    };
    let store = SqliteStore::open(dir.db(), Arc::new(RealClock), options).unwrap();
    let s = session("bench");
    let mut latencies = Vec::new();
    let started = Instant::now();
    for round in 0..appends {
        let t = Instant::now();
        store.append(&s, round * 3, batch(round)).await.unwrap();
        latencies.push(t.elapsed());
    }
    (latencies, started.elapsed())
}

#[tokio::test]
#[ignore = "benchmark"]
async fn append_throughput_and_latency() {
    println!();
    for (label, durability, n) in [
        ("Full (F_FULLFSYNC), 3 x 2 KB", Durability::Full, 1_000),
        ("OsCrash (fsync), 3 x 2 KB", Durability::OsCrash, 3_000),
        ("Relaxed (no sync), 3 x 2 KB", Durability::Relaxed, 3_000),
    ] {
        let (latencies, total) = sequential(durability, n).await;
        report(label, latencies, total);
    }

    // Three sessions at once (the engine runs up to three agents): the single
    // writer serializes their commits.
    let dir = TempDir::new("bench-par");
    let store = SqliteStore::open(dir.db(), Arc::new(RealClock), StoreOptions::default()).unwrap();
    let started = Instant::now();
    let tasks: Vec<_> = (0..3)
        .map(|i| {
            let store = store.clone();
            tokio::spawn(async move {
                let s = session(&format!("bench-{i}"));
                let mut latencies = Vec::new();
                for round in 0..300 {
                    let t = Instant::now();
                    store.append(&s, round * 3, batch(round)).await.unwrap();
                    latencies.push(t.elapsed());
                }
                latencies
            })
        })
        .collect();
    let mut all = Vec::new();
    for task in tasks {
        all.extend(task.await.unwrap());
    }
    report("Full, 3 sessions in parallel", all, started.elapsed());

    // Reading back a long session.
    let t = Instant::now();
    let records = store.read(&session("bench-0"), 0, None).await.unwrap();
    println!(
        "read 900 records (~1.8 MB): {:.1} ms ({})",
        t.elapsed().as_secs_f64() * 1e3,
        records.len()
    );

    for (label, size) in [
        ("64 KiB", 64 << 10),
        ("1 MiB", 1 << 20),
        ("5 MiB", 5 << 20),
        ("20 MiB", 20 << 20),
    ] {
        let mut put = Vec::new();
        for i in 0..5u32 {
            let mut bytes: Vec<u8> = (0..size as u32)
                .map(|k| (k.wrapping_mul(2_654_435_761) >> 7) as u8)
                .collect();
            bytes[..4].copy_from_slice(&i.to_le_bytes());
            let t = Instant::now();
            let blob = store.put_blob("image/png", bytes).await.unwrap();
            put.push(t.elapsed());
            if i == 4 {
                let t = Instant::now();
                store.blob_for_bench(&blob.sha256).await;
                println!(
                    "blob {label}: put {:.1} ms, get {:.1} ms",
                    put.iter().sum::<Duration>().as_secs_f64() * 1e3 / 5.0,
                    t.elapsed().as_secs_f64() * 1e3
                );
            }
        }
    }
}

trait BlobBench {
    async fn blob_for_bench(&self, sha: &str);
}

impl BlobBench for SqliteStore {
    async fn blob_for_bench(&self, sha: &str) {
        use blame_engine_core::ports::BlobSource;
        self.blob(sha).await.unwrap().unwrap();
    }
}
