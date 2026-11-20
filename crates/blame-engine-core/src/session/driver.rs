//! The task that runs a session's turns, one after the other, until none is
//! open. Each iteration folds the log, decides one step and performs it; a
//! step stores what it did before the next decision is made.

use super::compaction::{self, Reason};
use super::step::{Step, next_step};
use super::{Core, Inner, NOTICE_CHECKPOINT_FAILED, stream, tools};
use crate::error::EngineError;
use crate::ports::{CachePlan, ModelRequest};
use crate::projection::{View, cache_breakpoints, request_digest};
use crate::race::{Either, race};
use blame_engine_protocol::{
    CheckpointId, ErrorInfo, ErrorKind, NoticeLevel, RecordBody, RequestId, SessionActivity,
    ToolOutcome, ToolResultBlock, TurnId, TurnOutcome,
};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

/// Result text of a call that never ran because the turn was stopped.
pub(crate) const NOT_RUN_INTERRUPTED: &str = "Not run: the user interrupted the turn.";

pub(super) async fn drive(inner: Arc<Inner>) {
    loop {
        match iteration(&inner).await {
            Ok(true) => {}
            Ok(false) => return,
            Err(_) => {
                // The error is kept in `Core::broken` (store) or was already
                // recorded; either way this driver is done.
                let mut core = inner.core.lock().await;
                core.driver = None;
                inner.busy.send_replace(false);
                inner.set_activity(SessionActivity::Idle);
                return;
            }
        }
    }
}

/// One step of the current turn. `Ok(false)` once the driver has stopped.
async fn iteration(inner: &Arc<Inner>) -> Result<bool, EngineError> {
    let mut core = inner.core.lock().await;
    let view = View::new(&core.records);
    let Some(turn) = view.open_turns().first().map(|t| (*t).clone()) else {
        drop(view);
        return Ok(stop(inner, &mut core));
    };
    drop(view);
    let hold = core.hold;
    let driver = core
        .driver
        .as_mut()
        .expect("the driver runs only when registered");
    let cancel = match &driver.current {
        Some((current, cancel)) if *current == turn => cancel.clone(),
        _ if hold => return Ok(stop(inner, &mut core)),
        _ => {
            let cancel = CancellationToken::new();
            driver.current = Some((turn.clone(), cancel.clone()));
            cancel
        }
    };
    if cancel.is_cancelled() {
        close_turn(inner, &mut core, &turn, TurnOutcome::Interrupted).await?;
        return Ok(true);
    }
    let view = View::new(&core.records);
    let config = view
        .config()
        .cloned()
        .ok_or_else(|| EngineError::InvalidLog("no configuration".into()))?;
    drop(view);
    let specs = inner.specs_locked(&mut core, &config).await;
    let view = View::new(&core.records);
    let mut state = view.turn_state(&turn);
    if core.checkpoint_failed.as_ref() == Some(&turn) {
        state.checkpoint = true;
    }
    let step = next_step(&state, &config, &specs, &inner.options.retry);
    drop(view);
    match step {
        Step::End(outcome) => {
            close_turn(inner, &mut core, &turn, outcome).await?;
        }
        Step::Checkpoint => {
            drop(core);
            checkpoint(inner, &turn, &config.workspace_root).await?;
        }
        Step::RunTools => {
            drop(core);
            tools::run(inner, &turn, &cancel).await?;
        }
        Step::Compact { error } => {
            drop(core);
            if !compaction::compact(inner, Reason::Overflow, &cancel).await? {
                let mut core = inner.core.lock().await;
                close_turn(inner, &mut core, &turn, TurnOutcome::Failed { error }).await?;
            }
        }
        Step::Request {
            request,
            attempt,
            wait,
        } => {
            drop(core);
            send_request(inner, &turn, request, attempt, wait, &cancel).await?;
        }
    }
    Ok(true)
}

/// Unregisters the driver. Done under the lock that `send` also takes, so a
/// turn opened right now either is seen here or starts a new driver.
fn stop(inner: &Inner, core: &mut Core) -> bool {
    core.driver = None;
    inner.busy.send_replace(false);
    inner.set_activity(SessionActivity::Idle);
    false
}

/// Ends `turn`, giving every call it left unanswered a result first.
pub(super) async fn close_turn(
    inner: &Inner,
    core: &mut Core,
    turn: &TurnId,
    outcome: TurnOutcome,
) -> Result<(), EngineError> {
    let view = View::new(&core.records);
    let state = view.turn_state(turn);
    let mut bodies: Vec<RecordBody> = state
        .pending_calls()
        .map(|call| RecordBody::ToolCallFinished {
            turn: turn.clone(),
            call: call.call.clone(),
            outcome: ToolOutcome::Cancelled,
            content: vec![ToolResultBlock::Text {
                text: NOT_RUN_INTERRUPTED.into(),
            }],
        })
        .collect();
    drop(view);
    bodies.push(RecordBody::TurnEnded {
        turn: turn.clone(),
        outcome,
    });
    inner.append_locked(core, bodies).await?;
    if core.checkpoint_failed.as_ref() == Some(turn) {
        core.checkpoint_failed = None;
    }
    Ok(())
}

