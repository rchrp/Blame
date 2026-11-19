//! Provider ids and credentials → a `ModelProvider`.

use crate::native::Target;
use crate::wire::Wire;
use crate::{request, stream};
use async_trait::async_trait;
use blame_engine_core::ports::{ModelProvider, ModelRequest, ModelStream, ProviderError};
use blame_engine_protocol::ErrorKind;
use blame_engine_protocol::rpc::Credential;
use rig_core::providers::anthropic::completion::CacheTtl;
use rig_core::providers::anthropic::wire::{ANTHROPIC, AnthropicConfig, Auth as AnthropicAuth};
use rig_core::providers::gemini::GeminiConfig;
use rig_core::providers::openai::OpenAIConfig;
use rig_core::providers::openai::wire::{
    Auth as OpenAiAuth, Dialect as OpenAiDialect, OPENAI, OPENROUTER,
};
use rig_core::providers::{chatgpt, gemini};
use rig_reqwest::ReqwestClient;
use std::time::Duration;

/// The providers this crate serves, by the id `ModelRef::provider` holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ProviderKind {
    /// Anthropic's Messages API with an API key (`x-api-key`) or a bearer
    /// token, at any base URL.
    Anthropic,
    /// The Claude Code bridge: a local server speaking the Messages API.
    /// Its own id keeps its replies apart from the API's (a native item
    /// replays only to the provider that produced it). Needs a base URL.
    ClaudeCode,
    /// OpenAI's Responses API with an API key.
    OpenAi,
    /// The ChatGPT subscription backend (Responses, Codex contract) with
    /// the bearer token of a sign-in; see [`crate::chatgpt`].
    ChatGpt,
    /// Gemini's `generateContent` with an API key.
    Gemini,
    /// OpenRouter's Chat Completions.
    OpenRouter,
    /// Any server speaking OpenAI Chat Completions (local models and the
    /// rest). Needs a base URL; the key may be empty.
    OpenAiCompatible,
}

impl ProviderKind {
    pub const ALL: [Self; 7] = [
        Self::Anthropic,
        Self::ClaudeCode,
        Self::OpenAi,
        Self::ChatGpt,
        Self::Gemini,
        Self::OpenRouter,
        Self::OpenAiCompatible,
    ];

    pub fn id(self) -> &'static str {
        match self {
            Self::Anthropic => "anthropic",
            Self::ClaudeCode => "claude-code",
            Self::OpenAi => "openai",
            Self::ChatGpt => "chatgpt",
            Self::Gemini => "gemini",
            Self::OpenRouter => "openrouter",
            Self::OpenAiCompatible => "openai-compatible",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.id() == id)
    }

    pub(crate) fn wire(self) -> Wire {
        match self {
            Self::Anthropic | Self::ClaudeCode => Wire::AnthropicMessages,
            Self::OpenAi | Self::ChatGpt => Wire::OpenAiResponses,
            Self::Gemini => Wire::GeminiGenerateContent,
            Self::OpenRouter | Self::OpenAiCompatible => Wire::OpenAiChat,
        }
    }
}

/// What the binary may tune; the defaults suit production.
#[derive(Clone, Debug)]
pub struct Options {
    /// A streamed reply that sends nothing for this long fails as
    /// `ErrorKind::Stalled`. Providers ping while a model thinks, so this
    /// only trips on a dead connection.
    pub idle_timeout: Duration,
    /// How long opening a connection may take.
    pub connect_timeout: Duration,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            idle_timeout: rig_core::driver::STREAM_IDLE_TIMEOUT,
            connect_timeout: Duration::from_secs(30),
        }
    }
}

/// The `max_tokens` Anthropic requires when neither the request nor the
/// catalog gives one (a model the catalog does not list, behind the
/// bridge or a gateway).
const FALLBACK_MAX_TOKENS: u64 = 16_384;

/// OpenAI Chat Completions anywhere, with a bearer token only when one is
/// given: a local server usually needs none.
const OPENAI_COMPATIBLE: OpenAiDialect = {
    let mut dialect = OpenAiDialect::gateway("openai-compatible", "http://127.0.0.1", "");
    dialect.quirks.auth = OpenAiAuth::OptionalBearer;
    dialect
};

/// Anthropic's dialect authenticating with `Authorization: Bearer`, as an
/// OAuth token and the Claude Code bridge do. Rig's own dialect only sends
/// `x-api-key`.
const ANTHROPIC_BEARER: rig_core::providers::anthropic::Dialect = {
    let mut dialect = ANTHROPIC;
    dialect.quirks.auth = AnthropicAuth::OptionalBearer;
    dialect
};

/// One provider with one credential. Holds no conversation state: each
/// request carries its whole context.
pub struct Provider {
    kind: ProviderKind,
    client: Client,
    http: ReqwestClient,
    idle_timeout: Duration,
}

enum Client {
    Anthropic(AnthropicConfig),
    Responses(OpenAIConfig),
    Chat(OpenAIConfig),
    Gemini(GeminiConfig),
}

impl std::fmt::Debug for Provider {
    // The configurations hold the credential.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Provider")
            .field("kind", &self.kind)
            .finish_non_exhaustive()
    }
}

