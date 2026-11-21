//! `ModelRequest` → Rig's `CompletionRequest`.

use crate::native::{self, Target};
use crate::wire::Wire;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use blame_engine_core::ports::{ModelMessage, ModelRequest, ProviderError, ToolResultMessage};
use blame_engine_protocol::{
    AssistantBlock, BlobRef, ErrorKind, ReasoningEffort, ToolOutcome, ToolResultBlock,
    ULTRA_NOTICE, UserBlock,
};
use rig_core::catalog::ReasoningSupport;
use rig_core::completion::{
    CachePoint, CacheRetention, CompletionRequest, Effort, GenerationOptions, OnUnsupported,
    Reasoning, ToolDefinition,
};
use rig_core::message::{
    CallId, Document, DocumentData, DocumentMediaType, DocumentSourceKind, Image, ImageMediaType,
    Message, MimeType, Text, ToolChoice, ToolName, ToolResult, ToolResultContent, UserContent,
};
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;

/// The Rig request for `request` on `target`'s wire.
pub(crate) async fn to_rig(
    request: &ModelRequest,
    target: &Target,
) -> Result<CompletionRequest, ProviderError> {
    let mut history: Vec<Arc<Message>> = Vec::with_capacity(request.messages.len() + 1);
    if !request.system.is_empty() {
        history.push(Arc::new(Message::System {
            content: request.system.clone(),
        }));
    }
    // A result names the tool it answers (Gemini matches by name), which
    // our result messages leave to the call before them.
    let mut tool_names: HashMap<&str, &str> = HashMap::new();
    // The engine's call id → the one the provider sees (its own, on a turn
    // it produced).
    let mut wire_ids: HashMap<String, String> = HashMap::new();
    // How many user and assistant messages Rig holds after each of ours:
    // cache points count Rig's, and a turn with nothing left to send is
    // not sent.
    let mut sent_after = Vec::with_capacity(request.messages.len());
    let mut sent = 0;
    for message in &request.messages {
        let rig = match message {
            ModelMessage::User(blocks) => Some(user(blocks, request, target.wire).await?),
            ModelMessage::Assistant(blocks) => {
                for block in blocks {
                    if let AssistantBlock::ToolCall { call, name, .. } = block {
                        tool_names.insert(call.as_str(), name.as_str());
                    }
                }
                native::to_rig_turn(blocks, target, &mut wire_ids)
                    .map_err(|error| invalid(error.0))?
                    .map(Message::Assistant)
            }
            ModelMessage::ToolResults(results) => {
                Some(tool_results(results, &tool_names, &wire_ids, request).await?)
            }
        };
        if let Some(rig) = rig {
            history.push(Arc::new(rig));
            sent += 1;
        }
        sent_after.push(sent);
    }

    let mut rig = CompletionRequest::new(Message::user(""));
    rig.chat_history = history;
    rig.tools = request
        .tools
        .iter()
        .map(|tool| {
            let name =
                ToolName::new(tool.name.as_str()).map_err(|_| invalid("a tool has no name"))?;
            Ok(Arc::new(ToolDefinition::new(
                name,
                tool.description.clone(),
                tool.input_schema.clone(),
            )))
        })
        .collect::<Result<_, ProviderError>>()?;
    rig.max_tokens = request.max_output_tokens.map(u64::from);
    // The loop asks only where `forces_tool` said yes.
    if let Some(name) = &request.forced_tool {
        let name =
            ToolName::new(name.as_str()).map_err(|_| invalid("the forced tool has no name"))?;
        rig.tool_choice = Some(ToolChoice::Specific {
            function_names: vec![name],
        });
    }

    // An option a model cannot honour is skipped rather than failing the
    // request: the loop asks for what it wants and each provider does what
    // it can.
    let mut options = GenerationOptions::new().on_unsupported(OnUnsupported::Ignore);
    let mut raw = serde_json::Map::new();
    match request.reasoning {
        Some(effort) if target.effort_as_asked => {
            let effort = match effort {
                // Claude Code's lowest level: it has no "off".
                ReasoningEffort::Off | ReasoningEffort::Minimal | ReasoningEffort::Low => "low",
                ReasoningEffort::Medium => "medium",
                ReasoningEffort::High => "high",
                ReasoningEffort::Xhigh => "xhigh",
                ReasoningEffort::Max => "max",
            };
            raw.insert("output_config".into(), json!({ "effort": effort }));
        }
        Some(effort) => {
            if let Some(reasoning) = reasoning(effort, target, request.max_output_tokens) {
                options = options.reasoning(reasoning);
            }
        }
        None => {}
    }
    if !request.cache.key.is_empty() {
        options = options.cache_key(request.cache.key.clone());
    }
    // Anthropic takes its long retention as a static-prefix TTL on the
    // wire (see `registry`), not as the request-wide retention, which would
    // mark the whole conversation at the one-hour price.
    if request.cache.long_lived_prefix && target.wire == Wire::OpenAiResponses {
        options = options.cache(CacheRetention::Long);
    }
    rig.options = options;

    let mut points: Vec<CachePoint> = request
        .cache
        .breakpoints
        .iter()
        .filter_map(|&at| sent_after.get(at).copied())
        .filter(|&messages| messages > 0)
        .map(CachePoint::Messages)
        .collect();
    points.sort_by_key(|point| match point {
        CachePoint::Messages(messages) => *messages,
        _ => 0,
    });
    points.dedup();
    rig.cache_points = points;

    // The public OpenAI API would otherwise keep each response server side
    // and replay reasoning from there; stateless requests carry the
    // encrypted reasoning instead, so a session never depends on what
    // OpenAI still stores.
    if target.wire == Wire::OpenAiResponses && target.rig_provider == "openai" {
        raw.insert("store".into(), json!(false));
    }
    rig.additional_params = (!raw.is_empty()).then_some(serde_json::Value::Object(raw));
    Ok(rig)
}