async fn checkpoint(inner: &Inner, turn: &TurnId, root: &str) -> Result<(), EngineError> {
    match inner
        .ports
        .checkpointer
        .snapshot(Path::new(root), &inner.id)
        .await
    {
        Ok(snapshot) => {
            inner
                .append(vec![RecordBody::CheckpointCreated {
                    turn: turn.clone(),
                    checkpoint: CheckpointId(inner.ports.ids.next("ckpt")),
                    snapshot,
                }])
                .await?;
        }
        Err(error) => {
            // The turn runs without a checkpoint. A rewind to before it then
            // reports that the files could not be restored, since writes
            // come before any later checkpoint in the log.
            inner.core.lock().await.checkpoint_failed = Some(turn.clone());
            inner
                .notice(
                    NoticeLevel::Warning,
                    NOTICE_CHECKPOINT_FAILED,
                    format!("No checkpoint was taken for this turn: {error}"),
                )
                .await?;
        }
    }
    Ok(())
}

async fn send_request(
    inner: &Arc<Inner>,
    turn: &TurnId,
    request: Option<RequestId>,
    attempt: u32,
    wait: Option<Duration>,
    cancel: &CancellationToken,
) -> Result<(), EngineError> {
    if let Some(wait) = wait {
        inner.set_activity(SessionActivity::Retrying {
            in_ms: u64::try_from(wait.as_millis()).unwrap_or(u64::MAX),
        });
        if let Either::Right(()) = race(inner.ports.clock.sleep(wait), cancel.cancelled()).await {
            // The next iteration sees the token and ends the turn.
            return Ok(());
        }
    }
    if request.is_none() {
        compaction::compact(inner, Reason::Auto, cancel).await?;
        if cancel.is_cancelled() {
            return Ok(());
        }
    }
    let (model_request, request) = {
        let mut core = inner.core.lock().await;
        let config = View::new(&core.records)
            .config()
            .cloned()
            .ok_or_else(|| EngineError::InvalidLog("no configuration".into()))?;
        let specs = inner.specs_locked(&mut core, &config).await;
        let edits = inner
            .ports
            .context_policy
            .edits(&View::new(&core.records), &specs);
        if !edits.is_empty() {
            inner
                .append_locked(&mut core, vec![RecordBody::ContextEdited { edits }])
                .await?;
        }
        // Built and recorded under one lock: a steer stored now lands after
        // `RequestStarted` and so in the next request, as the log will say.
        let messages = View::new(&core.records).messages();
        let prefix_digest = request_digest(
            &config.model,
            &config.system_prompt,
            &specs,
            config.reasoning,
            &messages,
        );
        let request = request.unwrap_or_else(|| RequestId(inner.ports.ids.next("req")));
        inner
            .append_locked(
                &mut core,
                vec![RecordBody::RequestStarted {
                    turn: turn.clone(),
                    request: request.clone(),
                    model: config.model.clone(),
                    attempt,
                    prefix_digest,
                }],
            )
            .await?;
        let model_request = ModelRequest {
            cache: CachePlan {
                key: inner.id.0.clone(),
                breakpoints: cache_breakpoints(&messages),
                long_lived_prefix: true,
            },
            model: config.model,
            system: config.system_prompt,
            messages,
            tools: specs.to_vec(),
            reasoning: config.reasoning,
            max_output_tokens: config.max_output_tokens,
            blobs: inner.ports.store.clone(),
        };
        (model_request, request)
    };
    inner.set_activity(SessionActivity::Waiting);
    let body = match stream::run(inner, model_request, Some(&request), cancel).await {
        stream::End::Reply {
            blocks,
            stop,
            usage,
        } => RecordBody::AssistantMessage {
            turn: turn.clone(),
            request,
            blocks,
            stop,
            usage,
        },
        stream::End::Failed(error) => RecordBody::RequestFailed {
            turn: turn.clone(),
            request,
            error,
        },
        stream::End::Cancelled => RecordBody::RequestFailed {
            turn: turn.clone(),
            request,
            error: ErrorInfo {
                kind: ErrorKind::Cancelled,
                message: "Interrupted by the user.".into(),
                retry_after_ms: None,
            },
        },
    };
    inner.append(vec![body]).await?;
    Ok(())
}
