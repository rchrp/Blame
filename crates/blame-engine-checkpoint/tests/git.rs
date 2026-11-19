mod common;

use blame_engine_core::ports::{CheckpointError, Checkpointer};
use common::*;

#[tokio::test]
async fn restores_modified_deleted_and_created_files() {
    let tmp = Tmp::new();
    let root = repo(&tmp);
    let c = checkpointer(&tmp);
    write(&root, "untracked.txt", "u\n");
    write(&root, "dir/new.txt", "n\n");
    let before = state(&root, true);
    let snap = snapshot(&c, &root, "s1").await;

    write(&root, "a.txt", "changed\n");
    std::fs::remove_file(root.join("dir/b.txt")).unwrap();
    std::fs::remove_file(root.join("untracked.txt")).unwrap();
    write(&root, "created/deep/file.txt", "x\n");
    write(&root, "dir/new.txt", "also changed\n");

    c.restore(&root, &snap).await.unwrap();
    assert_eq!(state(&root, true), before);
}

#[tokio::test]
async fn ignored_files_are_never_touched() {
    let tmp = Tmp::new();
    let root = repo(&tmp);
    let c = checkpointer(&tmp);
    write(&root, "node_modules/pkg/index.js", "v1\n");
    write(&root, ".env", "SECRET=1\n");
    write(&root, "debug.log", "old\n");
    let snap = snapshot(&c, &root, "s1").await;

    write(&root, "node_modules/pkg/index.js", "v2\n");
    write(&root, "node_modules/other/new.js", "new\n");
    write(&root, ".env", "SECRET=2\n");
    std::fs::remove_file(root.join("debug.log")).unwrap();
    write(&root, "a.txt", "changed\n");
    let ignored_before: Vec<_> = state(&root, false)
        .into_iter()
        .filter(|(p, _)| p.starts_with("node_modules") || p == ".env")
        .collect();

    c.restore(&root, &snap).await.unwrap();
    assert_eq!(read(&root, "a.txt"), "a\n");
    let ignored_after: Vec<_> = state(&root, false)
        .into_iter()
        .filter(|(p, _)| p.starts_with("node_modules") || p == ".env")
        .collect();
    assert_eq!(ignored_before, ignored_after);
    assert!(!exists(&root, "debug.log"), "ignored file stays deleted");
    assert!(!snapshot_lists(&root, &snap, "node_modules").await);
}

async fn snapshot_lists(root: &std::path::Path, tree: &str, needle: &str) -> bool {
    git(root, &["ls-tree", "-r", "--name-only", tree]).contains(needle)
}

#[tokio::test]
async fn file_replaced_by_directory_and_back() {
    let tmp = Tmp::new();
    let root = repo(&tmp);
    let c = checkpointer(&tmp);
    write(&root, "swap/inner.txt", "inside\n");
    let snap = snapshot(&c, &root, "s1").await;

    // a.txt (file) -> directory; swap (directory) -> file.
    std::fs::remove_file(root.join("a.txt")).unwrap();
    write(&root, "a.txt/child.txt", "c\n");
    std::fs::remove_dir_all(root.join("swap")).unwrap();
    write(&root, "swap", "now a file\n");
    c.restore(&root, &snap).await.unwrap();
    assert_eq!(read(&root, "a.txt"), "a\n");
    assert_eq!(read(&root, "swap/inner.txt"), "inside\n");

    // And the snapshot of the swapped layout restores too.
    std::fs::remove_file(root.join("a.txt")).unwrap();
    write(&root, "a.txt/child.txt", "c\n");
    let swapped = snapshot(&c, &root, "s1").await;
    std::fs::remove_dir_all(root.join("a.txt")).unwrap();
    write(&root, "a.txt", "file again\n");
    c.restore(&root, &swapped).await.unwrap();
    assert_eq!(read(&root, "a.txt/child.txt"), "c\n");
}

