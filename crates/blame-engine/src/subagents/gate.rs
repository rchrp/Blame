//! How many helpers may exist, and how many may run.
//!
//! Three limits, from the one that protects the person's wallet to the one
//! that protects their machine:
//!
//! - a **turn** starts at most [`PER_TURN`] helpers: two full calls. More is
//!   the lead doing what it should read or decide itself.
//! - a **session** runs at most [`PER_SESSION`] at once: one full call, even
//!   when the lead asks for two in one reply.
//! - the **engine** runs at most [`PER_ENGINE`] at once, whatever the
//!   sessions ask. Blame runs up to three stories at once, and three stories
//!   with four helpers each would be twelve streams on one key: past most
//!   plans' rate limits, and twelve more callers of the one harness process.
//!   Six is two per story and leaves each story's lead its own stream. The
//!   helpers over the limit wait for a slot, first come first served, and
//!   show as waiting; nothing is refused for it.
//!
//! The first count lives in memory and starts again with the engine (after a
//! crash the turn's allowance restarts, and the limits above still hold);
//! the other two are counts of what runs now, so they can only be memory.

use blame_engine_protocol::{SessionId, TurnId};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

/// Helpers one turn may start.
pub const PER_TURN: u32 = 8;
/// Helpers one session runs at once.
pub const PER_SESSION: usize = 4;
/// Helpers one engine runs at once.
pub const PER_ENGINE: usize = 6;

/// The limits, as numbers: the constants above, or others in a test.
#[derive(Clone, Copy, Debug)]
pub struct Caps {
    pub per_turn: u32,
    pub per_session: usize,
    pub per_engine: usize,
}

impl Default for Caps {
    fn default() -> Self {
        Self {
            per_turn: PER_TURN,
            per_session: PER_SESSION,
            per_engine: PER_ENGINE,
        }
    }
}

pub struct Gate {
    caps: Caps,
    engine: Arc<Semaphore>,
    sessions: Mutex<HashMap<SessionId, Arc<Semaphore>>>,
    /// The turn each session last started helpers in, and how many it has.
    turns: Mutex<HashMap<SessionId, (TurnId, u32)>>,
}

/// A place among the running helpers, given back when dropped.
pub struct Slot {
    _session: OwnedSemaphorePermit,
    _engine: OwnedSemaphorePermit,
}

impl Gate {
    pub fn new(caps: Caps) -> Self {
        Self {
            caps,
            engine: Arc::new(Semaphore::new(caps.per_engine)),
            sessions: Mutex::default(),
            turns: Mutex::default(),
        }
    }

    pub fn caps(&self) -> Caps {
        self.caps
    }

    /// Counts `count` more helpers against the turn. `Err` with how many it
    /// had already started, when that would pass the limit; nothing is
    /// counted then.
    pub fn reserve(&self, session: &SessionId, turn: &TurnId, count: u32) -> Result<(), u32> {
        let mut turns = self.turns.lock().unwrap_or_else(PoisonError::into_inner);
        let entry = turns
            .entry(session.clone())
            .or_insert_with(|| (turn.clone(), 0));
        if entry.0 != *turn {
            *entry = (turn.clone(), 0);
        }
        if entry.1 + count > self.caps.per_turn {
            return Err(entry.1);
        }
        entry.1 += count;
        Ok(())
    }

    fn session_slots(&self, session: &SessionId) -> Arc<Semaphore> {
        self.sessions
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .entry(session.clone())
            .or_insert_with(|| Arc::new(Semaphore::new(self.caps.per_session)))
            .clone()
    }

    /// A slot now, when there is one for the session and the engine.
    pub fn try_slot(&self, session: &SessionId) -> Option<Slot> {
        let session = self.session_slots(session).try_acquire_owned().ok()?;
        let engine = self.engine.clone().try_acquire_owned().ok()?;
        Some(Slot {
            _session: session,
            _engine: engine,
        })
    }

