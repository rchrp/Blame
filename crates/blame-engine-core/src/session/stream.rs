//! One model request, from sending it to its complete reply, watched for
//! silence and for the machine going to sleep.

use super::Inner;
use crate::policy::WatchdogOptions;
use crate::ports::{Clock, ModelEvent, ModelRequest, ProviderError};
use crate::race::{Either, race};
use blame_engine_protocol::{
    AssistantBlock, BlockKind, Delta, ErrorInfo, ErrorKind, RequestId, SessionActivity, StopReason,
    ToolCallId, Usage,
};
use std::collections::BTreeMap;
use std::future::{Future, poll_fn};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

pub(super) enum End {
    Reply {
        blocks: Vec<AssistantBlock>,
        stop: StopReason,
        usage: Usage,
    },
    Failed(ErrorInfo),
    Cancelled,
}

enum Waited<T> {
    Done(T),
    Stalled(ErrorInfo),
    Cancelled,
}

/// Sends `request` and collects its reply. With `forward`, the reply's
/// deltas reach subscribers as they arrive and tool calls get their engine
/// ids; without it (a compaction summary) nothing is shown.
pub(super) async fn run(
    inner: &Inner,
    request: ModelRequest,
    forward: Option<&RequestId>,
    cancel: &CancellationToken,
) -> End {
    let provider = inner.ports.provider.clone();
    let mut stream = match guarded(inner, provider.stream(request), cancel).await {
        Waited::Done(Ok(stream)) => stream,
        Waited::Done(Err(error)) => return End::Failed(error.into()),
        Waited::Stalled(error) => return End::Failed(error),
        Waited::Cancelled => return End::Cancelled,
    };
    let mut blocks: BTreeMap<u32, AssistantBlock> = BTreeMap::new();
    let mut ids: BTreeMap<u32, ToolCallId> = BTreeMap::new();
    let mut streaming = false;
    loop {
        let next = poll_fn(|cx| stream.as_mut().poll_next(cx));
        let event = match guarded(inner, next, cancel).await {
            Waited::Done(Some(Ok(event))) => event,
            Waited::Done(Some(Err(error))) => return End::Failed(error.into()),
            Waited::Done(None) => {
                return End::Failed(
                    ProviderError::new(
                        ErrorKind::Transport,
                        "The stream ended before the reply was complete.",
                    )
                    .into(),
                );
            }
            Waited::Stalled(error) => return End::Failed(error),
            Waited::Cancelled => return End::Cancelled,
        };
        if !streaming && forward.is_some() {
            streaming = true;
            inner.set_activity(SessionActivity::Streaming);
        }
        match event {
            ModelEvent::BlockStarted { index, kind, tool } => {
                let call = (kind == BlockKind::ToolCall)
                    .then(|| ids.entry(index).or_insert_with(|| new_call(inner)).clone());
                if let Some(request) = forward {
                    inner.delta(Delta::BlockStarted {
                        request: request.clone(),
                        index,
                        kind,
                        call,
                        tool,
                    });
                }
            }
            ModelEvent::TextDelta { index, text } => {
                if let Some(request) = forward {
                    inner.delta(Delta::Text {
                        request: request.clone(),
                        index,
                        text,
                    });
                }
            }
            ModelEvent::ReasoningDelta { index, text } => {
                if let Some(request) = forward {
                    inner.delta(Delta::Reasoning {
                        request: request.clone(),
                        index,
                        text,
                    });
                }
            }
            ModelEvent::ToolInputDelta { index, json } => {
                if let Some(request) = forward {
                    inner.delta(Delta::ToolInput {
                        request: request.clone(),
                        index,
                        json,
                    });
                }
            }
            ModelEvent::BlockFinished { index, mut block } => {
                if let AssistantBlock::ToolCall { call, .. } = &mut block {
                    *call = ids.entry(index).or_insert_with(|| new_call(inner)).clone();
                }
                blocks.insert(index, block);
            }
            ModelEvent::Finished { stop, usage } => {
                return End::Reply {
                    blocks: blocks.into_values().collect(),
                    stop,
                    usage,
                };
            }
        }
    }
}

/// Tool calls get engine ids, unique whatever provider made them.
fn new_call(inner: &Inner) -> ToolCallId {
    ToolCallId(inner.ports.ids.next("call"))
}

/// Waits for `future` unless the user interrupts or the watchdog fires
/// first. The interrupt is checked first, then the future, so an answer that
/// is already there is never lost to a timer that is also due.
async fn guarded<F: Future>(
    inner: &Inner,
    future: F,
    cancel: &CancellationToken,
) -> Waited<F::Output> {
    let watched = race(
        future,
        watchdog(inner.ports.clock.as_ref(), &inner.options.watchdog),
    );
    match race(cancel.cancelled(), watched).await {
        Either::Left(()) => Waited::Cancelled,
        Either::Right(Either::Left(value)) => Waited::Done(value),
        Either::Right(Either::Right(error)) => Waited::Stalled(error),
    }
}

/// Resolves when nothing should be expected any more: the inactivity limit
/// passed, or the wall clock jumped far beyond the time slept, which means
/// the machine was suspended and the connection is almost surely dead.
async fn watchdog(clock: &dyn Clock, options: &WatchdogOptions) -> ErrorInfo {
    let mut waited = Duration::ZERO;
    loop {
        let slice = options
            .check_every
            .min(options.inactivity.saturating_sub(waited))
            .max(Duration::from_millis(1));
        let before = clock.now_ms();
        clock.sleep(slice).await;
        let elapsed = Duration::from_millis(clock.now_ms().saturating_sub(before));
        if elapsed > slice + options.sleep_jump {
            return ErrorInfo {
                kind: ErrorKind::Stalled,
                message: format!(
                    "The machine was asleep for about {}s while waiting for the model.",
                    elapsed.as_secs()
                ),
                retry_after_ms: None,
            };
        }
        waited += slice;
        if waited >= options.inactivity {
            return ErrorInfo {
                kind: ErrorKind::Stalled,
                message: format!(
                    "The model sent nothing for {}s.",
                    options.inactivity.as_secs()
                ),
                retry_after_ms: None,
            };
        }
    }
}
