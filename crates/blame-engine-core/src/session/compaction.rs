//! Replacing the older part of the history by a summary the model writes.

use super::{Inner, stream};
use crate::error::EngineError;
use crate::ports::{CachePlan, ModelRequest};
use crate::projection::{View, cache_breakpoints, with_user_text};
use crate::race::{Either, race};
use blame_engine_protocol::{AssistantBlock, NoticeLevel, RecordBody, SessionActivity};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Reason {
    /// Before a new request: only if the estimate says so or a compaction
    /// was asked for while the turn ran.
    Auto,
    /// The provider said the context does not fit.
    Overflow,
    Manual,
}

const NOTICE_FAILED: &str = "compaction_failed";

/// Compacts if `reason` calls for it. `Ok(true)` once a `ContextCompacted`
/// is stored.
pub(super) async fn compact(
    inner: &Inner,
    reason: Reason,
    cancel: &CancellationToken,
) -> Result<bool, EngineError> {
    let Some((request, through)) = plan(inner, reason).await? else {
        return Ok(false);
    };
    inner.set_activity(SessionActivity::Compacting);
    let mut attempt = 1;
    loop {
        match stream::run(inner, request.clone(), None, cancel).await {
            stream::End::Reply { blocks, usage, .. } => {
                let summary: Vec<&str> = blocks
                    .iter()
                    .filter_map(|block| match block {
                        AssistantBlock::Text { text, .. } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect();
                let summary = summary.join("\n\n");
                if summary.trim().is_empty() {
                    inner
                        .notice(
                            NoticeLevel::Warning,
                            NOTICE_FAILED,
                            "The model returned an empty summary.".into(),
                        )
                        .await?;
                    return Ok(false);
                }
                inner
                    .append(vec![RecordBody::ContextCompacted {
                        through,
                        summary,
                        usage,
                    }])
                    .await?;
                return Ok(true);
            }
            stream::End::Cancelled => return Ok(false),
            stream::End::Failed(error) => match inner.options.retry.delay(attempt, &error) {
                Some(wait) => {
                    inner.set_activity(SessionActivity::Retrying {
                        in_ms: u64::try_from(wait.as_millis()).unwrap_or(u64::MAX),
                    });
                    if let Either::Right(()) =
                        race(inner.ports.clock.sleep(wait), cancel.cancelled()).await
                    {
                        return Ok(false);
                    }
                    inner.set_activity(SessionActivity::Compacting);
                    attempt += 1;
                }
                None => {
                    inner
                        .notice(
                            NoticeLevel::Warning,
                            NOTICE_FAILED,
                            format!("The history could not be compacted: {}", error.message),
                        )
                        .await?;
                    return Ok(false);
                }
            },
        }
    }
}

/// The summary request and where the summary will end, or `None` when no
/// compaction is due or possible.
async fn plan(inner: &Inner, reason: Reason) -> Result<Option<(ModelRequest, u64)>, EngineError> {
    let mut core = inner.core.lock().await;
    let Some(config) = View::new(&core.records).config().cloned() else {
        return Ok(None);
    };
    let specs = inner.specs_locked(&mut core, &config).await;
    let view = View::new(&core.records);
    let options = &inner.options.compaction;
    let max = config.limits.max_context_tokens;
    let due = match reason {
        Reason::Auto => {
            core.compact_requested
                || max.is_some_and(|max| {
                    view.estimate_tokens(&specs) as f64 >= max as f64 * options.trigger_ratio
                })
        }
        Reason::Overflow | Reason::Manual => true,
    };
    if !due {
        return Ok(None);
    }
    let keep = match (reason, max) {
        (Reason::Overflow, _) => 0,
        (_, Some(max)) => (max as f64 * options.keep_ratio) as u64,
        (_, None) => options.keep_tokens_without_limit,
    };
    let Some(through) = view.compaction_cut(keep) else {
        return Ok(None);
    };
    let messages = with_user_text(view.messages_through(through), &options.instruction);
    drop(view);
    core.compact_requested = false;
    // Same system prompt, tools and leading messages as the turn's requests,
    // so the provider serves most of this one from its cache.
    let request = ModelRequest {
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
    Ok(Some((request, through)))
}