    /// Waits for a slot. The session's comes first, so a session with more
    /// helpers than its share queues behind itself and never holds an
    /// engine slot while it waits.
    pub async fn slot(&self, session: &SessionId) -> Slot {
        // The semaphores are never closed.
        let session = self
            .session_slots(session)
            .acquire_owned()
            .await
            .expect("the session's slots stay open");
        let engine = self
            .engine
            .clone()
            .acquire_owned()
            .await
            .expect("the engine's slots stay open");
        Slot {
            _session: session,
            _engine: engine,
        }
    }

    /// Forgets what a session no longer uses.
    pub fn finish(&self, session: &SessionId) {
        let mut sessions = self.sessions.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(slots) = sessions.get(session)
            && Arc::strong_count(slots) == 1
        {
            sessions.remove(session);
        }
    }

    /// Helpers running now, across the engine.
    #[cfg(test)]
    pub fn running(&self) -> usize {
        self.caps.per_engine - self.engine.available_permits()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gate(per_turn: u32, per_session: usize, per_engine: usize) -> Gate {
        Gate::new(Caps {
            per_turn,
            per_session,
            per_engine,
        })
    }

    #[test]
    fn a_turn_has_so_many_helpers_and_the_next_turn_starts_again() {
        let gate = gate(5, 4, 6);
        let (lead, one, two) = (
            SessionId::from("lead"),
            TurnId::from("one"),
            TurnId::from("two"),
        );
        assert_eq!(gate.reserve(&lead, &one, 4), Ok(()));
        assert_eq!(gate.reserve(&lead, &one, 2), Err(4));
        assert_eq!(gate.reserve(&lead, &one, 1), Ok(()));
        assert_eq!(gate.reserve(&lead, &one, 1), Err(5));
        assert_eq!(gate.reserve(&lead, &two, 4), Ok(()));
        // Another session has its own turns.
        assert_eq!(gate.reserve(&SessionId::from("other"), &one, 5), Ok(()));
    }

    #[test]
    fn a_session_and_the_engine_run_so_many_at_once() {
        let gate = gate(8, 2, 3);
        let (a, b) = (SessionId::from("a"), SessionId::from("b"));
        let first = gate.try_slot(&a).expect("one");
        let _second = gate.try_slot(&a).expect("two");
        assert!(gate.try_slot(&a).is_none(), "a session's share is two");
        let _third = gate.try_slot(&b).expect("the engine's third");
        assert!(gate.try_slot(&b).is_none(), "the engine's share is three");
        assert_eq!(gate.running(), 3);
        drop(first);
        assert!(gate.try_slot(&b).is_some());
    }

    #[tokio::test]
    async fn the_first_to_wait_is_the_first_to_run() {
        let gate = Arc::new(gate(8, 4, 1));
        let session = SessionId::from("a");
        let held = gate.try_slot(&session).expect("the only slot");
        let order = Arc::new(Mutex::new(Vec::new()));
        let mut waiting = Vec::new();
        for n in 0..3 {
            let (gate, session, order) = (gate.clone(), session.clone(), order.clone());
            waiting.push(tokio::spawn(async move {
                let _slot = gate.slot(&session).await;
                order.lock().unwrap().push(n);
            }));
            tokio::task::yield_now().await;
        }
        drop(held);
        for task in waiting {
            task.await.expect("runs");
        }
        assert_eq!(*order.lock().unwrap(), [0, 1, 2]);
    }

    #[test]
    fn a_finished_session_is_forgotten() {
        let gate = gate(8, 4, 6);
        let session = SessionId::from("a");
        let slot = gate.try_slot(&session).expect("a slot");
        gate.finish(&session);
        assert_eq!(gate.sessions.lock().unwrap().len(), 1, "still in use");
        drop(slot);
        gate.finish(&session);
        assert!(gate.sessions.lock().unwrap().is_empty());
    }
}
