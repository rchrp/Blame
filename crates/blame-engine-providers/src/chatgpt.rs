//! Signing in to a ChatGPT subscription.
//!
//! The engine may run in a VM or in the cloud, but the sign-in needs the
//! user's browser, so it runs on the user's machine (the binary exposes
//! these functions as a subcommand) and the client hands the access token to
//! the engine as `Credential::Bearer`. Nothing here stores a token: the
//! caller keeps [`Tokens`] where it keeps secrets and calls [`refresh`]
//! before [`Tokens::expires_within`] says the access token runs out.
//!
//! This is OpenAI's public OAuth client for Codex (authorization code with
//! PKCE, returned to a listener on `127.0.0.1`), or its device-code flow
//! when no browser can reach that listener. Rig ships the same flow, but
//! only behind a token store it owns and with the endpoints fixed, so it can
//! neither hand tokens back nor be exercised without the network.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use blame_engine_protocol::rpc::Credential;
use rig_reqwest::reqwest;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// The `originator` the ChatGPT backend and the sign-in page are told.
pub const ORIGINATOR: &str = "blame";

const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const SCOPE: &str = "openid profile email offline_access";
const CALLBACK_PATH: &str = "/auth/callback";
const MAX_REQUEST_BYTES: usize = 16 * 1024;
const STREAM_TIMEOUT: Duration = Duration::from_secs(10);

/// Where and as whom to sign in. The defaults are OpenAI's; tests point
/// `auth_base` at a local server.
#[derive(Clone, Debug)]
pub struct LoginConfig {
    pub auth_base: String,
    pub client_id: String,
    pub originator: String,
    /// The callback ports registered for the client, tried in order. `0`
    /// takes any free port, which only a test server accepts.
    pub callback_ports: Vec<u16>,
}

impl Default for LoginConfig {
    fn default() -> Self {
        Self {
            auth_base: "https://auth.openai.com".to_owned(),
            client_id: CLIENT_ID.to_owned(),
            originator: ORIGINATOR.to_owned(),
            callback_ports: vec![1455, 1457],
        }
    }
}

/// What a sign-in or a refresh obtained. The caller stores it.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tokens {
    pub access_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id_token: Option<String>,
    /// The ChatGPT account the token acts for (`ChatGPT-Account-Id`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    /// When the access token expires, in seconds since the Unix epoch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at_s: Option<u64>,
}

impl std::fmt::Debug for Tokens {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Tokens")
            .field("account_id", &self.account_id)
            .field("expires_at_s", &self.expires_at_s)
            .finish_non_exhaustive()
    }
}

impl Tokens {
    /// The credential the engine's `chatgpt` provider takes.
    pub fn credential(&self) -> Credential {
        Credential::Bearer {
            token: self.access_token.clone(),
            account: self.account_id.clone(),
            base_url: None,
        }
    }

    /// Whether the access token expires within `margin` of now (or its
    /// expiry is unknown, when it is safer to refresh).
    pub fn expires_within(&self, margin: Duration) -> bool {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        self.expires_at_s
            .is_none_or(|expires| expires <= now.saturating_add(margin.as_secs()))
    }
}

