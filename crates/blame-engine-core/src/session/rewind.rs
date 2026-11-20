//! Rewinding a session, undoing a rewind, and forking.
//!
//! Files: a rewind restores the checkpoint of the first turn after the
//! rewind point, after taking one more snapshot of the workspace as it is
//! (kept in `RewindStarted::undo_snapshot`). Undoing the rewind restores that
//! snapshot, so the files come back with the conversation.

use super::{Core, Inner};
use crate::error::EngineError;
use crate::projection::{View, checkpoint_for, unreverted_commands};
use blame_engine_protocol::rpc::Rewound;
use blame_engine_protocol::{
    CheckpointId, ErrorInfo, ErrorKind, NoticeLevel, Record, RecordBody, RequestId, Seq,
    SessionActivity, SessionId, ToolOutcome, ToolResultBlock, TurnOutcome, WorkspaceRestore,
};
use std::path::Path;

/// Result of a call that was still running in the session a fork copied.
pub(crate) const NOT_IN_FORK: &str = "This call had not finished when the session was forked.";

pub(super) async fn rewind(
    inner: &Inner,
    to: Seq,
    restore_workspace: bool,
) -> Result<Rewound, EngineError> {
    let mut core = inner.core.lock().await;
    core.usable()?;
    let head = super::head(&core.records);
    if to == 0 || to > head {
        return Err(EngineError::InvalidRewind {
            to,
            reason: "no such record".into(),
        });
    }
    let view = View::new(&core.records);
    let root = view
        .config()
        .map(|c| c.workspace_root.clone())
        .unwrap_or_default();
    let (checkpoint, failure) = if restore_workspace {
        match checkpoint_for(&view, to) {
            Some(found) => (found, None),
            None => (
                None,
                Some(format!(
                    "No checkpoint holds the workspace as it was at record {to}."
                )),
            ),
        }
    } else {
        (None, None)
    };
    drop(view);
    let undo_snapshot = match &checkpoint {
        Some(_) => Some(
            inner
                .ports
                .checkpointer
                .snapshot(Path::new(&root), &inner.id)
                .await?,
        ),
        None => None,
    };
    inner.set_activity(SessionActivity::Rewinding);
    let started = inner
        .append_locked(
            &mut core,
            vec![RecordBody::RewindStarted {
                to,
                checkpoint: checkpoint.as_ref().map(|(id, _)| CheckpointId(id.clone())),
                undo_snapshot,
            }],
        )
        .await?[0]
        .seq;
    let nothing_to_restore = restore_workspace && checkpoint.is_none() && failure.is_none();
    let workspace = match failure {
        Some(message) => Some(WorkspaceRestore::Failed { message }),
        None if nothing_to_restore => Some(WorkspaceRestore::Restored),
        None => None,
    };
    let finished = finish(
        inner,
        &mut core,
        started,
        to,
        checkpoint.map(|(id, _)| CheckpointId(id)),
        workspace,
    )
    .await?;
    inner.set_activity(SessionActivity::Idle);
    Ok(Rewound { finished })
}

/// Restores the files and stores `RewindFinished`. Safe to run again for
/// the same `RewindStarted`: restoring a snapshot twice changes nothing.
/// `known` is the outcome to record when no checkpoint is involved; recovery
/// passes `None`, which records `NotRequested`.
pub(super) async fn finish(
    inner: &Inner,
    core: &mut Core,
    started: Seq,
    to: Seq,
    checkpoint: Option<CheckpointId>,
    known: Option<WorkspaceRestore>,
) -> Result<Seq, EngineError> {
    let view = View::new(&core.records);
    let root = view
        .config()
        .map(|c| c.workspace_root.clone())
        .unwrap_or_default();
    let unreverted = unreverted_commands(&view, to);
    drop(view);
    let workspace = match checkpoint {
        Some(checkpoint) => match snapshot_of(&core.records, &checkpoint) {
            Some(snapshot) => match inner
                .ports
                .checkpointer
                .restore(Path::new(&root), &snapshot)
                .await
            {
                Ok(()) => WorkspaceRestore::Restored,
                Err(error) => WorkspaceRestore::Failed {
                    message: error.to_string(),
                },
            },
            None => WorkspaceRestore::Failed {
                message: format!("Checkpoint {checkpoint} is not in the log."),
            },
        },
        None => known.unwrap_or(WorkspaceRestore::NotRequested),
    };
    let records = inner
        .append_locked(
            core,
            vec![RecordBody::RewindFinished {
                started,
                to,
                workspace,
                unreverted_commands: unreverted,
            }],
        )
        .await?;
    Ok(records[0].seq)
}

