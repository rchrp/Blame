//! The catalog kept fresh from models.dev: conditional requests, the copy
//! kept on disk, failed refreshes, offline starts, and a model published
//! upstream reaching the wire.

mod support;

use blame_engine_core::ports::ModelEvent;
use blame_engine_protocol::ErrorKind;
use blame_engine_protocol::catalog::CatalogSource;
use blame_engine_providers::catalog::live::Refreshed;
use blame_engine_providers::catalog::{Catalog, LiveCatalog, RefreshOptions};
use blame_engine_providers::testing::Body;
use blame_engine_providers::{Options, connect};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use support::*;

const RECORDED: &str = include_str!("fixtures/models-dev-api.json");

/// `api.json` as models.dev sends it, with `ETag` `etag`.
fn models_dev(body: &str, etag: &str) -> Reply {
    Reply {
        status: 200,
        headers: vec![
            ("content-type".into(), "application/json".into()),
            ("etag".into(), etag.into()),
        ],
        body: Body::Whole(body.to_owned()),
    }
}

fn not_modified() -> Reply {
    Reply {
        status: 304,
        headers: Vec::new(),
        body: Body::Whole(String::new()),
    }
}

/// The recorded file with one more Anthropic model, published upstream
/// after the engine started.
fn with_new_model() -> String {
    let mut data: Value = serde_json::from_str(RECORDED).expect("fixture");
    data["anthropic"]["models"]["claude-brand-new-1"] = json!({
        "id": "claude-brand-new-1", "name": "Claude Brand New 1",
        "attachment": true, "reasoning": true, "tool_call": true,
        "reasoning_options": [{"type": "effort", "values": ["low", "medium", "high", "max"]}],
        "release_date": "2026-11-20", "last_updated": "2026-11-20",
        "modalities": {"input": ["text", "image", "pdf"], "output": ["text"]},
        "limit": {"context": 2000000, "output": 77777},
        "cost": {"input": 10, "output": 40}
    });
    data.to_string()
}

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("blame-catalog-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn options(mock: &Mock) -> RefreshOptions {
    RefreshOptions {
        url: format!("{}/api.json", mock.base),
        min_interval: Duration::ZERO,
        ..RefreshOptions::default()
    }
}

fn listed(catalog: &LiveCatalog, provider: &str, model: &str) -> bool {
    catalog
        .listing()
        .providers
        .iter()
        .any(|p| p.id == provider && p.models.iter().any(|m| m.id == model))
}