#[cfg(unix)]
#[tokio::test]
async fn keeps_executable_bit_and_symlinks() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let tmp = Tmp::new();
    let root = repo(&tmp);
    let c = checkpointer(&tmp);
    write(&root, "run.sh", "#!/bin/sh\n");
    std::fs::set_permissions(root.join("run.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
    symlink("a.txt", root.join("link")).unwrap();
    symlink("missing-target", root.join("dangling")).unwrap();
    symlink("dir", root.join("dirlink")).unwrap();
    let before = state(&root, true);
    let snap = snapshot(&c, &root, "s1").await;

    std::fs::set_permissions(root.join("run.sh"), std::fs::Permissions::from_mode(0o644)).unwrap();
    std::fs::remove_file(root.join("link")).unwrap();
    write(&root, "link", "was a link\n");
    std::fs::remove_file(root.join("dirlink")).unwrap();
    symlink("elsewhere", root.join("dirlink")).unwrap();
    c.restore(&root, &snap).await.unwrap();
    assert_eq!(state(&root, true), before);
}

#[tokio::test]
async fn unusual_paths() {
    let tmp = Tmp::new();
    let root = repo(&tmp);
    let c = checkpointer(&tmp);
    let mut names = vec![
        "with space.txt",
        "dir with space/inner file.txt",
        "été/naïve—日本語.txt",
        "-leading-dash.txt",
        "quote\"d.txt",
        "back\\slash.txt",
        "hash#and$pct%.txt",
        "!bang.txt",
        "[bracket].txt",
    ];
    // Not representable on Windows.
    if cfg!(unix) {
        names.push("new\nline.txt");
        names.push("tab\there.txt");
        names.push("star*.txt");
    }
    for name in &names {
        write(&root, name, &format!("content of {name}\n"));
    }
    let before = state(&root, true);
    let snap = snapshot(&c, &root, "s1").await;
    for name in &names {
        std::fs::remove_file(root.join(name)).unwrap();
    }
    c.restore(&root, &snap).await.unwrap();
    assert_eq!(state(&root, true), before);
}

#[tokio::test]
async fn empty_directories_are_not_snapshotted_and_emptied_ones_go() {
    let tmp = Tmp::new();
    let root = repo(&tmp);
    let c = checkpointer(&tmp);
    std::fs::create_dir_all(root.join("empty")).unwrap();
    let snap = snapshot(&c, &root, "s1").await;

    write(&root, "made/deeper/file.txt", "x\n");
    std::fs::create_dir_all(root.join("also-empty")).unwrap();
    c.restore(&root, &snap).await.unwrap();
    // The directory the restore emptied is gone, with its parents.
    assert!(!exists(&root, "made"));
    // Directories nobody could ever restore are left as they are.
    assert!(exists(&root, "empty"));
    assert!(exists(&root, "also-empty"));
}

#[tokio::test]
async fn submodules_and_nested_repositories_are_left_alone() {
    let tmp = Tmp::new();
    let root = repo(&tmp);
    let c = checkpointer(&tmp);
    // A submodule, with a modified file inside.
    let upstream = tmp.path().join("upstream");
    std::fs::create_dir_all(&upstream).unwrap();
    git(&upstream, &["init", "-q", "-b", "main", "."]);
    write(&upstream, "lib.txt", "lib\n");
    git(&upstream, &["add", "-A"]);
    git(&upstream, &["commit", "-q", "-m", "lib"]);
    git(
        &root,
        &[
            "submodule",
            "add",
            "-q",
            upstream.to_str().unwrap(),
            "vendor/lib",
        ],
    );
    git(&root, &["commit", "-q", "-m", "add submodule"]);
    // A nested repository that is not a submodule.
    let nested = root.join("nested");
    std::fs::create_dir_all(&nested).unwrap();
    git(&nested, &["init", "-q", "-b", "main", "."]);
    write(&nested, "n.txt", "n\n");

    let snap = snapshot(&c, &root, "s1").await;
    let listed = git(&root, &["ls-tree", "-r", "--name-only", &snap]);
    assert!(!listed.contains("vendor/lib"), "{listed}");
    assert!(!listed.contains("nested"), "{listed}");
    assert!(listed.contains(".gitmodules"));

    write(&root, "vendor/lib/lib.txt", "edited in the submodule\n");
    write(&nested, "n.txt", "edited nested\n");
    write(&root, "a.txt", "changed\n");
    c.restore(&root, &snap).await.unwrap();
    assert_eq!(read(&root, "a.txt"), "a\n");
    assert_eq!(
        read(&root, "vendor/lib/lib.txt"),
        "edited in the submodule\n"
    );
    assert_eq!(read(&root, "nested/n.txt"), "edited nested\n");
    assert!(git(&nested, &["status", "--short"]).contains("n.txt"));
}

#[tokio::test]
async fn two_sessions_in_two_linked_worktrees_do_not_see_each_other() {
    let tmp = Tmp::new();
    let root = repo(&tmp);
    let one = tmp.path().join("wt-one");
    let two = tmp.path().join("wt-two");
    git(
        &root,
        &["worktree", "add", "-q", "-b", "one", one.to_str().unwrap()],
    );
    git(
        &root,
        &["worktree", "add", "-q", "-b", "two", two.to_str().unwrap()],
    );
    let c = checkpointer(&tmp);

    write(&one, "only-in-one.txt", "1\n");
    write(&two, "only-in-two.txt", "2\n");
    let snap_one = snapshot(&c, &one, "session-one").await;
    let snap_two = snapshot(&c, &two, "session-two").await;

    write(&one, "a.txt", "one edit\n");
    write(&two, "a.txt", "two edit\n");
    std::fs::remove_file(one.join("only-in-one.txt")).unwrap();
    c.restore(&one, &snap_one).await.unwrap();
    assert_eq!(read(&one, "a.txt"), "a\n");
    assert!(exists(&one, "only-in-one.txt"));
    assert!(!exists(&one, "only-in-two.txt"));
    // The other worktree did not move.
    assert_eq!(read(&two, "a.txt"), "two edit\n");

    c.restore(&two, &snap_two).await.unwrap();
    assert_eq!(read(&two, "a.txt"), "a\n");
    assert!(!exists(&two, "only-in-one.txt"));
    // Releasing one session keeps the other's snapshot.
    c.release(&one, &session("session-one")).await.unwrap();
    let refs = git(&root, &["for-each-ref", "refs/blame/checkpoints/"]);
    assert!(
        refs.contains("session-two") && !refs.contains("session-one"),
        "{refs}"
    );
    // The main checkout is untouched by all of it.
    assert!(!exists(&root, "only-in-one.txt"));
    // A snapshot of a worktree restored from the main checkout's point of
    // view still finds the object: refs are shared by the repository.
    c.restore(&two, &snap_two).await.unwrap();
}

#[tokio::test]
async fn restores_after_commits_branch_switch_and_rebase() {
    let tmp = Tmp::new();
    let root = repo(&tmp);
    let c = checkpointer(&tmp);
    git(&root, &["checkout", "-q", "-b", "feature"]);
    write(&root, "feature.txt", "f\n");
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-q", "-m", "feature"]);
    write(&root, "a.txt", "work in progress\n");
    write(&root, "scratch.txt", "s\n");
    let before = state(&root, false);
    let snap = snapshot(&c, &root, "s1").await;

    // The agent commits, the main branch moves, the feature is rebased.
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-q", "-m", "wip"]);
    git(&root, &["checkout", "-q", "main"]);
    write(&root, "main-only.txt", "m\n");
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-q", "-m", "main moves"]);
    git(&root, &["checkout", "-q", "feature"]);
    git(&root, &["rebase", "-q", "main"]);
    git(&root, &["gc", "-q", "--prune=now"]);
    write(&root, "a.txt", "something else\n");
    let (index, refs, head) = user_state(&root);

    c.restore(&root, &snap).await.unwrap();
    // History untouched; the restored content shows up against the new HEAD.
    let (index_after, refs_after, head_after) = user_state(&root);
    assert_eq!((&refs, &head), (&refs_after, &head_after));
    assert_eq!(index, index_after, "the user's index is not written");
    let after = state(&root, false);
    // main-only.txt is committed on the rebased branch but the snapshot did
    // not have it: a snapshot is a state of the files, so it goes.
    let mut expected = before.clone();
    expected.remove("main-only.txt");
    assert_eq!(after, expected);
    assert!(git(&root, &["status", "--short"]).contains("main-only.txt"));

    // Switching branches and restoring again works the same.
    git(&root, &["stash", "-q", "-u"]);
    git(&root, &["checkout", "-q", "main"]);
    c.restore(&root, &snap).await.unwrap();
    assert_eq!(state(&root, false), expected);
}

#[tokio::test]
async fn restoring_twice_gives_the_same_result() {
    let tmp = Tmp::new();
    let root = repo(&tmp);
    let c = checkpointer(&tmp);
    write(&root, "u.txt", "u\n");
    let snap = snapshot(&c, &root, "s1").await;
    let before = state(&root, true);
    write(&root, "a.txt", "x\n");
    write(&root, "extra/y.txt", "y\n");
    c.restore(&root, &snap).await.unwrap();
    let once = state(&root, true);
    c.restore(&root, &snap).await.unwrap();
    assert_eq!(state(&root, true), once);
    assert_eq!(once, before);
}

#[tokio::test]
async fn an_interrupted_restore_is_finished_by_running_it_again() {
    let tmp = Tmp::new();
    let root = repo(&tmp);
    let c = checkpointer(&tmp);
    write(&root, "one.txt", "1\n");
    write(&root, "two.txt", "2\n");
    write(&root, "three/three.txt", "3\n");
    let before = state(&root, true);
    let snap = snapshot(&c, &root, "s1").await;

    write(&root, "a.txt", "changed\n");
    write(&root, "one.txt", "changed\n");
    std::fs::remove_file(root.join("two.txt")).unwrap();
    std::fs::remove_dir_all(root.join("three")).unwrap();
    write(&root, "late.txt", "created\n");
    // What a restore killed halfway leaves behind: some files back in place,
    // one truncated, the rest as the agent left them. A stale scratch index
    // from the dead process is lying around too.
    write(&root, "a.txt", "a\n");
    write(&root, "one.txt", "");
    let meta = std::path::PathBuf::from(git(&root, &["rev-parse", "--absolute-git-dir"]).trim())
        .join("blame-checkpoints");
    std::fs::write(meta.join("restore.index"), b"garbage").unwrap();
    c.restore(&root, &snap).await.unwrap();
    assert_eq!(state(&root, true), before);
}

#[tokio::test]
async fn staged_and_conflicted_index_entries_do_not_matter() {
    let tmp = Tmp::new();
    let root = repo(&tmp);
    let c = checkpointer(&tmp);
    // A merge conflict on a.txt, plus a staged new file and a staged edit.
    git(&root, &["checkout", "-q", "-b", "other"]);
    write(&root, "a.txt", "other side\n");
    git(&root, &["commit", "-q", "-am", "other"]);
    git(&root, &["checkout", "-q", "main"]);
    write(&root, "a.txt", "main side\n");
    git(&root, &["commit", "-q", "-am", "main"]);
    git_lenient(&root, &["merge", "other"]);
    assert!(git(&root, &["ls-files", "-u"]).contains("a.txt"));
    write(&root, "staged-new.txt", "s\n");
    git(&root, &["add", "staged-new.txt"]);
    write(&root, "dir/b.txt", "staged edit\n");
    git(&root, &["add", "dir/b.txt"]);
    write(&root, "dir/b.txt", "edit after staging\n");
    write(&root, "intent.txt", "i\n");
    git(&root, &["add", "-N", "intent.txt"]);
    let before_files = state(&root, false);
    let user_index = user_state(&root);
    let unmerged = git(&root, &["ls-files", "-u"]);

    let snap = snapshot(&c, &root, "s1").await;
    assert_eq!(
        user_state(&root),
        user_index,
        "snapshot leaves the index alone"
    );
    assert_eq!(git(&root, &["ls-files", "-u"]), unmerged);
    let tree = git(&root, &["ls-tree", "-r", &snap]);
    assert!(tree.contains("a.txt") && tree.contains("staged-new.txt"));

    write(&root, "a.txt", "resolved some other way\n");
    write(&root, "staged-new.txt", "gone wrong\n");
    c.restore(&root, &snap).await.unwrap();
    assert_eq!(state(&root, false), before_files);
    assert_eq!(
        user_state(&root),
        user_index,
        "restore leaves the index alone"
    );
    assert_eq!(git(&root, &["ls-files", "-u"]), unmerged);
}

#[tokio::test]
async fn release_drops_the_session_refs_and_only_those() {
    let tmp = Tmp::new();
    let root = repo(&tmp);
    let c = checkpointer(&tmp);
    let first = snapshot(&c, &root, "keep").await;
    write(&root, "a.txt", "2\n");
    let second = snapshot(&c, &root, "drop").await;
    write(&root, "a.txt", "3\n");
    let third = snapshot(&c, &root, "drop").await;
    let refs = git(
        &root,
        &["for-each-ref", "--format=%(refname)", "refs/blame/"],
    );
    assert_eq!(refs.lines().count(), 3, "{refs}");

    c.release(&root, &session("drop")).await.unwrap();
    let refs = git(
        &root,
        &["for-each-ref", "--format=%(refname)", "refs/blame/"],
    );
    assert_eq!(refs.lines().count(), 1, "{refs}");
    assert!(refs.contains("keep"));
    // Releasing again, or an unknown session, is not an error.
    c.release(&root, &session("drop")).await.unwrap();
    c.release(&root, &session("never-existed")).await.unwrap();
    c.restore(&root, &first).await.unwrap();

    // Without a ref nothing holds the snapshot: after a gc it is gone.
    git(&root, &["gc", "-q", "--prune=now"]);
    for gone in [second, third] {
        match c.restore(&root, &gone).await {
            Err(CheckpointError::MissingSnapshot(_)) => {}
            other => panic!("expected MissingSnapshot, got {other:?}"),
        }
    }
    c.restore(&root, &first).await.unwrap();
}

#[tokio::test]
async fn unknown_or_malformed_references_are_missing_snapshots() {
    let tmp = Tmp::new();
    let root = repo(&tmp);
    let c = checkpointer(&tmp);
    for bad in [
        "",
        "HEAD",
        "--help",
        "main",
        "deadbeef",
        &"0".repeat(40),
        "refs/heads/main",
    ] {
        match c.restore(&root, bad).await {
            Err(CheckpointError::MissingSnapshot(_)) => {}
            other => panic!("{bad:?}: expected MissingSnapshot, got {other:?}"),
        }
    }
}

#[tokio::test]
async fn session_ids_with_unusual_characters_are_kept_apart() {
    let tmp = Tmp::new();
    let root = repo(&tmp);
    let c = checkpointer(&tmp);
    let ids = [
        "Upper",
        "upper",
        "a/b",
        "a%2fb",
        "..",
        "x.lock",
        "ünï",
        "with space",
    ];
    let mut snaps = Vec::new();
    for id in ids {
        write(&root, "a.txt", id);
        snaps.push(snapshot(&c, &root, id).await);
    }
    for (id, snap) in ids.iter().zip(&snaps) {
        c.restore(&root, snap).await.unwrap();
        assert_eq!(read(&root, "a.txt"), *id);
    }
    c.release(&root, &session("a/b")).await.unwrap();
    let refs = git(
        &root,
        &["for-each-ref", "--format=%(refname)", "refs/blame/"],
    );
    assert_eq!(refs.lines().count(), ids.len() - 1, "{refs}");
}

#[tokio::test]
async fn an_empty_session_id_is_refused() {
    let tmp = Tmp::new();
    let root = repo(&tmp);
    let c = checkpointer(&tmp);
    assert!(c.snapshot(&root, &session("")).await.is_err());
}

#[tokio::test]
async fn works_in_a_repository_without_commits() {
    let tmp = Tmp::new();
    let root = tmp.path().join("fresh");
    std::fs::create_dir_all(&root).unwrap();
    git(&root, &["init", "-q", "-b", "main", "."]);
    let c = checkpointer(&tmp);
    write(&root, "first.txt", "1\n");
    let snap = snapshot(&c, &root, "s1").await;
    write(&root, "first.txt", "2\n");
    write(&root, "second.txt", "2\n");
    c.restore(&root, &snap).await.unwrap();
    assert_eq!(read(&root, "first.txt"), "1\n");
    assert!(!exists(&root, "second.txt"));
}

#[tokio::test]
async fn an_empty_workspace_can_be_snapshotted_and_restored() {
    let tmp = Tmp::new();
    let root = tmp.path().join("plain");
    std::fs::create_dir_all(&root).unwrap();
    let c = checkpointer(&tmp);
    let snap = snapshot(&c, &root, "s1").await;
    write(&root, "x.txt", "x\n");
    c.restore(&root, &snap).await.unwrap();
    assert!(!exists(&root, "x.txt"));
}

#[tokio::test]
async fn a_folder_that_is_not_a_repository_uses_a_private_one() {
    let tmp = Tmp::new();
    let root = tmp.path().join("plain");
    write(&root, "a.txt", "a\n");
    write(&root, "sub/b.txt", "b\n");
    write(&root, "skipped/c.log", "log\n");
    write(&root, ".gitignore", "*.log\n");
    write(&root, "nested/.git/HEAD", "ref: refs/heads/main\n");
    let c = checkpointer(&tmp);
    let before = state(&root, true);
    let snap = snapshot(&c, &root, "s1").await;
    assert!(!root.join(".git").exists(), "the workspace is not modified");
    assert_eq!(
        state(&root, true),
        before,
        "snapshot writes nothing in the workspace"
    );

    write(&root, "a.txt", "changed\n");
    std::fs::remove_file(root.join("sub/b.txt")).unwrap();
    write(&root, "new/n.txt", "n\n");
    write(&root, "skipped/c.log", "changed log\n");
    let list = c.changes(&root, &snap, None).await.unwrap();
    assert_eq!(
        changes(&list),
        vec![
            ("a.txt".to_string(), "modified"),
            ("new/n.txt".to_string(), "added"),
            ("sub/b.txt".to_string(), "deleted"),
        ]
    );
    c.restore(&root, &snap).await.unwrap();
    let mut expected = before;
    expected.insert(
        "skipped/c.log".into(),
        state(&root, true)["skipped/c.log"].clone(),
    );
    assert_eq!(state(&root, true), expected);

    // Releasing the last snapshot frees the private repository.
    let private = tmp.path().join("private");
    assert!(std::fs::read_dir(&private).unwrap().next().is_some());
    c.release(&root, &session("s1")).await.unwrap();
    assert!(std::fs::read_dir(&private).unwrap().next().is_none());
    assert!(matches!(
        c.restore(&root, &snap).await,
        Err(CheckpointError::MissingSnapshot(_))
    ));
}

#[tokio::test]
async fn a_subdirectory_of_a_repository_snapshots_only_itself() {
    let tmp = Tmp::new();
    let outer = repo(&tmp);
    let root = outer.join("packages/app");
    write(&root, "src/main.rs", "fn main() {}\n");
    let c = checkpointer(&tmp);
    let snap = snapshot(&c, &root, "s1").await;
    write(&root, "src/main.rs", "changed\n");
    write(&outer, "a.txt", "outer edit\n");
    c.restore(&root, &snap).await.unwrap();
    assert_eq!(read(&root, "src/main.rs"), "fn main() {}\n");
    assert_eq!(
        read(&outer, "a.txt"),
        "outer edit\n",
        "files above the workspace are not ours"
    );
    // Nothing was written into the outer repository.
    assert!(git(&outer, &["for-each-ref", "refs/blame/"]).is_empty());
}

#[tokio::test]
async fn changes_between_snapshots_and_against_the_workspace() {
    let tmp = Tmp::new();
    let root = repo(&tmp);
    let c = checkpointer(&tmp);
    let first = snapshot(&c, &root, "s1").await;
    write(&root, "a.txt", "changed\n");
    write(&root, "added.txt", "new\n");
    std::fs::remove_file(root.join("dir/b.txt")).unwrap();
    let second = snapshot(&c, &root, "s1").await;
    write(&root, "added.txt", "newer\n");
    write(&root, "again.txt", "x\n");
    let refs_before = git(&root, &["for-each-ref", "refs/blame/"]);

    let between = c.changes(&root, &first, Some(&second)).await.unwrap();
    assert_eq!(
        changes(&between),
        vec![
            ("a.txt".to_string(), "modified"),
            ("added.txt".to_string(), "added"),
            ("dir/b.txt".to_string(), "deleted"),
        ]
    );
    let now = c.changes(&root, &second, None).await.unwrap();
    assert_eq!(
        changes(&now),
        vec![
            ("added.txt".to_string(), "modified"),
            ("again.txt".to_string(), "added"),
        ]
    );
    assert!(
        c.changes(&root, &second, Some(&second))
            .await
            .unwrap()
            .is_empty()
    );
    // Looking does not leave anything behind.
    assert_eq!(git(&root, &["for-each-ref", "refs/blame/"]), refs_before);
    assert_eq!(read(&root, "added.txt"), "newer\n");
}

#[tokio::test]
async fn changes_do_not_write_objects_for_the_transient_state() {
    let tmp = Tmp::new();
    let root = repo(&tmp);
    let c = checkpointer(&tmp);
    let snap = snapshot(&c, &root, "s1").await;
    let unique = "a unique transient content that no object has ".repeat(10);
    write(&root, "transient.txt", &unique);
    let list = c.changes(&root, &snap, None).await.unwrap();
    assert_eq!(changes(&list), vec![("transient.txt".to_string(), "added")]);
    let hash = git(&root, &["hash-object", "transient.txt"]);
    let (code, _) = {
        let status = std::process::Command::new("git")
            .current_dir(&root)
            .args(["cat-file", "-e", hash.trim()])
            .status()
            .unwrap();
        (status.code().unwrap(), ())
    };
    assert_ne!(code, 0, "the blob must not have been stored");
}

#[tokio::test]
async fn hooks_and_fsmonitor_of_the_user_never_run() {
    let tmp = Tmp::new();
    let root = repo(&tmp);
    let marker = tmp.path().join("marker");
    let hooks = root.join(".git/hooks");
    std::fs::create_dir_all(&hooks).unwrap();
    let script = format!("#!/bin/sh\necho ran >> {}\n", marker.display());
    for hook in [
        "reference-transaction",
        "post-checkout",
        "post-index-change",
        "pre-commit",
        "fsmonitor-watchman",
    ] {
        std::fs::write(hooks.join(hook), &script).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(hooks.join(hook), std::fs::Permissions::from_mode(0o755))
                .unwrap();
        }
    }
    let monitor = tmp.path().join("monitor.sh");
    std::fs::write(&monitor, &script).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&monitor, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    git(
        &root,
        &["config", "core.fsmonitor", monitor.to_str().unwrap()],
    );
    git(
        &root,
        &["config", "core.hooksPath", hooks.to_str().unwrap()],
    );
    let c = checkpointer(&tmp);
    write(&root, "u.txt", "u\n");
    let snap = snapshot(&c, &root, "s1").await;
    write(&root, "a.txt", "x\n");
    c.restore(&root, &snap).await.unwrap();
    c.changes(&root, &snap, None).await.unwrap();
    c.release(&root, &session("s1")).await.unwrap();
    assert!(
        !marker.exists(),
        "a user hook ran: {:?}",
        std::fs::read_to_string(&marker)
    );
}