/// The effort as the model takes it: the nearest level it lists. A model
/// that only takes a thinking budget (Gemini 2.5, Claude before 4.6)
/// refuses any level, which would be skipped without a word, so the effort
/// becomes a budget inside the range the catalog gives it and below the
/// output cap, which the thinking counts towards. `None` when that leaves
/// no room to think. `Off` turns reasoning off where the model allows it,
/// and asks for its least otherwise. A model the catalog does not know
/// gets what was asked, as asked.
fn reasoning(
    effort: ReasoningEffort,
    target: &Target,
    max_output_tokens: Option<u32>,
) -> Option<Reasoning> {
    let spec = target.spec();
    let (levels, budget, can_disable) = match spec.as_ref().map(|spec| &spec.reasoning) {
        Some(ReasoningSupport::Listed {
            levels,
            budget,
            can_disable,
            ..
        }) => (levels.as_slice(), budget.clone(), *can_disable),
        _ => {
            return Some(match effort_of(effort) {
                Some(effort) => Reasoning::Effort(effort),
                None => Reasoning::Off,
            });
        }
    };
    let effort = match effort_of(effort) {
        Some(effort) => effort,
        None if can_disable => return Some(Reasoning::Off),
        // The least the model offers.
        None => Effort::Minimal,
    };
    if !levels.is_empty() {
        return Some(Reasoning::Effort(nearest(effort, levels)));
    }
    let Some(range) = budget else {
        return Some(Reasoning::Effort(effort));
    };
    let wanted: u32 = match effort {
        Effort::Minimal => 1_024,
        Effort::Low => 2_048,
        Effort::Medium => 8_192,
        Effort::High => 16_384,
        Effort::XHigh => 32_768,
        _ => u32::MAX,
    };
    let ceiling = max_output_tokens.map_or(*range.end(), |cap| {
        (*range.end()).min(cap.saturating_sub(1))
    });
    let tokens = wanted.min(ceiling).max(*range.start());
    (tokens <= ceiling).then_some(Reasoning::Budget { tokens })
}

