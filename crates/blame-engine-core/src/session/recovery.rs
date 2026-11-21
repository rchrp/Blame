//! Bringing a log that a crash or a quit cut short to a consistent state.
//!
//! Every step of the loop is stored before it acts, so the log says how far
//! each one got. Recovery finishes what must be finished (a rewind), records
//! as failed what cannot be resumed (a request whose stream is gone), asks
//! the tool host about calls it did not see end, and then either ends the
//! turn or lets the driver carry on, as the policy says.

use super::{Inner, rewind};
use crate::error::EngineError;
use crate::policy::RecoveryPolicy;
use crate::ports::{InterruptedCall, ToolInvocation};
use crate::projection::{RequestOutcome, View};
use blame_engine_protocol::{
    ErrorInfo, ErrorKind, NoticeLevel, Record, RecordBody, ToolOutcome, ToolResultBlock,
    TurnOutcome,
};
use std::sync::Arc;

/// Result of a call whose outcome nobody knows.
pub(crate) const INTERRUPTED: &str = "The engine stopped while this tool was running, \
so whether it took effect is unknown. Check before relying on it or running it again.";
/// Result of a call that had not run when the engine stopped.
pub(crate) const NOT_RUN_STOPPED: &str = "Not run: the engine stopped before it ran.";
pub(crate) const STOPPED_MID_REQUEST: &str = "The engine stopped before the reply was complete.";
pub(crate) const NOTICE_RECOVERED: &str = "recovered";

pub(super) async fn recover(inner: &Arc<Inner>) -> Result<(), EngineError> {
    let mut core = inner.core.lock().await;
    if let Some((started, to, checkpoint)) = unfinished_rewind(&core.records) {
        rewind::finish(inner, &mut core, started, to, checkpoint, None).await?;
    }
    if let Some(Record {
        body: RecordBody::RewindUndone { rewind },
        ..
    }) = core.records.last()
    {
        // Nothing follows the undo, so its restore may not have run.
        let rewind = *rewind;
        rewind::restore_undo(inner, &core.records, rewind).await;
    }

    let policy = inner.options.recovery;
    let view = View::new(&core.records);
    let config = view
        .config()
        .cloned()
        .ok_or_else(|| EngineError::InvalidLog("no configuration".into()))?;
    let mut bodies = Vec::new();
    for turn in view.open_turns() {
        // A message still waiting in the queue was never sent: it stays
        // queued for when the conversation goes on.
        if policy == RecoveryPolicy::Stop && !view.has_started(turn) {
            continue;
        }
        let state = view.turn_state(turn);
        if let Some(last) = &state.last_request
            && last.outcome == RequestOutcome::InFlight
        {
            bodies.push(RecordBody::RequestFailed {
                turn: (*turn).clone(),
                request: last.request.clone(),
                error: ErrorInfo {
                    kind: ErrorKind::Transport,
                    message: STOPPED_MID_REQUEST.into(),
                    retry_after_ms: None,
                },
            });
        }
        for call in state.pending_calls() {
            let settled = if call.starts > 0 {
                let invocation = ToolInvocation {
                    session: inner.id.clone(),
                    turn: (*turn).clone(),
                    call: call.call.clone(),
                    name: call.name.to_owned(),
                    input: call.input.clone(),
                    workspace_root: config.workspace_root.clone(),
                    compacted_through: view.compacted_through(),
                    ultra: state.ultra,
                };
                match inner.ports.tools.interrupted(&invocation).await {
                    InterruptedCall::Applied(output) => Some((output.outcome, output.content)),
                    InterruptedCall::Unknown => Some((ToolOutcome::Interrupted, text(INTERRUPTED))),
                    InterruptedCall::NotApplied => None,
                }
            } else {
                None
            };
            let settled = settled.or_else(|| {
                (policy == RecoveryPolicy::Stop)
                    .then(|| (ToolOutcome::Cancelled, text(NOT_RUN_STOPPED)))
            });
            if let Some((outcome, content)) = settled {
                bodies.push(RecordBody::ToolCallFinished {
                    turn: (*turn).clone(),
                    call: call.call.clone(),
                    outcome,
                    content,
                });
            }
        }
        if policy == RecoveryPolicy::Stop {
            bodies.push(RecordBody::TurnEnded {
                turn: (*turn).clone(),
                outcome: TurnOutcome::Interrupted,
            });
        }
    }
    drop(view);
    if !bodies.is_empty() {
        bodies.push(RecordBody::Notice {
            level: NoticeLevel::Info,
            code: NOTICE_RECOVERED.into(),
            text: match policy {
                RecoveryPolicy::Stop => {
                    "The engine stopped while a turn was running; it was ended.".into()
                }
                RecoveryPolicy::Continue => {
                    "The engine stopped while a turn was running; it continues.".into()
                }
            },
        });
        inner.append_locked(&mut core, bodies).await?;
    }
    // Stopped, messages still queued wait for the conversation to go on.
    if policy == RecoveryPolicy::Continue {
        inner.ensure_driver(&mut core);
    }
    Ok(())
}

fn text(text: &str) -> Vec<ToolResultBlock> {
    vec![ToolResultBlock::Text { text: text.into() }]
}

/// The latest `RewindStarted` when no `RewindFinished` names it.
fn unfinished_rewind(
    records: &[Record],
) -> Option<(u64, u64, Option<blame_engine_protocol::CheckpointId>)> {
    let started = records.iter().rev().find_map(|record| match &record.body {
        RecordBody::RewindStarted { to, checkpoint, .. } => {
            Some((record.seq, *to, checkpoint.clone()))
        }
        _ => None,
    })?;
    let finished = records.iter().any(|record| {
        matches!(record.body, RecordBody::RewindFinished { started: s, .. } if s == started.0)
    });
    (!finished).then_some(started)
}