fn snapshot_of(records: &[Record], checkpoint: &CheckpointId) -> Option<String> {
    records.iter().find_map(|record| match &record.body {
        RecordBody::CheckpointCreated {
            checkpoint: c,
            snapshot,
            ..
        } if c == checkpoint => Some(snapshot.clone()),
        _ => None,
    })
}

pub(super) async fn undo(inner: &Inner) -> Result<(), EngineError> {
    let mut core = inner.core.lock().await;
    core.usable()?;
    let Some(Record {
        seq,
        body: RecordBody::RewindFinished { .. },
        ..
    }) = core.records.last()
    else {
        return Err(EngineError::NothingToUndo);
    };
    let rewind = *seq;
    inner
        .append_locked(&mut core, vec![RecordBody::RewindUndone { rewind }])
        .await?;
    if let Some(message) = restore_undo(inner, &core.records, rewind).await {
        drop(core);
        inner
            .notice(NoticeLevel::Warning, "undo_restore_failed", message)
            .await?;
    }
    Ok(())
}

/// Puts the files back as they were before the rewind finished at `rewind`.
/// Returns why it could not, if it could not.
pub(super) async fn restore_undo(inner: &Inner, records: &[Record], rewind: Seq) -> Option<String> {
    let finished = records.iter().find(|r| r.seq == rewind)?;
    let RecordBody::RewindFinished {
        started,
        workspace: WorkspaceRestore::Restored,
        ..
    } = &finished.body
    else {
        return None;
    };
    let snapshot = records.iter().find_map(|record| match &record.body {
        RecordBody::RewindStarted { undo_snapshot, .. } if record.seq == *started => {
            undo_snapshot.clone()
        }
        _ => None,
    })?;
    let root = View::new(records)
        .config()
        .map(|c| c.workspace_root.clone())
        .unwrap_or_default();
    match inner
        .ports
        .checkpointer
        .restore(Path::new(&root), &snapshot)
        .await
    {
        Ok(()) => None,
        Err(error) => Some(format!("The files could not be put back: {error}")),
    }
}

/// The records of a fork of `source` at `at`: the source's records up to
/// there with the new workspace in every configuration, then whatever ends
/// the work that was in flight at `at`.
pub(super) fn fork_bodies(
    source: &SessionId,
    records: Vec<Record>,
    at: Seq,
    workspace_root: &str,
) -> Result<Vec<RecordBody>, EngineError> {
    let unfinished = records.iter().any(|record| {
        match record.body {
        RecordBody::RewindStarted { .. } => !records.iter().any(|r| {
            matches!(r.body, RecordBody::RewindFinished { started, .. } if started == record.seq)
        }),
        _ => false,
    }
    });
    if unfinished {
        return Err(EngineError::InvalidFork {
            at,
            reason: "a rewind is in progress there".into(),
        });
    }
    let mut closing = Vec::new();
    let view = View::new(&records);
    for turn in view.open_turns() {
        let state = view.turn_state(turn);
        if let Some(last) = &state.last_request
            && last.outcome == crate::projection::RequestOutcome::InFlight
        {
            closing.push(failed(turn, last.request));
        }
        for call in state.pending_calls() {
            closing.push(RecordBody::ToolCallFinished {
                turn: (*turn).clone(),
                call: call.call.clone(),
                outcome: ToolOutcome::Cancelled,
                content: vec![ToolResultBlock::Text {
                    text: NOT_IN_FORK.into(),
                }],
            });
        }
        closing.push(RecordBody::TurnEnded {
            turn: (*turn).clone(),
            outcome: TurnOutcome::Interrupted,
        });
    }
    drop(view);
    let mut bodies: Vec<RecordBody> = records
        .into_iter()
        .map(|record| match record.body {
            RecordBody::SessionCreated { mut config } => {
                workspace_root.clone_into(&mut config.workspace_root);
                RecordBody::SessionCreated { config }
            }
            RecordBody::ConfigChanged { mut config } => {
                workspace_root.clone_into(&mut config.workspace_root);
                RecordBody::ConfigChanged { config }
            }
            body => body,
        })
        .collect();
    bodies.extend(closing);
    bodies.push(RecordBody::Notice {
        level: NoticeLevel::Info,
        code: "forked".into(),
        text: format!("Forked from session {source} at record {at}."),
    });
    Ok(bodies)
}

fn failed(turn: &blame_engine_protocol::TurnId, request: &RequestId) -> RecordBody {
    RecordBody::RequestFailed {
        turn: turn.clone(),
        request: request.clone(),
        error: ErrorInfo {
            kind: ErrorKind::Cancelled,
            message: "The session was forked while this request ran.".into(),
            retry_after_ms: None,
        },
    }
}
