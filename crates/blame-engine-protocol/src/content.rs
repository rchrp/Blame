use crate::ids::ToolCallId;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Bytes kept outside the log (images, documents, oversized tool output),
/// addressed by content so the same image is stored once.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct BlobRef {
    /// Lowercase hex SHA-256 of the bytes.
    pub sha256: String,
    pub media_type: String,
    pub bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct ModelRef {
    /// Provider id as the providers crate knows it, e.g. `anthropic`.
    pub provider: String,
    pub model: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum ReasoningEffort {
    /// No reasoning, on a model that can turn it off; the lowest level on
    /// one that cannot.
    Off,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    /// The most the model offers.
    Max,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum UserBlock {
    Text { text: String },
    Image { blob: BlobRef },
    Document { blob: BlobRef, name: String },
}

/// What the provider itself returned for a block, kept verbatim.
///
/// Thinking signatures, encrypted reasoning and thought signatures only work
/// when sent back exactly as received, to the same model. `item` is the
/// provider's own public wire JSON (not a library's wrapper), so a stored
/// session stays replayable whatever client library the engine uses later.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct NativeItem {
    /// Wire family the item belongs to, e.g. `anthropic-messages`.
    pub wire: String,
    pub model: ModelRef,
    pub item: Value,
}

/// One block of a model reply. The plain fields are the canonical form, which
/// any model can be given; `native` is replayed instead when the request goes
/// to the model that produced it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(optional_fields))]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AssistantBlock {
    Text {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        native: Option<NativeItem>,
    },
    Reasoning {
        /// Readable summary, possibly empty when the provider hides it.
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        native: Option<NativeItem>,
    },
    ToolCall {
        call: ToolCallId,
        name: String,
        input: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        native: Option<NativeItem>,
    },
    /// A provider item with no canonical form (redacted thinking, server
    /// tools). Dropped when the request goes to another model.
    Opaque { native: NativeItem },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ToolResultBlock {
    Text { text: String },
    Image { blob: BlobRef },
}

/// Token counts of one model request. The four input/output counters do not
/// overlap: `input_tokens` excludes cache reads and writes, and
/// `output_tokens` includes `reasoning_tokens`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(optional_fields))]
pub struct Usage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_tokens: Option<u64>,
    /// Millionths of a US dollar; absent when the price is unknown or the
    /// model is billed by subscription.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_micro_usd: Option<u64>,
}