#[tokio::test]
async fn a_user_git_command_holding_the_index_lock_does_not_block_us() {
    let tmp = Tmp::new();
    let root = repo(&tmp);
    let c = checkpointer(&tmp);
    let git_dir = std::path::PathBuf::from(git(&root, &["rev-parse", "--absolute-git-dir"]).trim());
    std::fs::write(git_dir.join("index.lock"), b"").unwrap();
    write(&root, "u.txt", "u\n");
    let snap = snapshot(&c, &root, "s1").await;
    write(&root, "a.txt", "x\n");
    c.restore(&root, &snap).await.unwrap();
    assert_eq!(read(&root, "a.txt"), "a\n");
    assert!(
        git_dir.join("index.lock").exists(),
        "the user's lock is theirs"
    );
}

#[tokio::test]
async fn excluded_paths_are_neither_saved_nor_restored() {
    let tmp = Tmp::new();
    let root = tmp.path().join("repo");
    std::fs::create_dir_all(&root).unwrap();
    git(&root, &["init", "-q", "-b", "main", "."]);
    write(&root, "a.txt", "a\n");
    write(&root, ".env.example", "KEY=\n");
    write(&root, ".env.test", "tracked secret\n");
    git(&root, &["add", "-A"]);
    git(
        &root,
        &[
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "commit",
            "-q",
            "-m",
            "one",
        ],
    );
    let c = checkpointer(&tmp).with_excludes(
        blame_engine_checkpoint::BLAME_WORKSPACE_EXCLUDES
            .iter()
            .copied(),
    );
    // Not in .gitignore: only the exclusion list keeps them out.
    write(&root, ".env", "SECRET=1\n");
    write(&root, "apps/web/.env.local", "SECRET=2\n");
    write(&root, ".blame/state.json", "{}\n");
    write(&root, "apps/web/.env.local.example", "SECRET=\n");
    let snap = snapshot(&c, &root, "s1").await;
    let listed = git(&root, &["ls-tree", "-r", "--name-only", &snap]);
    assert!(listed.contains(".env.example"), "{listed}");
    assert!(listed.contains("apps/web/.env.local.example"), "{listed}");
    let names: Vec<&str> = listed.lines().collect();
    for secret in [
        ".env",
        "apps/web/.env.local",
        ".env.test",
        ".blame/state.json",
    ] {
        assert!(!names.contains(&secret), "{secret} in {listed}");
    }

    // Blame rewrites its files while the agent works; a rewind keeps them.
    write(&root, ".env", "SECRET=rewritten\n");
    write(&root, ".blame/state.json", "{\"new\":1}\n");
    write(&root, ".env.test", "edited tracked secret\n");
    write(&root, ".env.example", "KEY=changed\n");
    write(&root, "a.txt", "changed\n");
    let list = c.changes(&root, &snap, None).await.unwrap();
    assert_eq!(
        changes(&list),
        vec![
            (".env.example".to_string(), "modified"),
            ("a.txt".to_string(), "modified"),
        ]
    );
    c.restore(&root, &snap).await.unwrap();
    assert_eq!(read(&root, "a.txt"), "a\n");
    assert_eq!(read(&root, ".env.example"), "KEY=\n");
    assert_eq!(read(&root, ".env"), "SECRET=rewritten\n");
    assert_eq!(read(&root, ".blame/state.json"), "{\"new\":1}\n");
    assert_eq!(read(&root, ".env.test"), "edited tracked secret\n");
}

