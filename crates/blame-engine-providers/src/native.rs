//! Assistant blocks between our records and Rig's messages.
//!
//! A stored block keeps the provider's own item (`NativeItem::item`), never
//! Rig's `Native` wrapper: Rig's fingerprint and baseline are recomputed
//! from the canonical fields each time the block is rebuilt, which
//! `AssistantContent::with_native` does from the bare item. A block's item
//! is replayed only to the wire, provider and model that produced it.

use crate::catalog::Catalog;
use crate::registry::ProviderKind;
use crate::wire::Wire;
use blame_engine_protocol::{AssistantBlock, ModelRef, NativeItem, ToolCallId};
use rig_core::message::{
    AssistantContent, AssistantMessage, CallId, Opaque, Origin, Reasoning, Text, ToolCall,
    ToolFunction, ToolName,
};
use serde_json::Value;
use std::sync::Arc;

/// Who a request goes to: the context in which stored items may replay.
#[derive(Clone, Debug)]
pub(crate) struct Target {
    pub(crate) kind: ProviderKind,
    /// The catalog copy the request is encoded with, start to end.
    pub(crate) catalog: Arc<Catalog>,
    pub(crate) wire: Wire,
    pub(crate) model: ModelRef,
    /// Rig's descriptor name for the provider (`anthropic`, `chatgpt`…),
    /// which Rig compares with a turn's origin before replaying its items.
    pub(crate) rig_provider: &'static str,
    /// Whether replies cost the catalog's list price. A subscription (the
    /// Claude Code bridge speaks Anthropic's API but bills a plan) or an
    /// arbitrary server does not, whatever model it names.
    pub(crate) priced: bool,
    /// Whether the effort goes to the server as asked, past Rig's catalog:
    /// the Claude Code bridge hands it to Claude Code's `--effort`, which
    /// takes levels (`xhigh`) the API catalog does not list.
    pub(crate) effort_as_asked: bool,
}

impl Target {
    /// The model's catalog entry, as this provider serves it.
    pub(crate) fn spec(&self) -> Option<rig_core::catalog::ModelSpec> {
        self.catalog
            .spec(self.kind, self.rig_provider, &self.model.model)
    }

    pub(crate) fn facts(&self) -> rig_core::catalog::ModelFacts {
        self.catalog
            .facts(self.kind, self.rig_provider, &self.model.model)
    }

    fn owns(&self, native: &NativeItem) -> bool {
        native.wire == self.wire.name() && native.model == self.model
    }

    /// The item of a reply block, wrapped for storage.
    pub(crate) fn native(&self, item: Value) -> NativeItem {
        NativeItem {
            wire: self.wire.name().to_owned(),
            model: self.model.clone(),
            item,
        }
    }
}

/// One stored assistant turn as Rig takes it. When every item of the turn
/// belongs to the target, the turn carries the target as its origin and Rig
/// sends the items verbatim (signatures, encrypted reasoning, thought
/// signatures); otherwise it goes out from its canonical fields and the
/// blocks with no canonical form are dropped. Returns `None` when nothing
/// is left to send.
pub(crate) fn to_rig_turn(
    blocks: &[AssistantBlock],
    target: &Target,
) -> Result<Option<AssistantMessage>, InvalidBlock> {
    let replay = blocks
        .iter()
        .filter_map(native_of)
        .all(|native| target.owns(native));
    let mut content = Vec::with_capacity(blocks.len());
    for block in blocks {
        let native = native_of(block)
            .filter(|_| replay)
            .map(|native| native.item.clone());
        let canonical = match block {
            AssistantBlock::Text { text, .. } => AssistantContent::Text(Text::new(text)),
            AssistantBlock::Reasoning { text, .. } => {
                AssistantContent::Reasoning(Reasoning::new(text))
            }
            AssistantBlock::ToolCall {
                call, name, input, ..
            } => {
                let canonical = tool_call(call, name, input)?;
                content.push(match native {
                    Some(item) => canonical.with_native(with_call_id(item, target.wire, call)),
                    None => canonical,
                });
                continue;
            }
            // No canonical form: the item goes back to its own model, or
            // nowhere.
            AssistantBlock::Opaque { .. } => {
                match native {
                    Some(item) if target.wire.is_redacted_reasoning(&item) => {
                        let reasoning = Reasoning {
                            redacted: true,
                            ..Reasoning::default()
                        };
                        content.push(AssistantContent::Reasoning(reasoning).with_native(item));
                    }
                    Some(item) => {
                        content.push(AssistantContent::Opaque(Opaque { item, replay: true }))
                    }
                    None => {}
                }
                continue;
            }
        };
        content.push(match native {
            Some(item) => canonical.with_native(item),
            None => canonical,
        });
    }
    if content.is_empty() {
        return Ok(None);
    }
    let origin = replay.then(|| {
        Origin::new(
            target.wire.rig_api(),
            target.rig_provider,
            target.model.model.clone(),
        )
    });
    Ok(Some(AssistantMessage::new(content).with_origin(origin)))
}

