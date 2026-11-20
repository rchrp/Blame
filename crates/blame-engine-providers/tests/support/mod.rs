//! What the wire tests share: the crate's mock provider server (feature
//! `testing`) and builders for model requests.

#![allow(dead_code, unused_imports)]

use async_trait::async_trait;
use blame_engine_core::ports::{
    BlobSource, CachePlan, ModelEvent, ModelMessage, ModelProvider, ModelRequest, ProviderError,
    StoreError,
};
use blame_engine_protocol::rpc::Credential;
use blame_engine_protocol::{
    AssistantBlock, ModelRef, ReasoningEffort, ToolEffect, ToolSpec, UserBlock,
};
pub use blame_engine_providers::testing::*;
use futures_util::StreamExt;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;

/// Blobs held in memory, by hash.
#[derive(Default)]
pub struct Blobs(pub HashMap<String, Vec<u8>>);

#[async_trait]
impl BlobSource for Blobs {
    async fn blob(&self, sha256: &str) -> Result<Option<Vec<u8>>, StoreError> {
        Ok(self.0.get(sha256).cloned())
    }
}

pub fn model(provider: &str, model: &str) -> ModelRef {
    ModelRef {
        provider: provider.to_owned(),
        model: model.to_owned(),
    }
}

pub fn tool(name: &str) -> ToolSpec {
    ToolSpec {
        name: name.to_owned(),
        description: format!("The {name} tool."),
        input_schema: json!({
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"],
        }),
        effect: ToolEffect::ReadOnly,
        ends_turn: false,
        needs_approval: false,
    }
}

pub fn user(text: &str) -> ModelMessage {
    ModelMessage::User(vec![UserBlock::Text {
        text: text.to_owned(),
    }])
}

pub fn request(model: ModelRef, messages: Vec<ModelMessage>) -> ModelRequest {
    ModelRequest {
        model,
        system: "You are a test.".to_owned(),
        messages,
        tools: vec![tool("get_weather"), tool("read_file")],
        reasoning: Some(ReasoningEffort::High),
        max_output_tokens: Some(1000),
        forced_tool: None,
        cache: CachePlan {
            key: "session-1".to_owned(),
            breakpoints: vec![0],
            long_lived_prefix: true,
        },
        blobs: Arc::new(Blobs::default()),
    }
}

pub fn api_key(key: &str, base_url: &str) -> Credential {
    Credential::ApiKey {
        key: key.to_owned(),
        base_url: Some(base_url.to_owned()),
    }
}

/// Every event of a reply, and the error that ended it if one did.
pub async fn run(
    provider: &dyn ModelProvider,
    request: ModelRequest,
) -> (Vec<ModelEvent>, Option<ProviderError>) {
    let mut stream = match provider.stream(request).await {
        Ok(stream) => stream,
        Err(error) => return (Vec::new(), Some(error)),
    };
    let mut events = Vec::new();
    while let Some(item) = stream.next().await {
        match item {
            Ok(event) => events.push(event),
            Err(error) => {
                assert!(stream.next().await.is_none(), "an error ends the stream");
                return (events, Some(error));
            }
        }
    }
    (events, None)
}

/// The blocks a reply finished with, in order.
pub fn finished_blocks(events: &[ModelEvent]) -> Vec<AssistantBlock> {
    events
        .iter()
        .filter_map(|event| match event {
            ModelEvent::BlockFinished { block, .. } => Some(block.clone()),
            _ => None,
        })
        .collect()
}
