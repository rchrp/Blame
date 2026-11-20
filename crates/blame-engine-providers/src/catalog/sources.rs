//! Which models.dev providers feed each engine provider.
//!
//! | engine provider | models.dev provider | priced |
//! | --- | --- | --- |
//! | `anthropic` | `anthropic` | yes |
//! | `claude-code` | `anthropic` | no (plan) |
//! | `openai` | `openai` | yes |
//! | `chatgpt` | `openai` | no (plan) |
//! | `gemini` | `google` | yes |
//! | `openrouter` | `openrouter` | yes |
//! | `openai-compatible` | none: the server's own `/models` | no |
//!
//! models.dev does not say which models a plan includes, so a subscription
//! offers every model of its vendor and the provider refuses the ones the
//! plan lacks, with a message that names the model.

use crate::catalog::AuthKind;
use crate::registry::ProviderKind;

/// The models.dev provider keys the engine keeps from `api.json`; every
/// other provider is dropped before the data is stored.
pub const MODELS_DEV_KEYS: [&str; 4] = ["anthropic", "openai", "google", "openrouter"];

pub(crate) struct Source {
    pub name: &'static str,
    pub auth: AuthKind,
    pub needs_base_url: bool,
    /// models.dev provider keys, in the order their models are listed.
    pub keys: &'static [&'static str],
    /// Whether replies cost models.dev's list price.
    pub priced: bool,
}

impl Source {
    /// Rig's vendor names for [`Self::keys`] (models.dev's `google` is
    /// Rig's `gcp.gemini`).
    pub fn data_vendors(&self) -> impl Iterator<Item = &'static str> + '_ {
        self.keys.iter().map(|key| match *key {
            "google" => "gcp.gemini",
            other => other,
        })
    }
}

pub(crate) fn source(kind: ProviderKind) -> Source {
    let (name, auth, needs_base_url, keys, priced): (_, _, _, &'static [&'static str], _) =
        match kind {
            ProviderKind::Anthropic => ("Anthropic", AuthKind::ApiKey, false, &["anthropic"], true),
            ProviderKind::ClaudeCode => (
                "Claude Code",
                AuthKind::Subscription,
                true,
                &["anthropic"],
                false,
            ),
            ProviderKind::OpenAi => ("OpenAI", AuthKind::ApiKey, false, &["openai"], true),
            ProviderKind::ChatGpt => ("ChatGPT", AuthKind::Subscription, false, &["openai"], false),
            ProviderKind::Gemini => ("Google Gemini", AuthKind::ApiKey, false, &["google"], true),
            ProviderKind::OpenRouter => {
                ("OpenRouter", AuthKind::ApiKey, false, &["openrouter"], true)
            }
            ProviderKind::OpenAiCompatible => {
                ("OpenAI-compatible", AuthKind::Optional, true, &[], false)
            }
        };
    Source {
        name,
        auth,
        needs_base_url,
        keys,
        priced,
    }
}