/// The provider `id` with `credential`. Fails with
/// `ErrorKind::Authentication` when the credential is missing or of a kind
/// the provider does not take, and `ErrorKind::InvalidRequest` for an
/// unknown id or a missing base URL.
pub fn connect(
    id: &str,
    credential: &Credential,
    options: &Options,
) -> Result<Provider, ProviderError> {
    let kind = ProviderKind::from_id(id).ok_or_else(|| {
        ProviderError::new(
            ErrorKind::InvalidRequest,
            format!("unknown provider `{id}`"),
        )
    })?;
    let (secret, account, base_url, bearer) = match credential {
        Credential::ApiKey { key, base_url } => (key.clone(), None, base_url.clone(), false),
        Credential::Bearer {
            token,
            account,
            base_url,
        } => (token.clone(), account.clone(), base_url.clone(), true),
        Credential::Missing => {
            return Err(ProviderError::new(
                ErrorKind::Authentication,
                format!("no credential for `{id}`"),
            ));
        }
    };
    let needs_base_url = || {
        base_url.clone().ok_or_else(|| {
            ProviderError::new(
                ErrorKind::InvalidRequest,
                format!("`{id}` needs a base URL"),
            )
        })
    };
    let client = match kind {
        ProviderKind::Anthropic | ProviderKind::ClaudeCode => {
            let dialect = if bearer { ANTHROPIC_BEARER } else { ANTHROPIC };
            let mut config = AnthropicConfig::with_key(&dialect, secret);
            match (kind, &base_url) {
                (ProviderKind::ClaudeCode, _) => config = config.with_base_url(needs_base_url()?),
                (_, Some(base_url)) => config = config.with_base_url(base_url),
                (_, None) => {}
            }
            Client::Anthropic(config)
        }
        ProviderKind::OpenAi => {
            let mut config = OpenAIConfig::with_key(&OPENAI, secret);
            if let Some(base_url) = base_url {
                config = config.with_base_url(base_url);
            }
            Client::Responses(config)
        }
        ProviderKind::ChatGpt => {
            let mut config = OpenAIConfig::with_key(&chatgpt::DIALECT, secret);
            if let Some(base_url) = base_url {
                config = config.with_base_url(base_url);
            }
            config.account_id = account;
            // Rig puts "You are ChatGPT" ahead of every system prompt; the
            // session's own prompt is the only one it should get.
            config.instructions = None;
            if let Some(identity) = config.identity.as_mut() {
                identity.originator = crate::chatgpt::ORIGINATOR.to_owned();
            }
            Client::Responses(config)
        }
        ProviderKind::Gemini => {
            if bearer {
                return Err(ProviderError::new(
                    ErrorKind::Authentication,
                    "Gemini takes an API key, not a bearer token",
                ));
            }
            let mut config = GeminiConfig::new(secret);
            if let Some(base_url) = base_url {
                config = config.with_base_url(base_url);
            }
            Client::Gemini(config)
        }
        ProviderKind::OpenRouter => {
            let mut config = OpenAIConfig::with_key(&OPENROUTER, secret);
            if let Some(base_url) = base_url {
                config = config.with_base_url(base_url);
            }
            Client::Chat(config)
        }
        ProviderKind::OpenAiCompatible => Client::Chat(
            OpenAIConfig::with_key(&OPENAI_COMPATIBLE, secret).with_base_url(needs_base_url()?),
        ),
    };
    let http = rig_reqwest::reqwest::Client::builder()
        .connect_timeout(options.connect_timeout)
        .build()
        .map_err(|error| {
            ProviderError::new(
                ErrorKind::Internal,
                format!("building the HTTP client failed: {error}"),
            )
        })?;
    Ok(Provider {
        kind,
        client,
        http: ReqwestClient::from(http),
        idle_timeout: options.idle_timeout,
    })
}

impl Provider {
    pub fn kind(&self) -> ProviderKind {
        self.kind
    }

    fn target(&self, request: &ModelRequest) -> Target {
        let rig_provider = match &self.client {
            Client::Anthropic(config) => config.dialect.name,
            Client::Responses(config) | Client::Chat(config) => config.dialect.name,
            Client::Gemini(_) => gemini::PROVIDER_NAME,
        };
        Target {
            wire: self.kind.wire(),
            model: request.model.clone(),
            rig_provider,
            priced: !matches!(
                self.kind,
                ProviderKind::ClaudeCode | ProviderKind::ChatGpt | ProviderKind::OpenAiCompatible
            ),
        }
    }
}

#[async_trait]
impl ModelProvider for Provider {
    async fn stream(&self, request: ModelRequest) -> Result<ModelStream, ProviderError> {
        if request.model.provider != self.kind.id() {
            return Err(ProviderError::new(
                ErrorKind::InvalidRequest,
                format!(
                    "a request for `{}` reached the `{}` provider",
                    request.model.provider,
                    self.kind.id()
                ),
            ));
        }
        let target = self.target(&request);
        let rig = request::to_rig(&request, &target).await?;
        let model = request.model.model.clone();
        let idle = Some(self.idle_timeout);
        let http = self.http.clone();
        let opened = match &self.client {
            Client::Anthropic(config) => {
                let mut model = config
                    .clone()
                    .connect(http)
                    .completion(model)
                    .with_idle_timeout(idle);
                if model.wire.default_max_tokens.is_none() {
                    model.wire = model.wire.with_default_max_tokens(FALLBACK_MAX_TOKENS);
                }
                if request.cache.long_lived_prefix {
                    model.wire = model.wire.with_static_prefix_cache_ttl(CacheTtl::OneHour);
                }
                model.stream(rig)
            }
            Client::Responses(config) => config
                .clone()
                .connect(http)
                .responses(model)
                .with_idle_timeout(idle)
                .stream(rig),
            Client::Chat(config) => config
                .clone()
                .connect(http)
                .chat(model)
                .with_idle_timeout(idle)
                .stream(rig),
            Client::Gemini(config) => config
                .clone()
                .connect(http)
                .completion(model)
                .with_idle_timeout(idle)
                .stream(rig),
        };
        let reply = opened.map_err(|error| crate::error::from_rig(&error))?;
        Ok(stream::events(reply, target))
    }
}
