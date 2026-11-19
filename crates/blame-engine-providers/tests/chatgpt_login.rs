//! The ChatGPT sign-in against a local stand-in for OpenAI's auth server,
//! with the test playing the browser.

mod support;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use blame_engine_protocol::rpc::Credential;
use blame_engine_providers::chatgpt::{self, LoginConfig, LoginError, Tokens};
use rig_reqwest::reqwest;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::time::Duration;
use support::*;

/// An unsigned JWT with `claims`: the sign-in only reads them.
fn jwt(claims: Value) -> String {
    let part = |value: Value| URL_SAFE_NO_PAD.encode(value.to_string());
    format!("{}.{}.sig", part(json!({"alg": "none"})), part(claims))
}

fn access_token() -> String {
    jwt(
        json!({"exp": 4_102_444_800_u64, "https://api.openai.com/auth": {"chatgpt_account_id": "acct_9"}}),
    )
}

fn config(mock: &Mock) -> LoginConfig {
    LoginConfig {
        auth_base: mock.base.clone(),
        callback_ports: vec![0],
        ..LoginConfig::default()
    }
}

fn query(url: &str) -> HashMap<String, String> {
    let (_, query) = url.split_once('?').expect("query");
    url::form_urlencoded::parse(query.as_bytes())
        .into_owned()
        .collect()
}

fn form(recorded: &Recorded) -> HashMap<String, String> {
    let Value::String(body) = &recorded.body else {
        panic!("a form body: {recorded:?}");
    };
    url::form_urlencoded::parse(body.as_bytes())
        .into_owned()
        .collect()
}

#[tokio::test]
async fn the_browser_sign_in_exchanges_its_code_with_pkce() {
    let mock = Mock::start(vec![Reply::json(
        200,
        json!({
            "access_token": access_token(), "refresh_token": "refresh-1",
            "id_token": jwt(json!({"email": "user@example.com"})),
        }),
    )])
    .await;
    let login = chatgpt::start_browser_login(&config(&mock))
        .await
        .expect("listening");
    let asked = query(login.authorize_url());
    assert!(
        login
            .authorize_url()
            .starts_with(&format!("{}/oauth/authorize?", mock.base))
    );
    assert_eq!(asked["client_id"], "app_EMoamEEZ73f0CkXaXp7hrann");
    assert_eq!(asked["response_type"], "code");
    assert_eq!(asked["code_challenge_method"], "S256");
    assert_eq!(asked["originator"], "blame");
    assert!(asked["scope"].contains("offline_access"));
    let redirect = asked["redirect_uri"].clone();
    let state = asked["state"].clone();
    let finished = tokio::spawn(login.finish());

    let browser = reqwest::Client::new();
    // A stale tab with another state is turned away; the sign-in waits on.
    let stale = browser
        .get(format!("{redirect}?code=old&state=other"))
        .send()
        .await
        .expect("stale");
    assert_eq!(stale.status(), 400);
    let page = browser
        .get(format!("{redirect}?code=the-code&state={state}"))
        .send()
        .await
        .expect("callback");
    assert_eq!(page.status(), 200);
    assert!(page.text().await.expect("page").contains("Signed in"));

    let tokens: Tokens = finished.await.expect("joined").expect("tokens");
    assert_eq!(tokens.access_token, access_token());
    assert_eq!(tokens.refresh_token.as_deref(), Some("refresh-1"));
    assert_eq!(tokens.account_id.as_deref(), Some("acct_9"));
    assert_eq!(tokens.expires_at_s, Some(4_102_444_800));
    assert!(!tokens.expires_within(Duration::from_secs(60)));
    assert_eq!(
        tokens.credential(),
        Credential::Bearer {
            token: access_token(),
            account: Some("acct_9".into()),
            base_url: None
        }
    );
    assert!(
        !format!("{tokens:?}").contains(&tokens.access_token),
        "Debug hides the tokens"
    );

    let exchange = mock.only_request();
    assert_eq!(exchange.target, "/oauth/token");
    let sent = form(&exchange);
    assert_eq!(sent["grant_type"], "authorization_code");
    assert_eq!(sent["code"], "the-code");
    assert_eq!(sent["redirect_uri"], redirect);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(sent["code_verifier"].as_bytes()));
    assert_eq!(
        challenge, asked["code_challenge"],
        "the verifier answers the challenge"
    );
}