#[tokio::test]
async fn line_endings_follow_the_users_git_configuration() {
    let tmp = Tmp::new();
    let root = repo(&tmp);
    git(&root, &["config", "core.autocrlf", "true"]);
    let c = checkpointer(&tmp);
    write_bytes(&root, "crlf.txt", b"one\r\ntwo\r\n");
    write_bytes(&root, "lf.txt", b"one\ntwo\n");
    write_bytes(&root, "mixed.txt", b"one\r\ntwo\nthree\r\n");
    write_bytes(&root, "binary.bin", &[0, 1, 2, b'\r', b'\n', 0, 255]);
    let before = state(&root, false);
    let snap = snapshot(&c, &root, "s1").await;
    for name in ["crlf.txt", "lf.txt", "mixed.txt", "binary.bin"] {
        write(&root, name, "changed\n");
    }
    c.restore(&root, &snap).await.unwrap();
    let after = state(&root, false);
    // Files whose line endings match the configuration, and binaries, come
    // back byte for byte.
    for name in ["crlf.txt", "binary.bin"] {
        assert_eq!(after[name], before[name], "{name}");
    }
    // A file the agent changed is written the way `git checkout` writes it:
    // an LF-only file comes back with CRLF under autocrlf=true.
    assert!(after["lf.txt"].contains("\\r\\n"), "{:?}", after["lf.txt"]);
    // The tree holds what `git add` would: LF.
    let blob = git(&root, &["ls-tree", &snap, "crlf.txt"]);
    let sha = blob.split_whitespace().nth(2).unwrap().to_string();
    assert_eq!(git(&root, &["cat-file", "-p", &sha]), "one\ntwo\n");
    // Mixed endings are what git normalises: reported, not asserted equal.
    eprintln!("mixed after restore: {:?}", after["mixed.txt"]);
}

