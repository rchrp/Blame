//! Running the tool calls of a reply. Reads run side by side; anything that
//! can change something runs alone, in the order the model asked.

use super::Inner;
use crate::error::EngineError;
use crate::policy::DEFAULT_PARALLEL_TOOL_CALLS;
use crate::ports::{ApprovalRequest, ToolInvocation, ToolProgress};
use crate::projection::{ApprovalState, View};
use crate::race::{BoxFuture, Either, join_limited, race};
use blame_engine_protocol::{
    ApprovalDecision, Delta, RecordBody, Seq, SessionActivity, SessionConfig, ToolCallId,
    ToolEffect, ToolOutcome, ToolResultBlock, ToolSpec, TurnId,
};
use serde_json::Value;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub(crate) const DENIED: &str = "The user denied this tool call.";

struct Pending {
    call: ToolCallId,
    name: String,
    input: Value,
    approval: ApprovalState,
}

enum Group {
    Alone(Pending),
    Together(Vec<Pending>),
}

pub(super) async fn run(
    inner: &Arc<Inner>,
    turn: &TurnId,
    cancel: &CancellationToken,
) -> Result<(), EngineError> {
    let (pending, specs, config, compacted_through) = {
        let mut core = inner.core.lock().await;
        let config = View::new(&core.records)
            .config()
            .cloned()
            .ok_or_else(|| EngineError::InvalidLog("no configuration".into()))?;
        let specs = inner.specs_locked(&mut core, &config).await;
        let view = View::new(&core.records);
        // No compaction runs while tools do, so this holds for every call.
        let compacted_through = view.compacted_through();
        let pending: Vec<Pending> = view
            .turn_state(turn)
            .pending_calls()
            .map(|call| Pending {
                call: call.call.clone(),
                name: call.name.to_owned(),
                input: call.input.clone(),
                approval: call.approval,
            })
            .collect();
        (pending, specs, config, compacted_through)
    };
    let parallel = config
        .limits
        .max_parallel_tool_calls
        .unwrap_or(DEFAULT_PARALLEL_TOOL_CALLS) as usize;
    let spec_of = |name: &str| specs.iter().find(|spec| spec.name == name);
    let mut groups: Vec<Group> = Vec::new();
    for call in pending {
        let concurrent = spec_of(&call.name)
            .is_some_and(|spec| spec.effect == ToolEffect::ReadOnly && !spec.needs_approval);
        match (concurrent, groups.last_mut()) {
            (true, Some(Group::Together(calls))) => calls.push(call),
            (true, _) => groups.push(Group::Together(vec![call])),
            (false, _) => groups.push(Group::Alone(call)),
        }
    }
    inner.set_activity(SessionActivity::RunningTools);
    for group in groups {
        if cancel.is_cancelled() {
            break;
        }
        match group {
            Group::Alone(call) => {
                let spec = spec_of(&call.name);
                run_one(inner, turn, call, spec, &config, compacted_through, cancel).await?;
            }
            Group::Together(calls) => {
                let futures: Vec<BoxFuture<'_, Result<(), EngineError>>> = calls
                    .into_iter()
                    .map(|call| {
                        let spec = spec_of(&call.name);
                        Box::pin(run_one(
                            inner,
                            turn,
                            call,
                            spec,
                            &config,
                            compacted_through,
                            cancel,
                        )) as BoxFuture<'_, _>
                    })
                    .collect();
                join_limited(futures, parallel).await?;
            }
        }
    }
    Ok(())
}

async fn run_one(
    inner: &Arc<Inner>,
    turn: &TurnId,
    call: Pending,
    spec: Option<&ToolSpec>,
    config: &SessionConfig,
    compacted_through: Option<Seq>,
    cancel: &CancellationToken,
) -> Result<(), EngineError> {
    let finished = |outcome, text: String| RecordBody::ToolCallFinished {
        turn: turn.clone(),
        call: call.call.clone(),
        outcome,
        content: vec![ToolResultBlock::Text { text }],
    };
    let Some(spec) = spec else {
        inner
            .append(vec![finished(
                ToolOutcome::Failed,
                format!("There is no tool named `{}`.", call.name),
            )])
            .await?;
        return Ok(());
    };
    if cancel.is_cancelled() {
        return Ok(());
    }
    if spec.needs_approval {
        match call.approval {
            ApprovalState::Approved => {}
            ApprovalState::Denied => {
                inner
                    .append(vec![finished(ToolOutcome::Denied, DENIED.into())])
                    .await?;
                return Ok(());
            }
            ApprovalState::None | ApprovalState::Requested => {
                if call.approval == ApprovalState::None {
                    inner
                        .append(vec![RecordBody::ApprovalRequested {
                            turn: turn.clone(),
                            call: call.call.clone(),
                        }])
                        .await?;
                }
                inner.set_activity(SessionActivity::AwaitingApproval);
                let request = ApprovalRequest {
                    session: inner.id.clone(),
                    turn: turn.clone(),
                    call: call.call.clone(),
                    tool: spec.clone(),
                    input: call.input.clone(),
                };
                let decision =
                    match race(cancel.cancelled(), inner.ports.approver.approve(request)).await {
                        Either::Left(()) => return Ok(()),
                        Either::Right(decision) => decision,
                    };
                let mut bodies = vec![RecordBody::ApprovalResolved {
                    turn: turn.clone(),
                    call: call.call.clone(),
                    decision,
                }];
                if decision == ApprovalDecision::Denied {
                    bodies.push(finished(ToolOutcome::Denied, DENIED.into()));
                }
                inner.append(bodies).await?;
                inner.set_activity(SessionActivity::RunningTools);
                if decision == ApprovalDecision::Denied || cancel.is_cancelled() {
                    return Ok(());
                }
            }
        }
    }
    inner
        .append(vec![RecordBody::ToolCallStarted {
            turn: turn.clone(),
            call: call.call.clone(),
            name: call.name.clone(),
            effect: spec.effect,
        }])
        .await?;
    let progress: ToolProgress = {
        let inner = Arc::downgrade(inner);
        let call = call.call.clone();
        Arc::new(move |text| {
            if let Some(inner) = inner.upgrade() {
                inner.delta(Delta::ToolProgress {
                    call: call.clone(),
                    text,
                });
            }
        })
    };
    let invocation = ToolInvocation {
        session: inner.id.clone(),
        turn: turn.clone(),
        call: call.call.clone(),
        name: call.name.clone(),
        input: call.input.clone(),
        workspace_root: config.workspace_root.clone(),
        compacted_through,
    };
    let output = inner
        .ports
        .tools
        .call(invocation, progress, cancel.clone())
        .await;
    inner
        .append(vec![RecordBody::ToolCallFinished {
            turn: turn.clone(),
            call: call.call,
            outcome: output.outcome,
            content: output.content,
        }])
        .await?;
    Ok(())
}
