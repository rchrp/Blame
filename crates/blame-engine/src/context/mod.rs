//! How harness results are shown to the model: the TypeScript runtime's
//! context rules (`packages/agent-runtime/src/context-projection.ts` and the
//! files it uses), recorded as `ContextEdit`s.
//!
//! The TypeScript recomputed its projection before every request and froze
//! what a request had already sent until its prefix broke (a restart, a
//! compaction). Here every change is a stored edit, so the same records give
//! the same request bytes, and the cost of a change decides when it is made:
//!
//! - A result no request has sent yet is shown in its final form right
//!   away: the forward rules (command echo, repeated advice, repeated repair
//!   plans) and any older-block rule that already applies to it. Free: no
//!   cached prefix contains it.
//! - Rewriting a result an earlier request sent breaks the provider's cache
//!   from that block on. The older-block rules (stale and overlapping reads,
//!   completed edits) are applied to sent results all at once, only when the
//!   saving is worth a cache write ([`BATCH_MIN_SAVING_BYTES`]) or right
//!   after a compaction, when the cache is cold anyway.
//! - Images leave when the budget says so (see [`images`]); that is forced.
//!
//! Every target is computed from the stored results, never from an edited
//! text, and nothing at or before the compaction in effect is touched (the
//! model does not see it). A policy run on records it already handled finds
//! nothing to do, so a reopened session sends the same bytes.
//!
//! Deliberate differences from the TypeScript:
//! - The completed-edit rule keeps the tool call (the engine pairs calls
//!   with results) and replaces only its result by the historical text.
//! - Results whose rule rewrites them into fewer parts lose the extra parts
//!   by empty edits, which the core reads as removed blocks.
//! - A repair-plan reference keeps the result's images (the TypeScript lost
//!   them by turning the result into a plain string).
//! - Only tool-result images are budgeted; images the user attached are
//!   left as the user sent them.

mod envelope;
mod images;
mod json;
mod overlap;
mod rules;
#[cfg(test)]
mod tests;

use crate::tools::HARNESS;
use blame_engine_core::ContextPolicy;
use blame_engine_core::projection::View;
use blame_engine_protocol::{
    AssistantBlock, ContextEdit, RecordBody, Seq, ToolCallId, ToolOutcome, ToolResultBlock,
    ToolSpec,
};
use envelope::{Decoded, decode, encode};
use rules::{Older, Seen, drop_command_echo, older_rules};
use serde_json::Value;

/// Rewriting sent results is done only when it saves at least this much:
/// 32 KiB, about 8k tokens at the engine's four bytes a token. Rewriting
/// costs one cache write of the rest of the history (1.25 times the input
/// price on Anthropic, once); the saving is paid back on every later request,
/// so at this size even a long history earns the rewrite back within a few
/// requests, and batches stay rare: one stale read of a mid-sized file is 2k
/// to 8k tokens.
pub const BATCH_MIN_SAVING_BYTES: i64 = 32 * 1024;

/// Results the rules read (`harnessNames` of `tool-result-presentation.ts`).
const HARNESS_RESULTS: [&str; 4] = ["read_code", "search_code", "edit_code", "run_task"];

/// The Blame harness's context rules.
#[derive(Clone, Copy, Debug, Default)]
pub struct HarnessContextPolicy;

impl ContextPolicy for HarnessContextPolicy {
    fn edits(&self, view: &View<'_>, _tools: &[ToolSpec]) -> Vec<ContextEdit> {
        let results = shown_results(view);
        if results.is_empty() {
            return Vec::new();
        }
        let older = older_rules(&results);
        let full = plan(view, &results, &older, false);
        if full.edits.is_empty() {
            return Vec::new();
        }
        if cold(view) || full.saving >= BATCH_MIN_SAVING_BYTES {
            return full.edits;
        }
        plan(view, &results, &older, true).edits
    }
}

/// A tool result the model sees, with the call it answers.
pub struct Shown<'a> {
    pub call: &'a ToolCallId,
    pub name: &'a str,
    pub input: &'a Value,
    /// The reply that made the call. Its results form one message, so this
    /// is the TypeScript's message index: results of one reply are peers.
    pub message: Seq,
    pub seq: Seq,
    pub blocks: &'a [ToolResultBlock],
    /// A request was sent with this result in it.
    pub sent: bool,
    /// The stored result decoded, for harness results the rules read.
    pub original: Option<Decoded>,
}

/// Results after the compaction in effect, in the order the model reads them.
fn shown_results<'a>(view: &View<'a>) -> Vec<Shown<'a>> {
    let floor = view.compacted_through().unwrap_or(0);
    let harness = view
        .config()
        .is_some_and(|config| config.engine_tools.iter().any(|tools| tools == HARNESS));
    let last_request = view
        .items()
        .iter()
        .rev()
        .find_map(|item| match item.record() {
            Some(record) if matches!(record.body, RecordBody::RequestStarted { .. }) => {
                Some(record.seq)
            }
            _ => None,
        });
    let mut out = Vec::new();
    for record in view.items().iter().filter_map(|item| item.record()) {
        let RecordBody::AssistantMessage { blocks, .. } = &record.body else {
            continue;
        };
        if record.seq <= floor {
            continue;
        }
        for block in blocks {
            let AssistantBlock::ToolCall {
                call, name, input, ..
            } = block
            else {
                continue;
            };
            let Some(result) = view.result_record(call) else {
                continue;
            };
            let RecordBody::ToolCallFinished {
                outcome, content, ..
            } = &result.body
            else {
                continue;
            };
            if result.seq <= floor {
                continue;
            }
            // A failed harness call is a result the model reads (`blocked`);
            // cancelled and interrupted ones are the engine's own text.
            let original = (harness
                && HARNESS_RESULTS.contains(&name.as_str())
                && matches!(outcome, ToolOutcome::Completed | ToolOutcome::Failed))
            .then(|| decode(content))
            .flatten();
            out.push(Shown {
                call,
                name,
                input,
                message: record.seq,
                seq: result.seq,
                blocks: content,
                sent: last_request.is_some_and(|request| request > result.seq),
                original,
            });
        }
    }
    out
}

