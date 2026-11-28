use super::*;

#[test]
fn the_compiled_snapshot_reads_whole() {
    let snapshot = Catalog::snapshot();
    assert!(snapshot.loose.is_empty(), "{:?}", snapshot.loose);
    for key in MODELS_DEV_KEYS {
        let vendor = if key == "google" { "gcp.gemini" } else { key };
        assert!(
            snapshot.data_specs(vendor).count() > 0,
            "{key} in the snapshot"
        );
    }
}

#[test]
fn a_subscription_takes_its_vendor_s_facts_for_a_model_rig_does_not_list() {
    let data = r#"{"openai": {"models": {"gpt-brand-new": {
        "name": "GPT Brand New", "tool_call": true, "reasoning": true,
        "reasoning_options": [{"type": "effort", "values": ["low", "high"]}],
        "modalities": {"input": ["text"]}, "limit": {"context": 500000, "output": 50000}
    }}}}"#;
    let catalog = Catalog::read(data, Meta::default(), CatalogSource::ModelsDev).expect("reads");
    let spec = catalog
        .spec(ProviderKind::ChatGpt, "chatgpt", "gpt-brand-new")
        .expect("openai's row");
    assert_eq!(spec.provider.vendor(), "chatgpt");
    assert_eq!(spec.max_output_tokens, Some(50_000));
    assert!(
        catalog
            .spec(ProviderKind::OpenAi, "openai", "gpt-unlisted")
            .is_none()
    );
}

#[test]
fn a_model_reads_images_as_its_provider_lists_it() {
    let model = |provider: &str, model: &str| ModelRef {
        provider: provider.into(),
        model: model.into(),
    };
    let snapshot = Catalog::snapshot();
    // Claude Code serves Anthropic's models, which read images.
    assert!(snapshot.reads_images(&model("claude-code", "claude-sonnet-4-6")));
    assert!(snapshot.reads_images(&model("anthropic", "claude-sonnet-4-6")));
    assert!(snapshot.reads_images(&model("anthropic", "claude-haiku-4-5-20251001")));
    assert!(!snapshot.reads_images(&model("anthropic", "claude-unlisted")));
    assert!(!snapshot.reads_images(&model("nowhere", "claude-sonnet-4-6")));

    let data = r#"{"openai": {"models": {"gpt-text-only": {
        "name": "GPT Text Only", "tool_call": true,
        "modalities": {"input": ["text"]}, "limit": {"context": 500000, "output": 50000}
    }}}}"#;
    let catalog = Catalog::read(data, Meta::default(), CatalogSource::ModelsDev).expect("reads");
    assert!(!catalog.reads_images(&model("openai", "gpt-text-only")));
}