#[derive(Debug, thiserror::Error)]
pub enum LoginError {
    /// Every callback port is taken: use [`start_device_login`] instead.
    #[error("the sign-in callback ports are in use")]
    PortsInUse,
    /// The user refused, or the provider rejected the sign-in.
    #[error("the sign-in failed: {0}")]
    Denied(String),
    /// The refresh token is no longer valid: the user must sign in again.
    #[error("the ChatGPT sign-in has expired; sign in again")]
    Reauthenticate,
    #[error("the sign-in request failed: {0}")]
    Http(String),
    #[error("the sign-in listener failed: {0}")]
    Io(#[from] std::io::Error),
}

/// A browser sign-in waiting for its callback. Show
/// [`authorize_url`](Self::authorize_url) (or open it), then await
/// [`finish`](Self::finish); dropping it closes the listener.
pub struct BrowserLogin {
    config: LoginConfig,
    listener: TcpListener,
    redirect_uri: String,
    state: String,
    verifier: String,
    authorize_url: String,
}

/// Opens the callback listener and builds the page the user signs in on.
pub async fn start_browser_login(config: &LoginConfig) -> Result<BrowserLogin, LoginError> {
    let mut bound = None;
    for &port in &config.callback_ports {
        match TcpListener::bind(("127.0.0.1", port)).await {
            Ok(listener) => {
                bound = Some(listener);
                break;
            }
            // Windows reports a reserved port as access denied.
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::AddrInUse | std::io::ErrorKind::PermissionDenied
                ) => {}
            Err(error) => return Err(error.into()),
        }
    }
    let listener = bound.ok_or(LoginError::PortsInUse)?;
    let port = listener.local_addr()?.port();
    let redirect_uri = format!("http://localhost:{port}{CALLBACK_PATH}");
    let verifier = random_token(64);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let state = random_token(32);
    let query = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs([
            ("response_type", "code"),
            ("client_id", config.client_id.as_str()),
            ("redirect_uri", redirect_uri.as_str()),
            ("scope", SCOPE),
            ("code_challenge", challenge.as_str()),
            ("code_challenge_method", "S256"),
            ("id_token_add_organizations", "true"),
            ("codex_cli_simplified_flow", "true"),
            ("state", state.as_str()),
            ("originator", config.originator.as_str()),
        ])
        .finish();
    let authorize_url = format!("{}/oauth/authorize?{query}", config.auth_base);
    Ok(BrowserLogin {
        config: config.clone(),
        listener,
        redirect_uri,
        state,
        verifier,
        authorize_url,
    })
}

impl BrowserLogin {
    pub fn authorize_url(&self) -> &str {
        &self.authorize_url
    }

    /// Waits for the browser to come back, exchanges its code for tokens
    /// and tells the browser how it went. Waits as long as it is awaited:
    /// the caller sets the deadline.
    pub async fn finish(self) -> Result<Tokens, LoginError> {
        loop {
            let (mut stream, _) = self.listener.accept().await?;
            // A stray request (a favicon, a stale tab) only loses itself.
            let Ok(line) = read_request_line(&mut stream).await else {
                continue;
            };
            match parse_callback(&line, &self.state) {
                Callback::Other => respond(&mut stream, "404 Not Found", "Not found.").await,
                Callback::StateMismatch => {
                    let body = page(
                        "Sign-in not recognised",
                        "Start the sign-in again from Blame.",
                    );
                    respond(&mut stream, "400 Bad Request", &body).await;
                }
                Callback::Failed(reason) => {
                    let body = page("Sign-in failed", &reason);
                    respond(&mut stream, "200 OK", &body).await;
                    return Err(LoginError::Denied(reason));
                }
                Callback::Code(code) => {
                    let exchanged = token_request(
                        &self.config,
                        &[
                            ("grant_type", "authorization_code"),
                            ("code", &code),
                            ("redirect_uri", &self.redirect_uri),
                            ("client_id", &self.config.client_id),
                            ("code_verifier", &self.verifier),
                        ],
                        None,
                    )
                    .await;
                    let body = match &exchanged {
                        Ok(_) => page(
                            "Signed in to ChatGPT",
                            "You can close this tab and return to Blame.",
                        ),
                        Err(error) => page("Sign-in failed", &error.to_string()),
                    };
                    respond(&mut stream, "200 OK", &body).await;
                    return exchanged;
                }
            }
        }
    }
}

/// A device-code sign-in: the user enters [`user_code`](Self::user_code)
/// at [`verification_uri`](Self::verification_uri), on any device.
pub struct DeviceLogin {
    config: LoginConfig,
    device_auth_id: String,
    user_code: String,
    interval: Duration,
}

pub async fn start_device_login(config: &LoginConfig) -> Result<DeviceLogin, LoginError> {
    let body = serde_json::json!({ "client_id": config.client_id }).to_string();
    let (status, reply) = post(
        &format!("{}/api/accounts/deviceauth/usercode", config.auth_base),
        "application/json",
        body,
    )
    .await?;
    if !status.is_success() {
        return Err(LoginError::Http(format!("{status}: {reply}")));
    }
    let reply: Value = parse(&reply)?;
    let field = |name: &str| reply.get(name).and_then(Value::as_str).map(str::to_owned);
    let interval = reply
        .get("interval")
        .and_then(|value| value.as_u64().or_else(|| value.as_str()?.parse().ok()))
        .unwrap_or(5);
    Ok(DeviceLogin {
        config: config.clone(),
        device_auth_id: field("device_auth_id")
            .ok_or_else(|| LoginError::Http("the device code reply has no id".into()))?,
        user_code: field("user_code")
            .or_else(|| field("usercode"))
            .ok_or_else(|| LoginError::Http("the device code reply has no code".into()))?,
        interval: Duration::from_secs(interval.max(1)),
    })
}

