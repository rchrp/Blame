//! The changes a `review` helper is asked about.
//!
//! The engine reads them itself, once, with the same `git` it snapshots the
//! workspace with, and gives them to the helper in its instruction. The
//! helper starts nothing: it has no command to run, only the code to read.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;

/// The most of a diff a helper is given; a larger one is cut, and the files
/// it names stay readable with the code tools.
const MAX_DIFF_BYTES: usize = 60 * 1024;
/// Most files named after a cut.
const MAX_LISTED: usize = 200;
const GIT_TIMEOUT: Duration = Duration::from_secs(15);

/// The workspace's uncommitted changes as an instruction block, `None` when
/// the folder is not a git repository.
pub(super) async fn changes(root: &str) -> Option<String> {
    let root = Path::new(root);
    let diff = git(root, &["diff", "--no-color", "--no-ext-diff", "HEAD"]).await?;
    let untracked = git(root, &["ls-files", "--others", "--exclude-standard", "-z"])
        .await
        .unwrap_or_default();
    Some(describe(&diff, &untracked))
}

fn describe(diff: &str, untracked_z: &str) -> String {
    let untracked: Vec<&str> = untracked_z.split('\0').filter(|p| !p.is_empty()).collect();
    if diff.trim().is_empty() && untracked.is_empty() {
        return "The workspace has no uncommitted changes.".into();
    }
    let mut text = String::from("The workspace's current changes (git diff HEAD):\n");
    if diff.len() > MAX_DIFF_BYTES {
        let mut end = MAX_DIFF_BYTES;
        while !diff.is_char_boundary(end) {
            end -= 1;
        }
        text.push_str(&diff[..end]);
        text.push_str("\n[The diff is cut here: read the other changed files.]\n");
    } else {
        text.push_str(diff);
    }
    if !untracked.is_empty() {
        text.push_str("\nNew files, not in the diff:\n");
        for path in untracked.iter().take(MAX_LISTED) {
            text.push_str("- ");
            text.push_str(path);
            text.push('\n');
        }
        if untracked.len() > MAX_LISTED {
            text.push_str(&format!("- and {} more\n", untracked.len() - MAX_LISTED));
        }
    }
    text
}

async fn git(root: &Path, args: &[&str]) -> Option<String> {
    let output = tokio::time::timeout(
        GIT_TIMEOUT,
        Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_changes_are_said_so() {
        assert_eq!(
            describe("", ""),
            "The workspace has no uncommitted changes."
        );
    }

    #[test]
    fn a_long_diff_is_cut_and_new_files_are_listed() {
        let diff = "x".repeat(MAX_DIFF_BYTES + 10);
        let text = describe(&diff, "a.txt\0b.txt\0");
        assert!(text.contains("The diff is cut here"));
        assert!(text.contains("- a.txt\n- b.txt\n"));
        assert!(text.len() < MAX_DIFF_BYTES + 500);
    }
}