/// The level of `levels` closest to `wanted`, the lower one on a tie: a
/// model without `minimal` gets its lowest, one without `xhigh` its
/// `high` rather than a far dearer `max`.
fn nearest(wanted: Effort, levels: &[Effort]) -> Effort {
    const ORDER: [Effort; 6] = [
        Effort::Minimal,
        Effort::Low,
        Effort::Medium,
        Effort::High,
        Effort::XHigh,
        Effort::Max,
    ];
    let rank = |effort: &Effort| ORDER.iter().position(|level| level == effort);
    let Some(target) = rank(&wanted) else {
        return wanted;
    };
    levels
        .iter()
        .filter_map(|level| Some((rank(level)?, *level)))
        .min_by_key(|(at, _)| (at.abs_diff(target), *at))
        .map_or(wanted, |(_, level)| level)
}

/// Rig's level for `effort`; `None` for `Off`, which is no level.
fn effort_of(effort: ReasoningEffort) -> Option<Effort> {
    Some(match effort {
        ReasoningEffort::Off => return None,
        ReasoningEffort::Minimal => Effort::Minimal,
        ReasoningEffort::Low => Effort::Low,
        ReasoningEffort::Medium => Effort::Medium,
        ReasoningEffort::High => Effort::High,
        ReasoningEffort::Xhigh => Effort::XHigh,
        ReasoningEffort::Max => Effort::Max,
    })
}

async fn user(
    blocks: &[UserBlock],
    request: &ModelRequest,
    wire: Wire,
) -> Result<Message, ProviderError> {
    let mut content = Vec::with_capacity(blocks.len());
    for block in blocks {
        content.push(match block {
            UserBlock::Text { text } | UserBlock::Context { text } => {
                UserContent::Text(Text::new(text))
            }
            UserBlock::Ultra => UserContent::Text(Text::new(ULTRA_NOTICE)),
            UserBlock::Image { blob } => UserContent::Image(image(blob, request).await?),
            UserBlock::Document { blob, name } => {
                UserContent::Document(document(blob, name, request, wire).await?)
            }
        });
    }
    Ok(Message::User { content })
}

async fn tool_results(
    results: &[ToolResultMessage],
    names: &HashMap<&str, &str>,
    wire_ids: &HashMap<String, String>,
    request: &ModelRequest,
) -> Result<Message, ProviderError> {
    let mut content = Vec::with_capacity(results.len());
    for result in results {
        let name = names
            .get(result.call.as_str())
            .ok_or_else(|| invalid("a tool result answers no call of the history"))?;
        let name = ToolName::new(*name).map_err(|_| invalid("a tool call has no name"))?;
        let mut parts = Vec::with_capacity(result.content.len());
        for part in &result.content {
            parts.push(match part {
                ToolResultBlock::Text { text } => ToolResultContent::Text(Text::new(text)),
                ToolResultBlock::Image { blob } => {
                    ToolResultContent::Image(image(blob, request).await?)
                }
            });
        }
        content.push(UserContent::ToolResult(ToolResult {
            call: CallId::from_wire(
                wire_ids
                    .get(result.call.as_str())
                    .map_or(result.call.as_str(), String::as_str),
            ),
            name,
            content: parts,
            is_error: result.outcome != ToolOutcome::Completed,
        }));
    }
    Ok(Message::User { content })
}

async fn bytes(blob: &BlobRef, request: &ModelRequest) -> Result<Vec<u8>, ProviderError> {
    request
        .blobs
        .blob(&blob.sha256)
        .await
        .map_err(|error| {
            ProviderError::new(
                ErrorKind::Internal,
                format!("reading a blob failed: {error}"),
            )
        })?
        .ok_or_else(|| {
            ProviderError::new(
                ErrorKind::Internal,
                format!("blob {} is not in the store", blob.sha256),
            )
        })
}

async fn image(blob: &BlobRef, request: &ModelRequest) -> Result<Image, ProviderError> {
    let media_type = ImageMediaType::from_mime_type(&blob.media_type)
        .ok_or_else(|| invalid(format!("images of type {} cannot be sent", blob.media_type)))?;
    Ok(Image {
        data: DocumentSourceKind::Base64(BASE64.encode(bytes(blob, request).await?)),
        media_type: Some(media_type),
        ..Image::default()
    })
}

