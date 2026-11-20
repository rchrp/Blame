//! The knobs of the loop. None of them is stored: they describe this engine,
//! not the session, and every decision they lead to is recorded.

use crate::projection::View;
use blame_engine_protocol::{ContextEdit, ErrorInfo, ToolSpec};
use std::time::Duration;

/// What opening a session does with a turn that a crash or a quit stopped.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum RecoveryPolicy {
    /// Settle what was in flight and end the turn as interrupted. Agents stop
    /// when the app quits; the user continues by sending a message.
    #[default]
    Stop,
    /// Settle what was in flight and carry on with the turn.
    Continue,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RetryPolicy {
    /// Attempts of one request, the first one included.
    pub max_attempts: u32,
    pub initial_backoff: Duration,
    pub max_backoff: Duration,
    /// A provider asking to wait longer than this fails the turn instead:
    /// the user is better placed to decide than a silent hour-long wait.
    pub max_retry_after: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 6,
            initial_backoff: Duration::from_secs(1),
            max_backoff: Duration::from_secs(60),
            max_retry_after: Duration::from_secs(10 * 60),
        }
    }
}

impl RetryPolicy {
    /// The wait before attempt `attempt + 1`, after `attempt` failed with
    /// `error`; `None` when it should not be tried again.
    pub fn delay(&self, attempt: u32, error: &ErrorInfo) -> Option<Duration> {
        if !error.kind.is_retryable() || attempt >= self.max_attempts {
            return None;
        }
        let exponent = attempt.saturating_sub(1).min(20);
        let backoff = self
            .initial_backoff
            .saturating_mul(1 << exponent)
            .min(self.max_backoff);
        match error.retry_after_ms.map(Duration::from_millis) {
            Some(asked) if asked > self.max_retry_after => None,
            Some(asked) => Some(asked.max(backoff)),
            None => Some(backoff),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WatchdogOptions {
    /// A stream silent for this long is stalled and sent again.
    pub inactivity: Duration,
    /// How often the wall clock is compared with the time slept.
    pub check_every: Duration,
    /// A check that finds the wall clock moved this much more than it slept
    /// means the machine was asleep: the connection is almost surely dead.
    pub sleep_jump: Duration,
}

impl Default for WatchdogOptions {
    fn default() -> Self {
        Self {
            inactivity: Duration::from_secs(180),
            check_every: Duration::from_secs(5),
            sleep_jump: Duration::from_secs(30),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct CompactionOptions {
    /// Compact before a request whose estimate reaches this share of
    /// `Limits::max_context_tokens`.
    pub trigger_ratio: f64,
    /// Share of `max_context_tokens` kept verbatim after a compaction.
    pub keep_ratio: f64,
    /// Kept verbatim when the session sets no `max_context_tokens`.
    pub keep_tokens_without_limit: u64,
    /// Sent after the history to obtain the summary.
    pub instruction: String,
}

impl Default for CompactionOptions {
    fn default() -> Self {
        Self {
            trigger_ratio: 0.8,
            keep_ratio: 0.2,
            keep_tokens_without_limit: 20_000,
            instruction: "Summarise the conversation so far for your own later use: the task, \
what was decided, what was done (files changed, commands run and their results), what remains \
to do, and anything the user asked you to remember. Answer with the summary only, and do not \
call any tool."
                .into(),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct EngineOptions {
    pub recovery: RecoveryPolicy,
    pub retry: RetryPolicy,
    pub watchdog: WatchdogOptions,
    pub compaction: CompactionOptions,
}

/// Default for `Limits::max_parallel_tool_calls`.
pub const DEFAULT_PARALLEL_TOOL_CALLS: u32 = 4;

/// Decides, before each new request, whether blocks should be shown to the
/// model differently (a stale file read replaced by a pointer). Whatever it
/// proposes is stored as `ContextEdited` before the request is built, so the
/// same history is rebuilt after a restart. It is not asked before a retry
/// (unless a compaction came in between): a retry repeats the bytes it
/// retries.
pub trait ContextPolicy: Send + Sync {
    /// Edits to apply now. Already-applied edits are part of `view`
    /// ([`View::edit_of`]); returning them again stores them again, so return
    /// only new ones. An edit with an empty replacement removes the block.
    fn edits(&self, view: &View<'_>, tools: &[ToolSpec]) -> Vec<ContextEdit>;
}

/// Shows every block as it was.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoContextEdits;

impl ContextPolicy for NoContextEdits {
    fn edits(&self, _view: &View<'_>, _tools: &[ToolSpec]) -> Vec<ContextEdit> {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use blame_engine_protocol::ErrorKind;

    fn error(kind: ErrorKind, retry_after_ms: Option<u64>) -> ErrorInfo {
        ErrorInfo {
            kind,
            message: String::new(),
            retry_after_ms,
        }
    }

    #[test]
    fn backoff_doubles_up_to_its_cap_and_honours_retry_after() {
        let policy = RetryPolicy::default();
        let overloaded = error(ErrorKind::Overloaded, None);
        let waits: Vec<_> = (1..6)
            .map(|attempt| policy.delay(attempt, &overloaded))
            .collect();
        assert_eq!(
            waits,
            [1, 2, 4, 8, 16].map(|s| Some(Duration::from_secs(s)))
        );
        assert_eq!(policy.delay(6, &overloaded), None);
        assert_eq!(
            policy.delay(10, &error(ErrorKind::Transport, None)),
            None,
            "attempts are bounded"
        );
        let long = RetryPolicy {
            max_attempts: 100,
            ..RetryPolicy::default()
        };
        assert_eq!(long.delay(30, &overloaded), Some(Duration::from_secs(60)));
        assert_eq!(
            policy.delay(1, &error(ErrorKind::RateLimited, Some(7_000))),
            Some(Duration::from_secs(7))
        );
        assert_eq!(
            policy.delay(4, &error(ErrorKind::RateLimited, Some(2_000))),
            Some(Duration::from_secs(8)),
            "never shorter than the backoff"
        );
        assert_eq!(
            policy.delay(1, &error(ErrorKind::RateLimited, Some(3_600_000))),
            None
        );
        assert_eq!(
            policy.delay(1, &error(ErrorKind::Authentication, None)),
            None
        );
    }
}
