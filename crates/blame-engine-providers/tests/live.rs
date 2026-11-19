//! One real request per provider. Ignored by default: they need a key in
//! the environment and the network, and cost a few tokens.
//!
//! ```bash
//! ANTHROPIC_API_KEY=… cargo test -p blame-engine-providers --test live -- --ignored anthropic
//! ```
//!
//! Each reads its credential from `<PROVIDER>_API_KEY` (`CHATGPT_ACCESS_TOKEN`
//! and `CHATGPT_ACCOUNT_ID` for the subscription) and its model from
//! `BLAME_LIVE_<PROVIDER>_MODEL` when set.

mod support;

use blame_engine_core::ports::ModelEvent;
use blame_engine_protocol::rpc::Credential;
use blame_engine_providers::{Options, connect};
use support::*;

async fn live(provider: &str, credential: Credential, default_model: &str) {
    let variable = format!(
        "BLAME_LIVE_{}_MODEL",
        provider.to_ascii_uppercase().replace('-', "_")
    );
    let model_id = std::env::var(variable).unwrap_or_else(|_| default_model.to_owned());
    let connected = connect(provider, &credential, &Options::default()).expect("provider");
    let mut request = request(
        model(provider, &model_id),
        vec![user("Call get_weather for Paris.")],
    );
    request.max_output_tokens = Some(4_000);
    let (events, error) = run(&connected, request).await;
    assert!(error.is_none(), "{error:?}");
    println!("{:#?}", finished_blocks(&events));
    let Some(ModelEvent::Finished { stop, usage }) = events.last() else {
        panic!("{events:#?}");
    };
    println!("{stop:?} {usage:?}");
    assert!(usage.output_tokens.is_some_and(|tokens| tokens > 0));
}

fn key(name: &str) -> Credential {
    Credential::ApiKey {
        key: std::env::var(name).unwrap_or_else(|_| panic!("{name} is not set")),
        base_url: None,
    }
}

#[tokio::test]
#[ignore = "needs ANTHROPIC_API_KEY and the network"]
async fn anthropic() {
    live("anthropic", key("ANTHROPIC_API_KEY"), "claude-haiku-4-5").await;
}

#[tokio::test]
#[ignore = "needs OPENAI_API_KEY and the network"]
async fn openai() {
    live("openai", key("OPENAI_API_KEY"), "gpt-5.4-mini").await;
}

#[tokio::test]
#[ignore = "needs CHATGPT_ACCESS_TOKEN and the network"]
async fn chatgpt() {
    let credential = Credential::Bearer {
        token: std::env::var("CHATGPT_ACCESS_TOKEN").expect("CHATGPT_ACCESS_TOKEN"),
        account: std::env::var("CHATGPT_ACCOUNT_ID").ok(),
        base_url: None,
    };
    live("chatgpt", credential, "gpt-5.4").await;
}

#[tokio::test]
#[ignore = "needs GEMINI_API_KEY and the network"]
async fn gemini() {
    live("gemini", key("GEMINI_API_KEY"), "gemini-2.5-flash").await;
}

#[tokio::test]
#[ignore = "needs OPENROUTER_API_KEY and the network"]
async fn openrouter() {
    live(
        "openrouter",
        key("OPENROUTER_API_KEY"),
        "anthropic/claude-haiku-4.5",
    )
    .await;
}
