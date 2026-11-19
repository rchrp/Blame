//! Workspace snapshots.
//!
//! Implements the core's `Checkpointer` with git trees kept under a private
//! ref namespace, so snapshots never touch the branch, the index or the
//! stash, and survive any later commit, merge or rebase.
