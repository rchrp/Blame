//! `ModelRequest` → Rig's `CompletionRequest`.

use crate::native::{self, Target};
use crate::wire::Wire;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use blame_engine_core::ports::{ModelMessage, ModelRequest, ProviderError, ToolResultMessage};
use blame_engine_protocol::{
    AssistantBlock, BlobRef, ErrorKind, ReasoningEffort, ToolOutcome, ToolResultBlock, UserBlock,
};
use rig_core::completion::{
    CachePoint, CacheRetention, CompletionRequest, Effort, GenerationOptions, OnUnsupported,
    ToolDefinition,
};
use rig_core::message::{
    CallId, Document, DocumentData, DocumentMediaType, DocumentSourceKind, Image, ImageMediaType,
    Message, MimeType, Text, ToolName, ToolResult, ToolResultContent, UserContent,
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
                native::to_rig_turn(blocks, target)
                    .map_err(|error| invalid(error.0))?
                    .map(Message::Assistant)
            }
            ModelMessage::ToolResults(results) => {
                Some(tool_results(results, &tool_names, request).await?)
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

    // An option a model cannot honour is skipped rather than failing the
    // request: the loop asks for what it wants and each provider does what
    // it can.
    let mut options = GenerationOptions::new().on_unsupported(OnUnsupported::Ignore);
    if let Some(effort) = request.reasoning {
        options = options.reasoning(effort_of(effort));
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
        rig.additional_params = Some(json!({ "store": false }));
    }
    Ok(rig)
}

fn effort_of(effort: ReasoningEffort) -> Effort {
    match effort {
        ReasoningEffort::Minimal => Effort::Minimal,
        ReasoningEffort::Low => Effort::Low,
        ReasoningEffort::Medium => Effort::Medium,
        ReasoningEffort::High => Effort::High,
        ReasoningEffort::Xhigh => Effort::XHigh,
    }
}

async fn user(
    blocks: &[UserBlock],
    request: &ModelRequest,
    wire: Wire,
) -> Result<Message, ProviderError> {
    let mut content = Vec::with_capacity(blocks.len());
    for block in blocks {
        content.push(match block {
            UserBlock::Text { text } => UserContent::Text(Text::new(text)),
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
            call: CallId::from_wire(result.call.as_str()),
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
