//! What a turn does next, decided from its log alone. Normal operation and
//! recovery after a crash take the same path: the loop always asks the log.

use crate::policy::RetryPolicy;
use crate::projection::{RequestOutcome, TurnState};
use blame_engine_protocol::{
    ErrorInfo, ErrorKind, RequestId, SessionConfig, ToolOutcome, ToolSpec, TurnOutcome,
};
use std::time::Duration;

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Step {
    Checkpoint,
    RunTools,
    /// Send a request: a new one (`request: None`) or another attempt of
    /// the last one, after `wait`.
    Request {
        request: Option<RequestId>,
        attempt: u32,
        wait: Option<Duration>,
    },
    /// The context no longer fits: compact, then try the request again.
    Compact {
        error: ErrorInfo,
    },
    End(TurnOutcome),
}

pub(crate) fn next_step(
    state: &TurnState<'_>,
    config: &SessionConfig,
    specs: &[ToolSpec],
    retry: &RetryPolicy,
) -> Step {
    if config.checkpoints && !state.checkpoint {
        return Step::Checkpoint;
    }
    let Some(last) = &state.last_request else {
        return new_request(state, config);
    };
    match &last.outcome {
        // Recovery records an unanswered request as failed before the loop
        // runs, so this is only reached if that record could not be read.
        RequestOutcome::InFlight => Step::Request {
            request: Some(last.request.clone()),
            attempt: last.attempt + 1,
            wait: None,
        },
        RequestOutcome::Failed(error) => match error.kind {
            ErrorKind::Cancelled => Step::End(TurnOutcome::Interrupted),
            ErrorKind::ContextOverflow if last.overflows >= 2 => Step::End(TurnOutcome::Failed {
                error: (*error).clone(),
            }),
            ErrorKind::ContextOverflow if state.compacted_since_failure => Step::Request {
                request: Some(last.request.clone()),
                attempt: last.attempt + 1,
                wait: None,
            },
            ErrorKind::ContextOverflow => Step::Compact {
                error: (*error).clone(),
            },
            _ => match retry.delay(last.attempt, error) {
                Some(wait) => Step::Request {
                    request: Some(last.request.clone()),
                    attempt: last.attempt + 1,
                    wait: Some(wait),
                },
                None => Step::End(TurnOutcome::Failed {
                    error: (*error).clone(),
                }),
            },
        },
        RequestOutcome::Replied { has_calls, .. } => {
            if state.pending_calls().next().is_some() {
                return Step::RunTools;
            }
            let ended_by_tool = state.calls.iter().any(|call| {
                call.finished == Some(ToolOutcome::Completed)
                    && specs
                        .iter()
                        .any(|spec| spec.name == call.name && spec.ends_turn)
            });
            if ended_by_tool {
                Step::End(TurnOutcome::Completed)
            } else if *has_calls || state.steer_pending {
                new_request(state, config)
            } else {
                Step::End(TurnOutcome::Completed)
            }
        }
    }
}

fn new_request(state: &TurnState<'_>, config: &SessionConfig) -> Step {
    let limits = &config.limits;
    if limits
        .max_requests_per_turn
        .is_some_and(|max| state.requests >= max)
    {
        return Step::End(TurnOutcome::LimitReached {
            limit: "max_requests_per_turn".into(),
        });
    }
    if limits
        .max_cost_micro_usd
        .is_some_and(|max| state.cost_micro_usd >= max)
    {
        return Step::End(TurnOutcome::LimitReached {
            limit: "max_cost_micro_usd".into(),
        });
    }
    Step::Request {
        request: None,
        attempt: 1,
        wait: None,
    }
}