/// A compaction was stored after the last request: no cached prefix
/// survives it, so rewriting older blocks costs nothing more.
fn cold(view: &View<'_>) -> bool {
    for item in view.items().iter().rev() {
        match item.record().map(|record| &record.body) {
            Some(RecordBody::RequestStarted { .. }) => return false,
            Some(RecordBody::ContextCompacted { .. }) => return true,
            _ => {}
        }
    }
    false
}

/// A result as the rules would show it.
struct Target {
    /// Its text parts, in place of the stored text blocks.
    parts: Vec<String>,
    /// Its images stay (subject to the image budget).
    images: bool,
}

struct Plan {
    edits: Vec<ContextEdit>,
    /// Bytes no longer sent again in results that were already sent.
    saving: i64,
}

/// The edits that bring every result to its target. With `freeze_sent`, a
/// sent result is left as it is shown (only its images may still go) and
/// only teaches the forward rules what the model has seen.
fn plan(
    view: &View<'_>,
    results: &[Shown<'_>],
    older: &[Option<Older>],
    freeze_sent: bool,
) -> Plan {
    let mut seen = Seen::default();
    let mut plan = Plan {
        edits: Vec::new(),
        saving: 0,
    };
    let mut live_images = Vec::new();
    for (index, shown) in results.iter().enumerate() {
        let frozen = freeze_sent && shown.sent;
        let mut images_dropped = false;
        if frozen {
            // Only harness results teach the rules, as only they are read.
            if shown.original.is_some()
                && let Some(current) = decode(&current_blocks(view, shown))
            {
                seen.observe(shown, &current.result);
            }
        } else if let Some(original) = &shown.original
            && let target = target(shown, original, older[index].as_ref(), &mut seen)
            // The rules only ever take parts away; anything else is a shape
            // they were not written for, left as it is.
            && target.parts.len() <= original.text_blocks
        {
            for block in 0..original.text_blocks {
                let ToolResultBlock::Text { text } = &shown.blocks[block] else {
                    unreachable!("the text blocks come first");
                };
                let desired = target.parts.get(block).map_or("", String::as_str);
                let block = u32::try_from(block).expect("a result has few blocks");
                let current = view.edit_of(shown.seq, block).unwrap_or(text);
                if current != desired {
                    if shown.sent {
                        plan.saving += current.len() as i64 - desired.len() as i64;
                    }
                    plan.edits.push(ContextEdit {
                        target: shown.seq,
                        block,
                        replacement: desired.to_owned(),
                    });
                }
            }
            images_dropped = !target.images;
        }
        for (block, content) in shown.blocks.iter().enumerate() {
            let ToolResultBlock::Image { blob } = content else {
                continue;
            };
            let block = u32::try_from(block).expect("a result has few blocks");
            let current = view.edit_of(shown.seq, block);
            if images_dropped {
                if current != Some("") {
                    plan.edits.push(ContextEdit {
                        target: shown.seq,
                        block,
                        replacement: String::new(),
                    });
                }
            } else if current.is_none() {
                // An image an edit replaced stays replaced.
                live_images.push(images::Image {
                    seq: shown.seq,
                    block,
                    blob,
                    frozen,
                });
            }
        }
    }
    for (seq, block, text) in images::replacements(&live_images) {
        plan.edits.push(ContextEdit {
            target: seq,
            block,
            replacement: text.into(),
        });
    }
    plan
}

/// What `shown` looks like with the rules applied, from its stored result.
fn target(shown: &Shown<'_>, original: &Decoded, older: Option<&Older>, seen: &mut Seen) -> Target {
    let has_images = shown.blocks.len() > original.text_blocks;
    match older {
        // The TypeScript dropped the call and its result; nothing else
        // reads them.
        Some(Older::Text(text)) => Target {
            parts: vec![text.clone()],
            images: false,
        },
        Some(Older::Result(result)) => {
            let mut result = result.clone();
            seen.present(shown, &mut result);
            Target {
                parts: encode(&result, false),
                images: false,
            }
        }
        None => {
            let mut result = original.result.clone();
            let echo = shown.name == "run_task" && drop_command_echo(&mut result, shown.input);
            let presented = seen.present(shown, &mut result);
            let parts = if echo || presented {
                encode(&result, has_images)
            } else {
                // Unchanged: the stored text, so an earlier edit is undone.
                shown.blocks[..original.text_blocks]
                    .iter()
                    .filter_map(|block| match block {
                        ToolResultBlock::Text { text } => Some(text.clone()),
                        ToolResultBlock::Image { .. } => None,
                    })
                    .collect()
            };
            Target {
                parts,
                images: true,
            }
        }
    }
}

/// The blocks of a result as the model is shown them now.
fn current_blocks(view: &View<'_>, shown: &Shown<'_>) -> Vec<ToolResultBlock> {
    shown
        .blocks
        .iter()
        .enumerate()
        .filter_map(|(index, block)| {
            let edit = u32::try_from(index)
                .ok()
                .and_then(|index| view.edit_of(shown.seq, index));
            match edit {
                Some("") => None,
                Some(text) => Some(ToolResultBlock::Text { text: text.into() }),
                None => Some(block.clone()),
            }
        })
        .collect()
}