impl DeviceLogin {
    pub fn verification_uri(&self) -> String {
        format!("{}/codex/device", self.config.auth_base)
    }

    pub fn user_code(&self) -> &str {
        &self.user_code
    }

    /// Polls until the user has entered the code, then exchanges it. Polls
    /// as long as it is awaited: the caller sets the deadline.
    pub async fn finish(self) -> Result<Tokens, LoginError> {
        let body = serde_json::json!({
            "device_auth_id": self.device_auth_id,
            "user_code": self.user_code,
        })
        .to_string();
        let url = format!("{}/api/accounts/deviceauth/token", self.config.auth_base);
        let granted = loop {
            let (status, reply) = post(&url, "application/json", body.clone()).await?;
            match status.as_u16() {
                200..=299 => break parse::<Value>(&reply)?,
                // Pending until the user has entered the code.
                403 | 404 => tokio::time::sleep(self.interval).await,
                _ => return Err(LoginError::Denied(format!("{status}: {reply}"))),
            }
        };
        let field = |name: &str| {
            granted
                .get(name)
                .and_then(Value::as_str)
                .ok_or_else(|| LoginError::Http(format!("the device grant has no {name}")))
        };
        let redirect_uri = format!("{}/deviceauth/callback", self.config.auth_base);
        token_request(
            &self.config,
            &[
                ("grant_type", "authorization_code"),
                ("code", field("authorization_code")?),
                ("redirect_uri", &redirect_uri),
                ("client_id", &self.config.client_id),
                ("code_verifier", field("code_verifier")?),
            ],
            None,
        )
        .await
    }
}

/// New tokens for `refresh_token`. [`LoginError::Reauthenticate`] when it
/// is spent or revoked. The refresh token may rotate: keep the one returned.
pub async fn refresh(config: &LoginConfig, refresh_token: &str) -> Result<Tokens, LoginError> {
    token_request(
        config,
        &[
            ("client_id", &config.client_id),
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("scope", "openid profile email"),
        ],
        Some(refresh_token),
    )
    .await
}

async fn token_request(
    config: &LoginConfig,
    form: &[(&str, &str)],
    refreshing: Option<&str>,
) -> Result<Tokens, LoginError> {
    let body = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(form)
        .finish();
    let (status, reply) = post(
        &format!("{}/oauth/token", config.auth_base),
        "application/x-www-form-urlencoded",
        body,
    )
    .await?;
    if !status.is_success() {
        let code = serde_json::from_str::<Value>(&reply)
            .ok()
            .and_then(|reply| reply.get("error")?.as_str().map(str::to_owned));
        if refreshing.is_some() && code.as_deref() == Some("invalid_grant") {
            return Err(LoginError::Reauthenticate);
        }
        return Err(LoginError::Denied(format!("{status}: {reply}")));
    }
    #[derive(Deserialize)]
    struct Granted {
        access_token: String,
        refresh_token: Option<String>,
        id_token: Option<String>,
        expires_in: Option<u64>,
    }
    let granted: Granted = parse(&reply)?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let expires_at_s = claims(&granted.access_token)
        .get("exp")
        .and_then(Value::as_u64)
        .or_else(|| {
            granted
                .expires_in
                .map(|seconds| now.saturating_add(seconds))
        });
    let account_id = [
        granted.id_token.as_deref(),
        Some(granted.access_token.as_str()),
    ]
    .into_iter()
    .flatten()
    .find_map(|token| {
        claims(token)
            .pointer("/https:~1~1api.openai.com~1auth/chatgpt_account_id")
            .and_then(Value::as_str)
            .map(str::to_owned)
    });
    Ok(Tokens {
        access_token: granted.access_token,
        refresh_token: granted
            .refresh_token
            .or_else(|| refreshing.map(str::to_owned)),
        id_token: granted.id_token,
        account_id,
        expires_at_s,
    })
}

