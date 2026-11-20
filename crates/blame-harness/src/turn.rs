//! One session's operations take turns (`light-commit.ts`'s SessionTurn):
//! a command holds its session's turn while it runs, so Blame can record
//! what each operation changes. Other sessions in the folder only wait for
//! the short workspace lock. During a managed run (one that outlived its
//! call) edits are refused at once with how to wait for the run, and reads
//! skip the turn.

use crate::failure::{Failure, Outcome};
use std::collections::HashMap;
use std::sync::{Arc, Condvar, LazyLock, Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// About as long as the write lock's retries.
const TURN_WAIT: Duration = Duration::from_secs(25);

/// What keeps a session busy: a short operation, or a managed run.
#[derive(Clone, Debug, Default)]
pub struct Holder {
    pub label: String,
    pub run: Option<String>,
}

#[derive(Default)]
struct TurnState {
    busy: bool,
    waiting: usize,
    holder: Option<Holder>,
    /// Counts acquisitions, so a renamed holder is the current one.
    generation: u64,
}

#[derive(Default)]
struct Turn {
    state: Mutex<TurnState>,
    released: Condvar,
}

static TURNS: LazyLock<Mutex<HashMap<String, Arc<Turn>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn turn(root: &str, session: &str) -> Arc<Turn> {
    TURNS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .entry(format!("{root}\0{session}"))
        .or_default()
        .clone()
}

impl Turn {
    fn lock(&self) -> MutexGuard<'_, TurnState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

pub fn busy_message(holder: Option<&Holder>) -> String {
    let Some(holder) = holder else {
        return "The workspace is busy: another Blame session or process is changing it. Retry in a moment.".into();
    };
    let wait = match &holder.run {
        Some(run) => format!(
            " Wait for it with run_task {{\"kind\": \"inspect\", \"run\": \"{run}\"}}, then retry."
        ),
        None => " Retry once it finishes.".into(),
    };
    format!(
        "The workspace is busy: {} is still running. Edits, reads and commands take turns so Blame can record what each one changes.{wait}",
        holder.label
    )
}

/// A held turn, released when dropped.
pub struct TurnGuard {
    turn: Arc<Turn>,
    generation: u64,
}

/// Renames the holder of one acquisition, once it is no longer held a no-op.
#[derive(Clone)]
pub struct HolderHandle {
    turn: Arc<Turn>,
    generation: u64,
}

impl HolderHandle {
    pub fn rename(&self, holder: Holder) {
        let mut state = self.turn.lock();
        if state.busy && state.generation == self.generation {
            state.holder = Some(holder);
        }
    }
}

impl TurnGuard {
    /// Renames what holds the turn (a command that became a managed run).
    pub fn set_holder(&self, holder: Holder) {
        self.handle().rename(holder);
    }

    pub fn handle(&self) -> HolderHandle {
        HolderHandle {
            turn: self.turn.clone(),
            generation: self.generation,
        }
    }
}

impl Drop for TurnGuard {
    fn drop(&mut self) {
        let mut state = self.turn.lock();
        state.holder = None;
        state.busy = false;
        drop(state);
        self.turn.released.notify_one();
    }
}

/// Takes the session's turn, waiting up to 25 s for the previous operation;
/// a managed run refuses at once.
pub fn acquire(root: &str, session: &str, holder: Holder) -> Outcome<TurnGuard> {
    let turn = turn(root, session);
    let mut state = turn.lock();
    if let Some(current) = state
        .holder
        .as_ref()
        .filter(|current| current.run.is_some())
    {
        return Err(Failure::new(busy_message(Some(current))));
    }
    let deadline = Instant::now() + TURN_WAIT;
    state.waiting += 1;
    while state.busy {
        let now = Instant::now();
        if now >= deadline {
            state.waiting -= 1;
            return Err(Failure::new(busy_message(state.holder.as_ref())));
        }
        state = turn
            .released
            .wait_timeout(state, deadline - now)
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .0;
    }
    state.waiting -= 1;
    state.busy = true;
    state.holder = Some(holder);
    state.generation += 1;
    let generation = state.generation;
    drop(state);
    Ok(TurnGuard { turn, generation })
}

/// A read: during the session's own managed run it skips the turn (the
/// agent reads code while its tests run); otherwise it takes it.
pub fn acquire_for_read(root: &str, session: &str) -> Outcome<Option<TurnGuard>> {
    let running = turn(root, session)
        .lock()
        .holder
        .as_ref()
        .is_some_and(|holder| holder.run.is_some());
    if running {
        return Ok(None);
    }
    acquire(
        root,
        session,
        Holder {
            label: "a read".into(),
            run: None,
        },
    )
    .map(Some)
}

/// The holder of the session's turn, if a managed run holds it.
pub fn running(root: &str, session: &str) -> Option<Holder> {
    turn(root, session)
        .lock()
        .holder
        .clone()
        .filter(|holder| holder.run.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_managed_run_refuses_edits() {
        let guard = acquire(
            "/r",
            "s",
            Holder {
                label: "the command `x`".into(),
                run: None,
            },
        )
        .unwrap();
        guard.set_holder(Holder {
            label: "run r1 (`x`)".into(),
            run: Some("r1".into()),
        });
        let refused = acquire("/r", "s", Holder::default()).err().unwrap();
        assert!(
            refused
                .message
                .contains("run_task {\"kind\": \"inspect\", \"run\": \"r1\"}")
        );
        assert!(acquire_for_read("/r", "s").unwrap().is_none());
        drop(guard);
        assert!(acquire("/r", "s", Holder::default()).is_ok());
    }
}
