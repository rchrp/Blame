use crate::ports::Clock;
use std::sync::{Arc, Mutex, PoisonError};
use std::task::{Poll, Waker};
use std::time::Duration;

/// A clock that only moves when told to.
///
/// In automatic mode (the default) a sleep moves time forward by its own
/// length and returns at once, the way a paused runtime does when nothing
/// else can run: tests of backoff and timeouts finish instantly and can read
/// back exactly how long the loop chose to wait. In manual mode sleeps wait
/// for [`ManualClock::advance`].
#[derive(Clone)]
pub struct ManualClock {
    inner: Arc<Mutex<State>>,
}

struct State {
    now_ms: u64,
    automatic: bool,
    sleeps: Vec<Duration>,
    /// Added to the wall clock during the next sleep: the machine slept.
    jump_on_next_sleep: Option<u64>,
    waiting: Vec<(u64, u64, Waker)>,
    next_id: u64,
}

impl Default for ManualClock {
    fn default() -> Self {
        Self::new()
    }
}

impl ManualClock {
    pub const START_MS: u64 = 1_700_000_000_000;

    pub fn new() -> Self {
        Self::with_mode(true)
    }

    pub fn manual() -> Self {
        Self::with_mode(false)
    }

    fn with_mode(automatic: bool) -> Self {
        Self {
            inner: Arc::new(Mutex::new(State {
                now_ms: Self::START_MS,
                automatic,
                sleeps: Vec::new(),
                jump_on_next_sleep: None,
                waiting: Vec::new(),
                next_id: 0,
            })),
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Every sleep asked for so far, in order.
    pub fn sleeps(&self) -> Vec<Duration> {
        self.state().sleeps.clone()
    }

    /// Sleeps currently waiting (manual mode).
    pub fn sleepers(&self) -> usize {
        self.state().waiting.len()
    }

    /// Moves time forward and wakes the sleeps that are due.
    pub fn advance(&self, by: Duration) {
        let mut state = self.state();
        state.now_ms += millis(by);
        let now = state.now_ms;
        let (due, waiting): (Vec<_>, Vec<_>) = state
            .waiting
            .drain(..)
            .partition(|(_, deadline, _)| *deadline <= now);
        state.waiting = waiting;
        drop(state);
        for (_, _, waker) in due {
            waker.wake();
        }
    }

    /// Makes the next sleep return with the wall clock `by` further on than
    /// it slept, as when the machine is suspended in the middle of it.
    pub fn jump_on_next_sleep(&self, by: Duration) {
        self.state().jump_on_next_sleep = Some(millis(by));
    }
}

fn millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

#[async_trait::async_trait]
impl Clock for ManualClock {
    fn now_ms(&self) -> u64 {
        self.state().now_ms
    }

    async fn sleep(&self, duration: Duration) {
        let (id, deadline) = {
            let mut state = self.state();
            state.sleeps.push(duration);
            if let Some(jump) = state.jump_on_next_sleep.take() {
                state.now_ms += jump + millis(duration);
                return;
            }
            if state.automatic {
                state.now_ms += millis(duration);
                return;
            }
            state.next_id += 1;
            (state.next_id, state.now_ms + millis(duration))
        };
        let guard = Deregister { clock: self, id };
        std::future::poll_fn(|cx| {
            let mut state = self.state();
            if state.now_ms >= deadline {
                return Poll::Ready(());
            }
            match state.waiting.iter_mut().find(|(i, _, _)| *i == id) {
                Some(entry) => entry.2 = cx.waker().clone(),
                None => state.waiting.push((id, deadline, cx.waker().clone())),
            }
            Poll::Pending
        })
        .await;
        drop(guard);
    }
}

/// Forgets a sleep that is dropped before it is due.
struct Deregister<'a> {
    clock: &'a ManualClock,
    id: u64,
}

impl Drop for Deregister<'_> {
    fn drop(&mut self) {
        self.clock.state().waiting.retain(|(i, _, _)| *i != self.id);
    }
}
