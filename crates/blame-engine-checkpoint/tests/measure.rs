//! Timings on a real repository. Not part of the normal run:
//!
//! ```text
//! BLAME_CHECKPOINT_BENCH_REPO=/path/to/a/clone cargo test -p blame-engine-checkpoint \
//!     --release --test measure -- --ignored --nocapture
//! ```
//!
//! The repository is modified (edits, then restored): point it at a clone,
//! never at a checkout that matters. Set `BLAME_CHECKPOINT_BENCH_PLAIN=1` to
//! treat it as a folder that is not a repository (delete its `.git` first).

mod common;

use blame_engine_core::ports::Checkpointer;
use common::*;
use std::path::Path;
use std::process::Command;
use std::time::Instant;

fn size_kib(path: &Path) -> u64 {
    let output = Command::new("du").arg("-sk").arg(path).output().unwrap();
    String::from_utf8_lossy(&output.stdout)
        .split_whitespace()
        .next()
        .and_then(|n| n.parse().ok())
        .unwrap_or(0)
}

#[tokio::test]
#[ignore = "needs BLAME_CHECKPOINT_BENCH_REPO"]
async fn measure() {
    let Ok(root) = std::env::var("BLAME_CHECKPOINT_BENCH_REPO") else {
        return;
    };
    let root = std::path::PathBuf::from(root);
    let tmp = Tmp::new();
    let c = checkpointer(&tmp).with_excludes(
        blame_engine_checkpoint::BLAME_WORKSPACE_EXCLUDES
            .iter()
            .copied(),
    );
    let store = if root.join(".git").exists() {
        root.join(".git")
    } else {
        tmp.path().join("private")
    };
    let sid = session("bench");
    let files: Vec<String> = git_files(&root);
    println!(
        "tracked files: {}; store before: {} KiB",
        files.len(),
        size_kib(&store)
    );

    macro_rules! timed {
        ($label:expr, $body:expr) => {{
            let started = Instant::now();
            let value = $body;
            println!(
                "{:<48} {:>9.0?}   store {} KiB",
                $label,
                started.elapsed(),
                size_kib(&store)
            );
            value
        }};
    }

    let first = timed!("first snapshot", c.snapshot(&root, &sid).await.unwrap());
    let again = timed!(
        "second snapshot, nothing changed",
        c.snapshot(&root, &sid).await.unwrap()
    );
    assert_eq!(first, again);

    let edit = |count: usize, tag: &str| {
        for name in files
            .iter()
            .filter(|n| n.ends_with(".ts") || n.ends_with(".md"))
            .take(count)
        {
            let path = root.join(name);
            let mut text = std::fs::read_to_string(&path).unwrap_or_default();
            text.push_str(&format!("\n// edit {tag}\n"));
            std::fs::write(path, text).unwrap();
        }
    };
    edit(1, "one");
    let one = timed!(
        "snapshot after editing 1 file",
        c.snapshot(&root, &sid).await.unwrap()
    );
    edit(30, "thirty");
    for i in 0..30 {
        write(
            &root,
            &format!("bench-new/dir{}/file{i}.txt", i % 5),
            "new file\n",
        );
    }
    let many = timed!(
        "snapshot after 30 edits + 30 new files",
        c.snapshot(&root, &sid).await.unwrap()
    );
    timed!(
        "changes (snapshot vs workspace, clean)",
        c.changes(&root, &many, None).await.unwrap()
    );
    timed!(
        "changes (two snapshots)",
        c.changes(&root, &first, Some(&many)).await.unwrap()
    );

    edit(1, "restore-one");
    timed!(
        "restore, 1 file edited",
        c.restore(&root, &many).await.unwrap()
    );
    edit(30, "restore-many");
    write(&root, "bench-new/extra.txt", "x");
    timed!(
        "restore, 31 files edited/created",
        c.restore(&root, &many).await.unwrap()
    );
    timed!(
        "restore, nothing to do",
        c.restore(&root, &many).await.unwrap()
    );
    timed!(
        "restore to the very first snapshot",
        c.restore(&root, &first).await.unwrap()
    );
    let _ = one;
    timed!("release", c.release(&root, &sid).await.unwrap());
}

fn git_files(root: &Path) -> Vec<String> {
    if !root.join(".git").exists() {
        return walk(root, root);
    }
    git(root, &["ls-files"])
        .lines()
        .map(str::to_owned)
        .collect()
}

fn walk(root: &Path, dir: &Path) -> Vec<String> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).unwrap().flatten() {
        let path = entry.path();
        if path.is_dir() {
            out.extend(walk(root, &path));
        } else {
            out.push(
                path.strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
            );
        }
    }
    out
}
