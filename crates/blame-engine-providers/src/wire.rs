//! The wire families this crate speaks, and the names they go by.

/// One request/response format. Native items are only ever replayed to the
/// wire that produced them, so the name stored with each item is ours, not
/// the client library's: a stored session never depends on Rig's spelling.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Wire {
    AnthropicMessages,
    OpenAiResponses,
    OpenAiChat,
    GeminiGenerateContent,
}

impl Wire {
    /// The name stored in `NativeItem::wire`.
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::AnthropicMessages => "anthropic-messages",
            Self::OpenAiResponses => "openai-responses",
            Self::OpenAiChat => "openai-chat",
            Self::GeminiGenerateContent => "gemini-generate-content",
        }
    }

    /// Rig's name for the same API (`Origin::api`). Rig replays a turn's
    /// provider items only when its origin names the target's API,
    /// provider and model; the round-trip tests pin these strings.
    pub(crate) fn rig_api(self) -> &'static str {
        match self {
            Self::AnthropicMessages => "anthropic.messages",
            Self::OpenAiResponses => "openai.responses",
            Self::OpenAiChat => "openai.chat",
            Self::GeminiGenerateContent => "gemini.generate_content",
        }
    }

    /// Where a tool call item keeps the call's id, as a JSON pointer.
    pub(crate) fn call_id_slot(self) -> &'static str {
        match self {
            Self::AnthropicMessages | Self::OpenAiChat => "/id",
            Self::OpenAiResponses => "/call_id",
            Self::GeminiGenerateContent => "/functionCall/id",
        }
    }

    /// Whether a native item with no canonical form is reasoning the
    /// provider withheld, which Rig replays as a redacted reasoning block
    /// rather than as an opaque item.
    pub(crate) fn is_redacted_reasoning(self, item: &serde_json::Value) -> bool {
        match self {
            Self::AnthropicMessages => {
                item.get("type").and_then(serde_json::Value::as_str) == Some("redacted_thinking")
            }
            Self::OpenAiResponses | Self::OpenAiChat | Self::GeminiGenerateContent => false,
        }
    }
}