#[tokio::test]
async fn a_refresh_is_a_conditional_request_whose_copy_is_kept_on_disk() {
    let mock = Mock::start(vec![
        models_dev(RECORDED, "\"v1\""),
        not_modified(),
        models_dev(&with_new_model(), "\"v2\""),
    ])
    .await;
    let dir = temp_dir("kept");
    let live = LiveCatalog::open(Some(dir.clone()), options(&mock));
    assert_eq!(live.current().source(), CatalogSource::Snapshot);
    assert!(live.is_stale(), "never checked");

    assert_eq!(live.refresh(false).await, Ok(Refreshed::Updated));
    assert_eq!(live.current().source(), CatalogSource::ModelsDev);
    assert_eq!(live.current().meta().etag.as_deref(), Some("\"v1\""));
    assert!(!live.is_stale());
    // Only the served providers are kept.
    let kept = std::fs::read_to_string(dir.join("models-dev.json")).expect("kept");
    assert!(kept.contains("claude-sonnet-4-6") && !kept.contains("deepseek"));

    // The first request revalidated the snapshot's own copy; the second
    // the fetched one. Nothing else is sent: no cookie, no key, nothing
    // about the user.
    assert_eq!(live.refresh(true).await, Ok(Refreshed::Unchanged));
    let requests = mock.requests();
    let snapshot_etag = Catalog::snapshot().meta().etag.clone();
    assert_eq!(
        requests[0].header("if-none-match"),
        snapshot_etag.as_deref()
    );
    assert_eq!(requests[1].header("if-none-match"), Some("\"v1\""));
    for request in &requests {
        assert_eq!(request.method, "GET");
        assert_eq!(request.target, "/api.json");
        let mut names: Vec<&str> = request.headers.keys().map(String::as_str).collect();
        names.sort_unstable();
        assert_eq!(
            names,
            [
                "accept",
                "accept-encoding",
                "host",
                "if-none-match",
                "user-agent"
            ],
            "{request:?}"
        );
        assert!(
            request
                .header("user-agent")
                .is_some_and(|agent| agent.starts_with("blame-engine/"))
        );
    }

    // A model published upstream is listed after the next refresh.
    assert!(!listed(&live, "anthropic", "claude-brand-new-1"));
    assert_eq!(live.refresh(true).await, Ok(Refreshed::Updated));
    assert!(listed(&live, "anthropic", "claude-brand-new-1"));
    assert!(listed(&live, "claude-code", "claude-brand-new-1"));

    // The next start reads the kept copy, offline.
    let offline = RefreshOptions {
        url: "http://127.0.0.1:9/api.json".into(),
        ..RefreshOptions::default()
    };
    let restarted = LiveCatalog::open(Some(dir.clone()), offline);
    assert_eq!(restarted.current().source(), CatalogSource::ModelsDev);
    assert!(listed(&restarted, "anthropic", "claude-brand-new-1"));
    assert!(restarted.refresh(true).await.is_err());
    assert!(listed(&restarted, "anthropic", "claude-brand-new-1"));
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_failed_refresh_keeps_the_last_copy_and_says_why() {
    let mock = Mock::start(vec![
        models_dev(&with_new_model(), "\"v1\""),
        Reply::json(503, json!({"error": "down"})),
        models_dev("<html>maintenance</html>", "\"v2\""),
        models_dev(r#"{"some-other-provider": {"models": {}}}"#, "\"v3\""),
        Reply {
            status: 200,
            headers: vec![("content-length".into(), "100000".into())],
            body: Body::Cut("{\"anthropic\": {\"models\": {".into()),
        },
    ])
    .await;
    let live = LiveCatalog::open(None, options(&mock));
    assert_eq!(live.refresh(false).await, Ok(Refreshed::Updated));
    for _ in 0..4 {
        let error = live.refresh(true).await.expect_err("fails");
        assert!(error.contains("models.dev"), "{error}");
        assert!(
            listed(&live, "anthropic", "claude-brand-new-1"),
            "kept after: {error}"
        );
        assert_eq!(live.current().meta().etag.as_deref(), Some("\"v1\""));
        assert_eq!(
            live.listing().refresh_error.as_deref(),
            Some(error.as_str())
        );
    }
}

#[tokio::test]
async fn an_offline_first_start_lists_the_snapshot() {
    let dir = temp_dir("offline");
    let live = LiveCatalog::open(
        Some(dir.clone()),
        RefreshOptions {
            url: "http://127.0.0.1:9/api.json".into(),
            ..RefreshOptions::default()
        },
    );
    assert_eq!(live.current().source(), CatalogSource::Snapshot);
    let error = live.refresh(false).await.expect_err("offline");
    assert!(error.contains("did not answer"), "{error}");
    let listing = live.listing();
    assert_eq!(listing.source, CatalogSource::Snapshot);
    assert!(
        listing
            .providers
            .iter()
            .any(|p| p.id == "anthropic" && !p.models.is_empty())
    );
    assert!(!dir.exists(), "nothing written");
}

#[tokio::test]
async fn a_kept_copy_older_than_the_snapshot_is_ignored() {
    let dir = temp_dir("older");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("models-dev.json"), with_new_model()).unwrap();
    std::fs::write(
        dir.join("models-dev.meta.json"),
        r#"{"fetched_at_ms": 1, "etag": "\"old\""}"#,
    )
    .unwrap();
    let live = LiveCatalog::open(Some(dir.clone()), RefreshOptions::default());
    assert_eq!(live.current().source(), CatalogSource::Snapshot);
    // A corrupt copy is ignored too.
    std::fs::write(dir.join("models-dev.meta.json"), "not json").unwrap();
    let live = LiveCatalog::open(Some(dir.clone()), RefreshOptions::default());
    assert_eq!(live.current().source(), CatalogSource::Snapshot);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn refreshes_close_together_send_one_request() {
    let mock = Mock::start(vec![models_dev(RECORDED, "\"v1\""), not_modified()]).await;
    let live = Arc::new(LiveCatalog::open(
        None,
        RefreshOptions {
            min_interval: Duration::from_secs(60),
            ..options(&mock)
        },
    ));
    let (a, b) = tokio::join!(live.refresh(false), live.refresh(false));
    assert_eq!(a, Ok(Refreshed::Updated));
    assert_eq!(b, Ok(Refreshed::Skipped));
    assert_eq!(live.refresh(false).await, Ok(Refreshed::Skipped));
    assert_eq!(mock.requests().len(), 1);
    // Fresh: a listing does not revalidate in the background.
    live.refresh_if_stale();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(mock.requests().len(), 1);
}

#[tokio::test]
async fn a_model_published_upstream_is_encoded_and_priced_with_its_facts() {
    let catalog_server = Mock::start(vec![models_dev(&with_new_model(), "\"v1\"")]).await;
    let live = Arc::new(LiveCatalog::open(None, options(&catalog_server)));
    let provider_server =
        Mock::start(vec![Reply::sse(&anthropic_reply("claude-brand-new-1"))]).await;
    let options = Options {
        catalog: live.clone(),
        ..Options::default()
    };
    // Connected before the refresh: the facts are read per request.
    let provider = connect(
        "anthropic",
        &api_key("sk-test", &provider_server.base),
        &options,
    )
    .expect("provider");
    assert_eq!(live.refresh(false).await, Ok(Refreshed::Updated));
    let mut request = request(model("anthropic", "claude-brand-new-1"), vec![user("hi")]);
    request.max_output_tokens = None;
    request.reasoning = Some(blame_engine_protocol::ReasoningEffort::Max);
    let (events, error) = run(&provider, request).await;
    assert!(error.is_none(), "{error:?}");
    let sent = provider_server.only_request();
    assert_eq!(sent.body["model"], "claude-brand-new-1");
    // models.dev's output limit, not a fallback.
    assert_eq!(sent.body["max_tokens"], 77_777);
    let Some(ModelEvent::Finished { usage, .. }) = events.last() else {
        panic!("{events:#?}")
    };
    // 20 tokens in at $10 and 5 out at $40 per million.
    assert_eq!(usage.cost_micro_usd, Some(400));
}

#[tokio::test]
async fn a_model_the_provider_refuses_fails_with_a_message_naming_it() {
    let server = Mock::start(vec![
        Reply::json(
            404,
            json!({"type": "error", "error": {"type": "not_found_error", "message": "model: claude-brand-new-1"}}),
        ),
        Reply::json(
            400,
            json!({"detail": "The 'gpt-brand-new' model is not supported when using Codex with a ChatGPT account."}),
        ),
    ])
    .await;
    let provider = connect(
        "anthropic",
        &api_key("sk-test", &server.base),
        &Options::default(),
    )
    .expect("provider");
    let (_, error) = run(
        &provider,
        request(model("anthropic", "claude-brand-new-1"), vec![user("hi")]),
    )
    .await;
    let error = error.expect("refused");
    assert_eq!(error.kind, ErrorKind::ModelUnavailable);
    assert!(
        error
            .message
            .starts_with("Anthropic does not offer the model `claude-brand-new-1`."),
        "{}",
        error.message
    );
    assert!(
        error
            .message
            .contains("model: claude-brand-new-1 (HTTP 404)"),
        "{}",
        error.message
    );
    assert!(
        error.message.contains("Choose another model"),
        "{}",
        error.message
    );

    let chatgpt = connect(
        "chatgpt",
        &blame_engine_protocol::rpc::Credential::Bearer {
            token: "t".into(),
            account: Some("acct".into()),
            base_url: Some(server.base.clone()),
        },
        &Options::default(),
    )
    .expect("provider");
    let (_, error) = run(
        &chatgpt,
        request(model("chatgpt", "gpt-brand-new"), vec![user("hi")]),
    )
    .await;
    let error = error.expect("refused");
    assert_eq!(error.kind, ErrorKind::ModelUnavailable);
    assert!(
        error
            .message
            .starts_with("ChatGPT does not offer the model `gpt-brand-new` with this plan."),
        "{}",
        error.message
    );
    assert!(
        error.message.contains("not supported when using Codex"),
        "{}",
        error.message
    );
}

fn anthropic_reply(model: &str) -> String {
    sse(&[
        (
            "message_start",
            json!({"type": "message_start", "message": {
                "id": "msg_1", "type": "message", "role": "assistant", "model": model,
                "content": [], "stop_reason": null, "stop_sequence": null,
                "usage": {"input_tokens": 20, "output_tokens": 1}}}),
        ),
        (
            "content_block_start",
            json!({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
        ),
        (
            "content_block_delta",
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Hi."}}),
        ),
        (
            "content_block_stop",
            json!({"type": "content_block_stop", "index": 0}),
        ),
        (
            "message_delta",
            json!({"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": null},
                   "usage": {"output_tokens": 5}}),
        ),
        ("message_stop", json!({"type": "message_stop"})),
    ])
}