async fn post(
    url: &str,
    content_type: &str,
    body: String,
) -> Result<(reqwest::StatusCode, String), LoginError> {
    let reply = reqwest::Client::new()
        .post(url)
        .header(reqwest::header::CONTENT_TYPE, content_type)
        .header(reqwest::header::ACCEPT, "application/json")
        .body(body)
        .send()
        .await
        .map_err(|error| LoginError::Http(error.to_string()))?;
    let status = reply.status();
    let text = reply
        .text()
        .await
        .map_err(|error| LoginError::Http(error.to_string()))?;
    Ok((status, text))
}

fn parse<T: serde::de::DeserializeOwned>(text: &str) -> Result<T, LoginError> {
    serde_json::from_str(text)
        .map_err(|error| LoginError::Http(format!("unreadable reply: {error}")))
}

/// The claims of a JWT, unverified: only read to know when it expires and
/// whose it is. The provider checks the signature.
fn claims(token: &str) -> Value {
    token
        .split('.')
        .nth(1)
        .and_then(|payload| URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(Value::Null)
}

/// `bytes` random bytes from the OS generator, URL-safe base64.
fn random_token(bytes: usize) -> String {
    let random: Vec<u8> = (0..bytes.div_ceil(16))
        .flat_map(|_| uuid::Uuid::new_v4().into_bytes())
        .take(bytes)
        .collect();
    URL_SAFE_NO_PAD.encode(random)
}

#[derive(Debug, PartialEq, Eq)]
enum Callback {
    Code(String),
    Failed(String),
    StateMismatch,
    Other,
}

fn parse_callback(request_line: &str, expected_state: &str) -> Callback {
    let mut parts = request_line.split_whitespace();
    let (Some("GET"), Some(target)) = (parts.next(), parts.next()) else {
        return Callback::Other;
    };
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    if path != CALLBACK_PATH {
        return Callback::Other;
    }
    let (mut code, mut state, mut error, mut description) = (None, None, None, None);
    for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
        let slot = match key.as_ref() {
            "code" => &mut code,
            "state" => &mut state,
            "error" => &mut error,
            "error_description" => &mut description,
            _ => continue,
        };
        *slot = Some(value.into_owned());
    }
    if state.as_deref() != Some(expected_state) {
        return Callback::StateMismatch;
    }
    if let Some(error) = error {
        return Callback::Failed(match description {
            Some(description) if !description.trim().is_empty() => {
                format!("{error} ({description})")
            }
            _ => error,
        });
    }
    match code.filter(|code| !code.is_empty()) {
        Some(code) => Callback::Code(code),
        None => Callback::Failed("no authorization code came back".to_owned()),
    }
}

async fn read_request_line(stream: &mut TcpStream) -> std::io::Result<String> {
    let mut head = Vec::new();
    let mut chunk = [0u8; 1024];
    let read = async {
        while !head.windows(4).any(|window| window == b"\r\n\r\n") {
            if head.len() >= MAX_REQUEST_BYTES {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "request too large",
                ));
            }
            let read = stream.read(&mut chunk).await?;
            if read == 0 {
                break;
            }
            head.extend_from_slice(chunk.get(..read).unwrap_or_default());
        }
        Ok(())
    };
    tokio::time::timeout(STREAM_TIMEOUT, read)
        .await
        .map_err(|_| {
            std::io::Error::new(std::io::ErrorKind::TimedOut, "the browser sent nothing")
        })??;
    Ok(String::from_utf8_lossy(&head)
        .lines()
        .next()
        .unwrap_or_default()
        .to_owned())
}

async fn respond(stream: &mut TcpStream, status: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\n\
         Cache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = tokio::time::timeout(STREAM_TIMEOUT, stream.write_all(response.as_bytes())).await;
    let _ = stream.shutdown().await;
}

fn page(title: &str, message: &str) -> String {
    let escape = |text: &str| {
        text.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
    };
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>{}</title></head>\
         <body style=\"font-family: system-ui, sans-serif; margin: 4rem auto; max-width: 32rem\">\
         <h1>{}</h1><p>{}</p></body></html>",
        escape(title),
        escape(title),
        escape(message)
    )
}