#[tokio::test]
async fn a_refused_sign_in_says_why() {
    let mock = Mock::start(vec![]).await;
    let login = chatgpt::start_browser_login(&config(&mock))
        .await
        .expect("listening");
    let asked = query(login.authorize_url());
    let finished = tokio::spawn(login.finish());
    let url = format!(
        "{}?error=access_denied&error_description=The+user+said+no&state={}",
        asked["redirect_uri"], asked["state"]
    );
    reqwest::get(url).await.expect("callback");
    let error = finished.await.expect("joined").expect_err("refused");
    assert!(
        matches!(&error, LoginError::Denied(reason) if reason.contains("access_denied")),
        "{error}"
    );
    assert!(mock.requests().is_empty(), "nothing to exchange");
}

#[tokio::test]
async fn refreshing_keeps_the_refresh_token_unless_it_rotates() {
    let mock = Mock::start(vec![
        Reply::json(200, json!({"access_token": access_token()})),
        Reply::json(
            200,
            json!({"access_token": access_token(), "refresh_token": "refresh-2"}),
        ),
        Reply::json(
            400,
            json!({"error": "invalid_grant", "error_description": "Refresh token reused"}),
        ),
    ])
    .await;
    let config = config(&mock);
    let kept = chatgpt::refresh(&config, "refresh-1")
        .await
        .expect("refreshed");
    assert_eq!(kept.refresh_token.as_deref(), Some("refresh-1"));
    assert_eq!(kept.account_id.as_deref(), Some("acct_9"));
    let rotated = chatgpt::refresh(&config, "refresh-1")
        .await
        .expect("refreshed");
    assert_eq!(rotated.refresh_token.as_deref(), Some("refresh-2"));
    let spent = chatgpt::refresh(&config, "refresh-1")
        .await
        .expect_err("spent");
    assert!(matches!(spent, LoginError::Reauthenticate), "{spent}");

    let sent = form(&mock.requests()[0]);
    assert_eq!(sent["grant_type"], "refresh_token");
    assert_eq!(sent["refresh_token"], "refresh-1");
}

#[tokio::test]
async fn the_device_code_sign_in_polls_until_the_code_is_entered() {
    let mock = Mock::start(vec![
        Reply::json(
            200,
            json!({"device_auth_id": "dev-1", "user_code": "ABCD-EFGH", "interval": "1"}),
        ),
        Reply::json(404, json!({"error": "authorization_pending"})),
        Reply::json(
            200,
            json!({"authorization_code": "device-code", "code_verifier": "device-verifier"}),
        ),
        Reply::json(
            200,
            json!({"access_token": access_token(), "refresh_token": "refresh-1"}),
        ),
    ])
    .await;
    let login = chatgpt::start_device_login(&config(&mock))
        .await
        .expect("code");
    assert_eq!(login.user_code(), "ABCD-EFGH");
    assert_eq!(
        login.verification_uri(),
        format!("{}/codex/device", mock.base)
    );
    let tokens = tokio::time::timeout(Duration::from_secs(10), login.finish())
        .await
        .expect("in time")
        .expect("tokens");
    assert_eq!(tokens.refresh_token.as_deref(), Some("refresh-1"));

    let requests = mock.requests();
    assert_eq!(requests[1].target, "/api/accounts/deviceauth/token");
    assert_eq!(
        requests[1].body,
        json!({"device_auth_id": "dev-1", "user_code": "ABCD-EFGH"})
    );
    let exchange = form(&requests[3]);
    assert_eq!(exchange["code"], "device-code");
    assert_eq!(exchange["code_verifier"], "device-verifier");
    assert_eq!(
        exchange["redirect_uri"],
        format!("{}/deviceauth/callback", mock.base)
    );
}
