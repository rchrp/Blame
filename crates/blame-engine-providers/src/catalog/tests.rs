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