/// A PDF goes as a file, any text as its text. Anthropic shows the
/// document's name to the model as its title; the other wires have no
/// place for it.
async fn document(
    blob: &BlobRef,
    name: &str,
    request: &ModelRequest,
    wire: Wire,
) -> Result<Document, ProviderError> {
    let bytes = bytes(blob, request).await?;
    let (data, media_type) = if blob.media_type == "application/pdf" {
        (
            DocumentData::File(DocumentSourceKind::Base64(BASE64.encode(bytes))),
            Some(DocumentMediaType::PDF),
        )
    } else {
        let text = String::from_utf8(bytes).map_err(|_| {
            invalid(format!(
                "documents of type {} cannot be sent",
                blob.media_type
            ))
        })?;
        (DocumentData::Text(text), None)
    };
    let additional_params =
        (wire == Wire::AnthropicMessages && !name.is_empty()).then(|| json!({ "title": name }));
    Ok(Document {
        data,
        media_type,
        additional_params,
    })
}

fn invalid(message: impl Into<String>) -> ProviderError {
    ProviderError::new(ErrorKind::InvalidRequest, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use blame_engine_protocol::ModelRef;

    fn target(provider: &'static str, model: &str) -> Target {
        Target {
            kind: crate::ProviderKind::from_id(provider).expect("a served provider"),
            catalog: crate::catalog::Catalog::snapshot(),
            wire: Wire::AnthropicMessages,
            model: ModelRef {
                provider: provider.to_owned(),
                model: model.to_owned(),
            },
            rig_provider: provider,
            priced: true,
            effort_as_asked: false,
        }
    }

    #[test]
    fn an_effort_becomes_what_the_model_takes() {
        let levels = [Effort::Low, Effort::Medium, Effort::High, Effort::Max];
        assert_eq!(nearest(Effort::Minimal, &levels), Effort::Low);
        assert_eq!(nearest(Effort::XHigh, &levels), Effort::High);
        assert_eq!(nearest(Effort::Medium, &levels), Effort::Medium);

        let sonnet = target("anthropic", "claude-sonnet-4-6");
        assert_eq!(
            reasoning(ReasoningEffort::Minimal, &sonnet, None),
            Some(Reasoning::Effort(Effort::Low))
        );
        // Claude 4.5 thinks by budget, at least 1024 tokens and below the
        // output cap.
        let older = target("anthropic", "claude-sonnet-4-5");
        assert_eq!(
            reasoning(ReasoningEffort::Medium, &older, Some(64_000)),
            Some(Reasoning::Budget { tokens: 8_192 })
        );
        assert_eq!(
            reasoning(ReasoningEffort::High, &older, Some(4_000)),
            Some(Reasoning::Budget { tokens: 3_999 })
        );
        assert_eq!(reasoning(ReasoningEffort::Low, &older, Some(1_000)), None);
        // A model the catalog does not know gets the level as asked.
        let unknown = target("anthropic", "claude-next");
        assert_eq!(
            reasoning(ReasoningEffort::Xhigh, &unknown, None),
            Some(Reasoning::Effort(Effort::XHigh))
        );
        assert_eq!(
            reasoning(ReasoningEffort::Off, &unknown, None),
            Some(Reasoning::Off)
        );
        // `max` where the model lists it; a budget model's whole range.
        let opus = target("anthropic", "claude-opus-5-5");
        assert_eq!(
            reasoning(ReasoningEffort::Max, &opus, None),
            Some(Reasoning::Effort(Effort::Max))
        );
        assert_eq!(
            reasoning(ReasoningEffort::Max, &older, Some(64_000)),
            Some(Reasoning::Budget { tokens: 63_999 })
        );
        // `off` where the model can turn reasoning off, its least where
        // it cannot.
        assert_eq!(
            reasoning(ReasoningEffort::Off, &sonnet, None),
            Some(Reasoning::Off)
        );
        let gemini = Target {
            kind: crate::ProviderKind::Gemini,
            rig_provider: "gcp.gemini",
            ..target("gemini", "gemini-3.5-flash")
        };
        assert_eq!(
            reasoning(ReasoningEffort::Off, &gemini, None),
            Some(Reasoning::Effort(Effort::Minimal))
        );
    }
}
