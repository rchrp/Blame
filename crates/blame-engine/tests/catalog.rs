//! The catalog through the engine: `catalog/list` refreshes from a
//! models.dev stand-in, a model only that copy knows is used as listed, and
//! one the provider refuses fails the turn with a message that names it,
//! after which the same conversation goes on with another model.

mod common;

use blame_engine_protocol::catalog::{CatalogSource, ModelCatalog};
use blame_engine_protocol::rpc::ClientRequest;
use blame_engine_protocol::{ErrorKind, ModelRef, RecordBody, TurnOutcome};
use blame_engine_providers::testing::{Body, Reply};
use common::*;
use serde_json::{Value, json};
use std::sync::Arc;

const BRAND_NEW: &str = "claude-brand-new-1";

/// models.dev's `api.json` listing one Anthropic model nobody has heard of.
fn models_dev() -> Reply {
    let data = json!({
        "anthropic": {"id": "anthropic", "name": "Anthropic", "models": {
            BRAND_NEW: {
                "id": BRAND_NEW, "name": "Claude Brand New 1",
                "attachment": true, "reasoning": true, "tool_call": true,
                "release_date": "2026-11-20", "last_updated": "2026-11-20",
                "modalities": {"input": ["text", "image", "pdf"], "output": ["text"]},
                "limit": {"context": 2000000, "output": 64000},
                "cost": {"input": 10, "output": 40}
            },
            MODEL: {
                "id": MODEL, "name": "Claude Sonnet 4.6",
                "attachment": true, "reasoning": true, "tool_call": true,
                "release_date": "2026-02-17", "last_updated": "2026-02-17",
                "modalities": {"input": ["text", "image", "pdf"], "output": ["text"]},
                "limit": {"context": 1000000, "output": 128000},
                "cost": {"input": 3, "output": 15}
            }
        }},
        "some-provider-the-engine-does-not-serve": {"models": {}}
    });
    Reply {
        status: 200,
        headers: vec![("etag".into(), "\"v1\"".into())],
        body: Body::Whole(data.to_string()),
    }
}

fn failure(records: &[blame_engine_protocol::Record]) -> Option<(ErrorKind, String)> {
    records.iter().find_map(|record| match &record.body {
        RecordBody::TurnEnded {
            outcome: TurnOutcome::Failed { error },
            ..
        } => Some((error.kind, error.message.clone())),
        _ => None,
    })
}

#[tokio::test]
async fn a_model_published_upstream_is_listed_used_and_when_refused_replaced() {
    let catalog = mock(vec![models_dev()]).await;
    let provider = mock(vec![
        text_reply(&["Hello from the new model."]),
        Reply::json(
            404,
            json!({"type": "error", "error": {"type": "not_found_error", "message": format!("model: {BRAND_NEW}")}}),
        ),
        text_reply(&["Hello from Sonnet."]),
    ])
    .await;
    let client = Arc::new(FakeClient::new(&provider.base));
    let data_dir = temp_dir("catalog");
    let url = format!("{}/api.json", catalog.base);
    let engine = Engine::ready(&data_dir, &["--catalog-url", &url], client).await;

    // Listed once the client asks for a fresh copy.
    let listing: ModelCatalog = engine
        .call(ClientRequest::CatalogList { refresh: true })
        .await;
    assert_eq!(listing.source, CatalogSource::ModelsDev, "{listing:?}");
    assert_eq!(listing.refresh_error, None);
    let anthropic = listing
        .providers
        .iter()
        .find(|provider| provider.id == "anthropic")
        .expect("anthropic");
    let new = anthropic
        .models
        .iter()
        .find(|model| model.id == BRAND_NEW)
        .expect("the new model is listed");
    assert_eq!(new.max_output_tokens, Some(64_000));
    // The engine asked models.dev, and kept the copy for the next start.
    assert!(data_dir.join("catalog/models-dev.json").exists());
    assert!(!catalog.requests().is_empty());

    // Selected and used: the provider gets the id as listed.
    let workspace = temp_dir("catalog-workspace");
    let mut config = config(&workspace);
    config.model = ModelRef {
        provider: "anthropic".into(),
        model: BRAND_NEW.into(),
    };
    config.max_output_tokens = None;
    let session = engine.create(config.clone()).await;
    engine.subscribe(&session, 0).await;
    engine.send(&session, "hi").await;
    let records = records_of(&engine.until_turn_ended().await);
    assert_eq!(failure(&records), None, "{records:#?}");
    let first = &provider.requests()[0].body;
    assert_eq!(first["model"], BRAND_NEW);
    assert_eq!(first["max_tokens"], 64_000, "models.dev's output limit");

    // Refused next time (withdrawn, or not on this account): the turn
    // fails with what the person needs to know.
    engine.send(&session, "again").await;
    let records = records_of(&engine.until_turn_ended().await);
    let (kind, message) = failure(&records).expect("the turn failed");
    assert_eq!(kind, ErrorKind::ModelUnavailable);
    assert_eq!(
        message,
        format!(
            "Anthropic does not offer the model `{BRAND_NEW}`. It answered: \"model: {BRAND_NEW} (HTTP 404)\". \
             Choose another model and send your message again."
        )
    );
    // Not retried: another try would be refused the same way.
    assert_eq!(provider.requests().len(), 2);

    // Another model, the same conversation.
    config.model.model = MODEL.into();
    engine
        .call::<Value>(ClientRequest::Configure {
            session: session.clone(),
            config,
        })
        .await;
    engine.send(&session, "and now?").await;
    let records = records_of(&engine.until_turn_ended().await);
    assert_eq!(failure(&records), None, "{records:#?}");
    let last = &provider.requests()[2].body;
    assert_eq!(last["model"], MODEL);
    let said: Vec<String> = last["messages"]
        .as_array()
        .expect("messages")
        .iter()
        .map(|message| message.to_string())
        .collect();
    assert!(
        said.iter()
            .any(|message| message.contains("Hello from the new model.")),
        "{said:#?}"
    );
    assert!(
        said.iter().any(|message| message.contains("and now?")),
        "{said:#?}"
    );
    assert!(engine.shutdown().await.success());
}

#[tokio::test]
async fn the_catalog_answers_offline_from_the_snapshot() {
    let client = Arc::new(FakeClient::new("http://127.0.0.1:9"));
    let engine = Engine::ready(&temp_dir("catalog-offline"), &[], client).await;
    let listing: ModelCatalog = engine
        .call(ClientRequest::CatalogList { refresh: true })
        .await;
    assert_eq!(listing.source, CatalogSource::Snapshot);
    assert!(
        listing
            .refresh_error
            .is_some_and(|error| error.contains("models.dev"))
    );
    assert!(
        listing
            .providers
            .iter()
            .any(|provider| provider.id == "anthropic" && !provider.models.is_empty())
    );
    assert!(engine.shutdown().await.success());
}