#[tokio::test]
async fn sparse_checkout_neither_hides_nor_deletes_files() {
    let tmp = Tmp::new();
    let root = repo(&tmp);
    write(&root, "other/o.txt", "o\n");
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-q", "-m", "other"]);
    git(
        &root,
        &["sparse-checkout", "set", "--no-cone", "/dir/", "/a.txt"],
    );
    assert!(!exists(&root, "other/o.txt"));
    let c = checkpointer(&tmp);
    write(&root, "dir/new.txt", "n\n");
    write(
        &root,
        "outside/created.txt",
        "agent made this outside the cone\n",
    );
    let before = state(&root, false);
    let snap = snapshot(&c, &root, "s1").await;
    let listed = git(&root, &["ls-tree", "-r", "--name-only", &snap]);
    assert!(
        !listed.contains("other/o.txt"),
        "files not on disk are not in the snapshot"
    );
    assert!(listed.contains("outside/created.txt"));

    write(&root, "a.txt", "x\n");
    std::fs::remove_file(root.join("outside/created.txt")).unwrap();
    c.restore(&root, &snap).await.unwrap();
    assert_eq!(state(&root, false), before);
    assert!(
        !exists(&root, "other/o.txt"),
        "restore does not widen the sparse checkout"
    );
    assert_eq!(
        git(&root, &["config", "core.sparseCheckout"]).trim(),
        "true"
    );
}

