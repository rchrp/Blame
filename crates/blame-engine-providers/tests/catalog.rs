//! The providers and models offered to the user, read from models.dev.

use blame_engine_protocol::ReasoningEffort;
use blame_engine_protocol::catalog::{CatalogSource, ModelInfo};
use blame_engine_providers::ProviderKind;
use blame_engine_providers::catalog::{self, AuthKind, Catalog, Meta, ProviderInfo};

/// Real rows of models.dev's `api.json`, recorded on 2026-11-20: a few
/// models of each served provider and one provider the engine does not
/// serve.
const RECORDED: &str = include_str!("fixtures/models-dev-api.json");

fn recorded() -> Catalog {
    Catalog::read(RECORDED, Meta::default(), CatalogSource::ModelsDev).expect("reads")
}

fn provider(catalog: &Catalog, id: &str) -> ProviderInfo {
    catalog.provider(ProviderKind::from_id(id).expect("served"))
}

fn model<'a>(provider: &'a ProviderInfo, id: &str) -> &'a ModelInfo {
    provider
        .models
        .iter()
        .find(|model| model.id == id)
        .unwrap_or_else(|| panic!("{} lists no {id}", provider.id))
}

fn ids(provider: &ProviderInfo) -> Vec<&str> {
    provider
        .models
        .iter()
        .map(|model| model.id.as_str())
        .collect()
}

#[test]
fn every_provider_connect_serves_is_listed_from_the_snapshot() {
    let providers = catalog::providers();
    let listed: Vec<&str> = providers
        .iter()
        .map(|provider| provider.id.as_str())
        .collect();
    assert_eq!(listed, ProviderKind::ALL.map(ProviderKind::id));
    let snapshot = Catalog::snapshot();
    assert_eq!(snapshot.source(), CatalogSource::Snapshot);
    assert!(snapshot.meta().fetched_at_ms > 0 && snapshot.meta().etag.is_some());
    for provider in &providers {
        println!("{}: {} models", provider.id, provider.models.len());
        if provider.id != "openai-compatible" {
            assert!(!provider.models.is_empty(), "{} has models", provider.id);
        }
    }
}

#[test]
fn a_recorded_models_dev_file_reads_into_what_the_ui_and_the_loop_need() {
    let catalog = recorded();
    let anthropic = provider(&catalog, "anthropic");
    assert_eq!(anthropic.auth, AuthKind::ApiKey);
    assert_eq!(anthropic.sources, ["anthropic"]);
    let sonnet = model(&anthropic, "claude-sonnet-4-6");
    assert_eq!(sonnet.name, "Claude Sonnet 4.6");
    assert_eq!(sonnet.context_window, Some(1_000_000));
    assert_eq!(sonnet.max_output_tokens, Some(128_000));
    assert!(sonnet.images && sonnet.pdf);
    assert_eq!(sonnet.release_date.as_deref(), Some("2026-02-17"));
    assert!(sonnet.reasoning.supported);
    assert!(sonnet.reasoning.efforts.contains(&ReasoningEffort::Max));
    // $3 in and $15 out per million tokens, in micro-USD per million.
    let price = sonnet.price.expect("priced");
    assert_eq!((price.input, price.output), (3_000_000, 15_000_000));
    assert!(price.cache_read.is_some() && price.cache_write.is_some());
    // Opus 5.5 lists five levels, `max` among them.
    assert_eq!(
        model(&anthropic, "claude-opus-5-5").reasoning.efforts,
        [
            ReasoningEffort::Low,
            ReasoningEffort::Medium,
            ReasoningEffort::High,
            ReasoningEffort::Xhigh,
            ReasoningEffort::Max
        ]
    );
    // Haiku 4.5 thinks by budget: offered as levels the engine turns into
    // budgets.
    assert!(
        !model(&anthropic, "claude-haiku-4-5")
            .reasoning
            .efforts
            .is_empty()
    );
    // A dated snapshot is not offered beside the model it pins, and a
    // deprecated model not at all.
    let listed = ids(&anthropic);
    assert!(!listed.contains(&"claude-haiku-4-5-20251001"), "{listed:?}");
    assert!(!listed.contains(&"claude-sonnet-4-5"), "{listed:?}");
    // Newest first.
    assert_eq!(listed.first(), Some(&"claude-opus-5-5"));

    let openai = provider(&catalog, "openai");
    let gpt = model(&openai, "gpt-5.5");
    // `none` among its levels: reasoning can be turned off.
    assert!(gpt.reasoning.can_disable);
    assert_eq!(gpt.max_input_tokens, Some(922_000));
    // Not an agent's model: an embedding takes no tools.
    assert!(!ids(&openai).contains(&"text-embedding-3-small"));
    assert!(!ids(&openai).contains(&"gpt-4o-2024-08-06"));

    let gemini = provider(&catalog, "gemini");
    assert_eq!(gemini.sources, ["google"]);
    assert!(model(&gemini, "gemini-2.5-flash").reasoning.can_disable);
    assert_eq!(
        model(&gemini, "gemini-3.5-flash").reasoning.efforts[0],
        ReasoningEffort::Minimal
    );
    assert!(!ids(&provider(&catalog, "openrouter")).is_empty());
}