fn native_of(block: &AssistantBlock) -> Option<&NativeItem> {
    match block {
        AssistantBlock::Text { native, .. }
        | AssistantBlock::Reasoning { native, .. }
        | AssistantBlock::ToolCall { native, .. } => native.as_ref(),
        AssistantBlock::Opaque { native } => Some(native),
    }
}

/// A canonical tool call. Its arguments go through `ToolFunction::new`,
/// which reads a string back as the text the model sent: how
/// [`from_rig_block`] stores arguments that were not a JSON object.
fn tool_call(
    call: &ToolCallId,
    name: &str,
    input: &Value,
) -> Result<AssistantContent, InvalidBlock> {
    let name = ToolName::new(name).map_err(|_| InvalidBlock("a tool call has no name"))?;
    Ok(AssistantContent::ToolCall(ToolCall::new(
        CallId::from_wire(call.as_str()),
        ToolFunction::new(name, input.clone()),
    )))
}

/// The item with its call id set to `call`, so the item and the result that
/// answers it agree even when the engine renamed the call. An item that
/// carries no id (Gemini models that send none) is left without one.
fn with_call_id(mut item: Value, wire: Wire, call: &ToolCallId) -> Value {
    if let Some(slot) = item.pointer_mut(wire.call_id_slot())
        && slot.is_string()
    {
        *slot = Value::String(call.as_str().to_owned());
    }
    item
}

/// One block of a reply as we store it. `None` for what cannot be replayed
/// to anyone: a provider item Rig marks as not to be sent back, or an image
/// without its item.
pub(crate) fn from_rig_block(block: AssistantContent, target: &Target) -> Option<AssistantBlock> {
    let native = |native: Option<rig_core::message::Native>| native.map(|n| target.native(n.item));
    match block {
        AssistantContent::Text(text) => Some(AssistantBlock::Text {
            text: text.text,
            native: native(text.native),
        }),
        // Withheld reasoning has no canonical form: only its item means
        // anything, and only to the model that wrote it.
        AssistantContent::Reasoning(reasoning) if reasoning.redacted => {
            native(reasoning.native).map(|native| AssistantBlock::Opaque { native })
        }
        AssistantContent::Reasoning(reasoning) => Some(AssistantBlock::Reasoning {
            text: reasoning.text,
            native: native(reasoning.native),
        }),
        AssistantContent::ToolCall(call) => {
            let input = match &call.function.invalid_arguments {
                Some(raw) => Value::String(raw.clone()),
                None => Value::Object(call.function.arguments.clone()),
            };
            Some(AssistantBlock::ToolCall {
                call: ToolCallId(call.id.wire().into_owned()),
                name: call.function.name.as_str().to_owned(),
                input,
                native: native(call.native),
            })
        }
        AssistantContent::Image(image) => {
            native(image.native).map(|native| AssistantBlock::Opaque { native })
        }
        AssistantContent::Opaque(opaque) if opaque.replay => Some(AssistantBlock::Opaque {
            native: target.native(opaque.item),
        }),
        _ => None,
    }
}

/// A stored block Rig cannot represent.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub(crate) struct InvalidBlock(pub(crate) &'static str);
