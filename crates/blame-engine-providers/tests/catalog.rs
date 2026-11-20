//! The providers and models offered to the user.

use blame_engine_protocol::ReasoningEffort;
use blame_engine_providers::ProviderKind;
use blame_engine_providers::catalog::{self, AuthKind, ProviderInfo};

fn provider(id: &str) -> ProviderInfo {
    catalog::providers()
        .into_iter()
        .find(|provider| provider.id == id)
        .unwrap_or_else(|| panic!("no provider {id}"))
}

#[test]
fn every_provider_connect_serves_is_listed() {
    let ids: Vec<&str> = catalog::providers()
        .iter()
        .map(|provider| provider.id)
        .collect();
    assert_eq!(ids, ProviderKind::ALL.map(ProviderKind::id));
    for provider in catalog::providers() {
        println!("{}: {} models", provider.id, provider.models.len());
    }
}

#[test]
fn a_model_says_what_the_loop_and_the_ui_need() {
    let anthropic = provider("anthropic");
    assert_eq!(anthropic.auth, AuthKind::ApiKey);
    let sonnet = anthropic
        .models
        .iter()
        .find(|model| model.id == "claude-sonnet-4-6")
        .expect("claude-sonnet-4-6");
    assert!(
        sonnet
            .context_window
            .is_some_and(|tokens| tokens >= 200_000)
    );
    assert!(sonnet.max_output_tokens.is_some());
    assert!(sonnet.images && sonnet.pdf);
    assert!(sonnet.reasoning.supported);
    assert!(sonnet.reasoning.efforts.contains(&ReasoningEffort::High));
    let price = sonnet.price.expect("priced");
    // $3 in and $15 out per million tokens, in micro-USD per million.
    assert_eq!((price.input, price.output), (3_000_000, 15_000_000));
    assert!(price.cache_read.is_some() && price.cache_write.is_some());
    // A dated snapshot is not offered beside the model it pins.
    assert!(
        anthropic
            .models
            .iter()
            .any(|model| model.id == "claude-haiku-4-5")
    );
    assert!(
        !anthropic
            .models
            .iter()
            .any(|model| model.id == "claude-haiku-4-5-20251001")
    );
}

#[test]
fn subscriptions_and_servers_have_no_price() {
    let chatgpt = provider("chatgpt");
    assert_eq!(chatgpt.auth, AuthKind::Subscription);
    assert!(!chatgpt.models.is_empty());
    assert!(chatgpt.models.iter().all(|model| model.price.is_none()));
    let bridge = provider("claude-code");
    assert!(bridge.needs_base_url);
    assert!(bridge.models.iter().all(|model| model.price.is_none()));
    let compatible = provider("openai-compatible");
    assert!(compatible.needs_base_url && compatible.models.is_empty());
    assert_eq!(compatible.auth, AuthKind::Optional);
    // Only agents' models: every one listed takes tools.
    assert!(
        provider("openai")
            .models
            .iter()
            .all(|model| !model.id.starts_with("dall-e"))
    );
}

#[test]
fn the_catalog_serializes_for_the_client() {
    let json = serde_json::to_value(catalog::providers()).expect("json");
    let gemini = json
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
