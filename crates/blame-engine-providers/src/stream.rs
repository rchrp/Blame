//! Rig's completion stream → `ModelEvent`s.
//!
//! Deltas are forwarded as they arrive. The complete blocks are taken from
//! the reply Rig folds once the provider ended it, not from each part's end
//! event: a provider may still add to a part after it closed (Gemini sends
//! a thought signature in a part of its own, which Rig merges into the
//! block before it), and only the folded reply has that. So every
//! `BlockFinished` comes after the last delta, followed by one `Finished`.

use crate::error;
use crate::native::{self, Target};
use blame_engine_core::ports::{ModelEvent, ModelStream};
use blame_engine_protocol::{BlockKind, StopReason, Usage};
use futures_util::StreamExt;
use rig_core::completion::{CompletionResponse, FinishReason, Usage as RigUsage};
use rig_core::operation::Completion;
use rig_core::streaming::{Item, PartKind, StreamEvent, Streamed};

pub(crate) fn events(mut reply: Streamed<Completion>, target: Target) -> ModelStream {
    Box::pin(async_stream::stream! {
        // The parts that ended with a block. The folded reply lists those
        // blocks in the order their parts started, which is not the order
        // they ended: Rig closes a Responses reasoning item only once the
        // reply is complete, after the calls that followed it.
        let mut ended: Vec<u32> = Vec::new();
        while let Some(item) = reply.next().await {
            let event = match item {
                Ok(Item::Event(event)) => event,
                // A payload Rig does not model changes nothing we store.
                Ok(Item::Unknown(_)) => continue,
                Err(failure) => {
                    yield Err(error::from_rig(&failure));
                    return;
                }
            };
            let mapped = match event {
                StreamEvent::Start { part, kind, name } => block_kind(kind).map(|kind| {
                    ModelEvent::BlockStarted {
                        index: index(part),
                        kind,
                        tool: name.map(|name| name.as_str().to_owned()),
                    }
                }),
                StreamEvent::Text { part, text } => Some(ModelEvent::TextDelta {
                    index: index(part),
                    text,
                }),
                StreamEvent::Reasoning { part, text } => Some(ModelEvent::ReasoningDelta {
                    index: index(part),
                    text,
                }),
                StreamEvent::Arguments { part, json } => Some(ModelEvent::ToolInputDelta {
                    index: index(part),
                    json,
                }),
                StreamEvent::End { part, .. } => {
                    ended.push(index(part));
                    None
                }
            };
            if let Some(mapped) = mapped {
                yield Ok(mapped);
            }
        }
        let response = match reply.finish().await {
            Ok(response) => response,
            Err(failure) => {
                yield Err(error::from_rig(&failure));
                return;
            }
        };
        if let Some(message) = &response.error {
            yield Err(error::from_reported(message));
            return;
        }
        let stop = stop_reason(&response);
        let usage = usage(&response.usage);
        // Should the parts and the blocks not pair up, the blocks take
        // their place in the reply as their index.
        ended.sort_unstable();
        ended.dedup();
        let paired = ended.len() == response.choice.len();
        for (at, block) in response.choice.into_iter().enumerate() {
            let index = match paired {
                true => ended[at],
                false => u32::try_from(at).unwrap_or(u32::MAX),
            };
            if let Some(block) = native::from_rig_block(block, &target) {
                yield Ok(ModelEvent::BlockFinished { index, block });
            }
        }
        yield Ok(ModelEvent::Finished { stop, usage });
    })
}

fn index(part: rig_core::streaming::Part) -> u32 {
    u32::try_from(part.index()).unwrap_or(u32::MAX)
}

/// Images and provider items have no kind of ours: they show nothing while
/// they stream and arrive whole in their `BlockFinished`.
fn block_kind(kind: PartKind) -> Option<BlockKind> {
    match kind {
        PartKind::Text => Some(BlockKind::Text),
        PartKind::Reasoning => Some(BlockKind::Reasoning),
        PartKind::ToolCall => Some(BlockKind::ToolCall),
        PartKind::Image | PartKind::Opaque => None,
    }
}

fn stop_reason(response: &CompletionResponse) -> StopReason {
    let calls = response.tool_calls().next().is_some();
    match response.finish_reason() {
        Some(FinishReason::Length) => StopReason::MaxOutputTokens,
        Some(FinishReason::ContentFilter) => StopReason::Refusal,
        Some(FinishReason::Other(reason)) if reason == "refusal" => StopReason::Refusal,
        _ if calls => StopReason::ToolUse,
        Some(FinishReason::Stop) | None => StopReason::EndTurn,
        Some(_) => StopReason::Other,
    }
}

/// Rig counts cache reads and writes inside `input_tokens`; ours do not
/// overlap. The cost is kept only when every part of it was priced: a
/// partial figure would read as the real one.
pub(crate) fn usage(usage: &RigUsage) -> Usage {
    let cache_read = usage.cached_input_tokens;
    let cache_write = usage.cache_creation_input_tokens;
    Usage {
        input_tokens: usage.input_tokens.map(|input| {
            input
                .saturating_sub(cache_read.unwrap_or(0))
                .saturating_sub(cache_write.unwrap_or(0))
        }),
        output_tokens: usage.output_tokens,
        cache_read_tokens: cache_read,
        cache_write_tokens: cache_write,
        reasoning_tokens: usage.reasoning_tokens,
        cost_micro_usd: usage
            .cost
            .filter(|cost| cost.is_complete() && cost.total.is_finite() && cost.total >= 0.0)
            .map(|cost| (cost.total * 1_000_000.0).round() as u64),
    }
}