#[test]
fn subscriptions_list_their_vendor_s_models_without_a_price() {
    let catalog = recorded();
    let chatgpt = provider(&catalog, "chatgpt");
    assert_eq!(chatgpt.auth, AuthKind::Subscription);
    assert_eq!(chatgpt.sources, ["openai"]);
    assert_eq!(ids(&chatgpt), ids(&provider(&catalog, "openai")));
    assert!(chatgpt.models.iter().all(|model| model.price.is_none()));
    let bridge = provider(&catalog, "claude-code");
    assert!(bridge.needs_base_url);
    assert_eq!(ids(&bridge), ids(&provider(&catalog, "anthropic")));
    assert!(bridge.models.iter().all(|model| model.price.is_none()));
    let compatible = provider(&catalog, "openai-compatible");
    assert!(compatible.needs_base_url && compatible.models.is_empty());
    assert!(compatible.sources.is_empty());
    assert_eq!(compatible.auth, AuthKind::Optional);
}

#[test]
fn a_model_nobody_has_heard_of_is_offered_with_safe_defaults() {
    // A model added upstream minutes ago: unknown to Rig and to the
    // snapshot, with a field models.dev may add tomorrow. And one whose row
    // has a field in a shape nothing reads: it is still offered.
    let data = r#"{
      "anthropic": {"id": "anthropic", "brand_new_section_field": [1, 2], "models": {
        "claude-brand-new-1": {
          "id": "claude-brand-new-1", "name": "Claude Brand New 1",
          "attachment": true, "reasoning": true, "tool_call": true,
          "release_date": "2026-11-19", "last_updated": "2026-11-19",
          "modalities": {"input": ["text", "image"], "output": ["text"]},
          "limit": {"context": 2000000, "output": 200000},
          "cost": {"input": 7, "output": 21},
          "a_field_from_the_future": {"nested": true}
        },
        "claude-odd-shape": {
          "id": "claude-odd-shape", "name": "Claude Odd Shape",
          "tool_call": true, "reasoning": "sometimes",
          "modalities": {"input": ["text", "image/png"]},
          "limit": {"context": 300000},
          "release_date": "2026-11-18"
        },
        "claude-no-tools": {
          "id": "claude-no-tools", "name": "No tools", "tool_call": false,
          "reasoning": 3, "modalities": {"input": ["text"]}
        }
      }}
    }"#;
    let catalog = Catalog::read(data, Meta::default(), CatalogSource::ModelsDev).expect("reads");
    let anthropic = provider(&catalog, "anthropic");
    let new = model(&anthropic, "claude-brand-new-1");
    assert_eq!(new.context_window, Some(2_000_000));
    assert_eq!(new.max_output_tokens, Some(200_000));
    assert!(new.images && !new.pdf && new.reasoning.supported);
    assert_eq!(new.price.map(|price| price.input), Some(7_000_000));
    let odd = model(&anthropic, "claude-odd-shape");
    assert_eq!(odd.name, "Claude Odd Shape");
    assert_eq!(odd.context_window, Some(300_000));
    assert!(odd.images && odd.price.is_none());
    assert!(!ids(&anthropic).contains(&"claude-no-tools"));
    // The subscription that serves Anthropic's models offers it too.
    assert!(ids(&provider(&catalog, "claude-code")).contains(&"claude-brand-new-1"));
}

#[test]
fn what_is_not_a_catalog_does_not_read() {
    assert!(Catalog::read("[]", Meta::default(), CatalogSource::ModelsDev).is_err());
    assert!(Catalog::read("<html>", Meta::default(), CatalogSource::ModelsDev).is_err());
}

#[test]
fn the_listing_serializes_for_the_client() {
    let listing = recorded().listing(Some("models.dev did not answer".into()));
    let json = serde_json::to_value(&listing).expect("json");
    assert_eq!(json["source"], "models_dev");
    assert_eq!(json["refresh_error"], "models.dev did not answer");
    let gemini = json["providers"]
        .as_array()
        .expect("list")
        .iter()
        .find(|provider| provider["id"] == "gemini")
        .expect("gemini");
    assert_eq!(gemini["auth"], "api_key");
    assert!(
        gemini["models"]
            .as_array()
            .is_some_and(|models| !models.is_empty())
    );
}
