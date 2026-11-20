//! What a turn does next, decided from its log alone. Normal operation and
//! recovery after a crash take the same path: the loop always asks the log.

use crate::contract;
use crate::policy::RetryPolicy;
use crate::projection::{RequestOutcome, TurnState};
use blame_engine_protocol::{
    ErrorInfo, ErrorKind, Obligation, RequestId, SessionConfig, ToolOutcome, ToolSpec, TurnOutcome,
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
    /// The model acknowledged a message sent into the running turn with
    /// text alone while work was under way: ask it to carry on instead of
    /// ending the turn (or correcting it, under a contract).
    Continue,
    /// The model stopped without fulfilling the completion contract: tell
    /// it so, and on the `last` correction force the tool it must call.
    Correct {
        attempt: u32,
        unmet: Vec<Obligation>,
        last: bool,
    },
    End(TurnOutcome),
}

/// What the model reads after acknowledging a message sent mid-turn with
/// text alone (`TurnContinued`).
pub(crate) const CONTINUE_TEXT: &str = "Carry on with the work you were doing, taking that message into account. If nothing is left to do, say so in one sentence.";

/// Name of the limit on a turn's wall time, as `LimitReached` reports it.
pub(crate) const MAX_TURN_MS: &str = "max_turn_ms";

/// When the turn must be over, if the configuration bounds its time.
pub(crate) fn deadline_ms(state: &TurnState<'_>, config: &SessionConfig) -> Option<u64> {
    config
        .limits
        .max_turn_ms
        .map(|max| state.started_at_ms.saturating_add(max))
}

pub(crate) fn next_step(
    state: &TurnState<'_>,
    config: &SessionConfig,
    specs: &[ToolSpec],
    retry: &RetryPolicy,
    now_ms: u64,
) -> Step {
    if config.checkpoints && !state.checkpoint {
        return Step::Checkpoint;
    }
    if deadline_ms(state, config).is_some_and(|deadline| now_ms >= deadline) {
        return Step::End(TurnOutcome::LimitReached {
            limit: MAX_TURN_MS.into(),
        });
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
            // A text-only reply to a message sent mid-turn is the model
            // acknowledging it, not the end of the work: once per such
            // message, it is asked to carry on. A second text-only reply
            // ends (or is corrected) as any other.
            if !*has_calls
                && state.accepted.is_none()
                && state.steer_in_last_request
                && state.worked_before_last_request
                && !state.continue_pending
            {
                return Step::Continue;
            }
            if let Some(contract) = &config.contract {
                // Only an accepted result ends the turn; a tool marked
                // `ends_turn` does not, under a contract.
                if state.accepted.is_some() {
                    return Step::End(TurnOutcome::Completed);
                }
                if *has_calls
                    || state.steer_pending
                    || state.correction_pending
                    || state.continue_pending
                {
                    return new_request(state, config);
                }
                let unmet = contract::unmet(contract, state.completed.iter().copied());
                if state.corrections >= contract.max_corrections {
                    return Step::End(TurnOutcome::ContractUnmet { unmet });
                }
                return Step::Correct {
                    attempt: state.corrections + 1,
                    unmet,
                    last: state.corrections + 1 == contract.max_corrections,
                };
            }
            let ended_by_tool = state.calls.iter().any(|call| {
                call.finished == Some(ToolOutcome::Completed)
                    && specs
                        .iter()
                        .any(|spec| spec.name == call.name && spec.ends_turn)
            });
            if ended_by_tool {
                Step::End(TurnOutcome::Completed)
            } else if *has_calls || state.steer_pending || state.continue_pending {
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
    if limits
        .max_turn_tokens
        .is_some_and(|max| state.tokens >= max)
    {
        return Step::End(TurnOutcome::LimitReached {
            limit: "max_turn_tokens".into(),
        });
    }
    Step::Request {
        request: None,
        attempt: 1,
        wait: None,
    }
}