#[tokio::test]
async fn a_large_binary_file_round_trips() {
    let tmp = Tmp::new();
    let root = repo(&tmp);
    let c = checkpointer(&tmp);
    // 64 MiB of pseudo-random bytes (incompressible).
    let mut data = Vec::with_capacity(64 << 20);
    let mut x: u64 = 0x9e37_79b9_7f4a_7c15;
    while data.len() < 64 << 20 {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        data.extend_from_slice(&x.to_le_bytes());
    }
    write_bytes(&root, "big.bin", &data);
    let started = std::time::Instant::now();
    let snap = snapshot(&c, &root, "s1").await;
    eprintln!("64 MiB first snapshot: {:?}", started.elapsed());
    let started = std::time::Instant::now();
    let again = snapshot(&c, &root, "s1").await;
    eprintln!(
        "64 MiB second snapshot (unchanged): {:?}",
        started.elapsed()
    );
    assert_eq!(snap, again, "an unchanged workspace gives the same tree");
    write_bytes(&root, "big.bin", b"small now");
    c.restore(&root, &snap).await.unwrap();
    assert_eq!(std::fs::read(root.join("big.bin")).unwrap(), data);
}

#[tokio::test]
async fn a_second_snapshot_of_an_unchanged_workspace_is_the_same_tree() {
    let tmp = Tmp::new();
    let root = repo(&tmp);
    let c = checkpointer(&tmp);
    write(&root, "u.txt", "u\n");
    let one = snapshot(&c, &root, "s1").await;
    let two = snapshot(&c, &root, "s1").await;
    assert_eq!(one, two);
    // And a clean checkout's tree is HEAD's tree: no new objects needed.
    std::fs::remove_file(root.join("u.txt")).unwrap();
    let clean = snapshot(&c, &root, "s1").await;
    assert_eq!(clean, git(&root, &["rev-parse", "HEAD^{tree}"]).trim());
}

#[tokio::test]
async fn a_damaged_private_index_is_rebuilt() {
    let tmp = Tmp::new();
    let root = repo(&tmp);
    let c = checkpointer(&tmp);
    let one = snapshot(&c, &root, "s1").await;
    let meta = std::path::PathBuf::from(git(&root, &["rev-parse", "--absolute-git-dir"]).trim())
        .join("blame-checkpoints");
    std::fs::write(meta.join("s1.index"), b"not an index").unwrap();
    let two = snapshot(&c, &root, "s1").await;
    assert_eq!(one, two);
}

#[tokio::test]
async fn a_restarted_engine_can_restore() {
    let tmp = Tmp::new();
    let root = repo(&tmp);
    let snap = {
        let c = checkpointer(&tmp);
        write(&root, "u.txt", "u\n");
        snapshot(&c, &root, "s1").await
    };
    write(&root, "u.txt", "changed\n");
    write(&root, "a.txt", "changed\n");
    let fresh = checkpointer(&tmp);
    fresh.restore(&root, &snap).await.unwrap();
    assert_eq!(read(&root, "u.txt"), "u\n");
    assert_eq!(read(&root, "a.txt"), "a\n");
}

#[tokio::test]
async fn concurrent_sessions_on_one_repository() {
    let tmp = Tmp::new();
    let root = repo(&tmp);
    let c = checkpointer(&tmp);
    let (sa, sb) = (session("a"), session("b"));
    let (a, b, d) = tokio::join!(
        c.snapshot(&root, &sa),
        c.snapshot(&root, &sb),
        c.snapshot(&root, &sa),
    );
    a.unwrap();
    b.unwrap();
    d.unwrap();
}

#[tokio::test]
async fn a_missing_workspace_is_unsupported() {
    let tmp = Tmp::new();
    let c = checkpointer(&tmp);
    match c.snapshot(&tmp.path().join("nope"), &session("s")).await {
        Err(CheckpointError::Unsupported(_)) => {}
        other => panic!("{other:?}"),
    }
}
