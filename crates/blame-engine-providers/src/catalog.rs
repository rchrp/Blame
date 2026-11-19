//! The providers and models offered to the user, with what the loop and the
//! UI need to know about each model.
//!
//! The model facts come from the catalog compiled into Rig (a reviewed copy
//! of models.dev). Only models that take tools and text are listed: an
//! agent needs both.

use crate::registry::ProviderKind;
use blame_engine_protocol::ReasoningEffort;
use rig_core::catalog::{Catalog, ModelSpec, ReasoningSupport};
use rig_core::completion::Effort;
use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ProviderInfo {
    /// The id `ModelRef::provider` and [`crate::connect`] take.
    pub id: &'static str,
    pub name: &'static str,
    pub auth: AuthKind,
    /// Whether the credential must carry a base URL.
    pub needs_base_url: bool,
    /// Empty when the models depend on the server (`openai-compatible`,
    /// `claude-code`'s bridge decides which Claude models it serves, but
    /// they are Anthropic's, so its list is Anthropic's).
    pub models: Vec<ModelInfo>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthKind {
    ApiKey,
    /// Signed in on the user's machine; see [`crate::chatgpt`].
    Subscription,
    /// A key or token if the server wants one.
    Optional,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u32>,
    pub images: bool,
    pub pdf: bool,
    pub reasoning: ReasoningInfo,
    /// Absent when unknown or billed by subscription.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price: Option<Price>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ReasoningInfo {
    pub supported: bool,
    /// The efforts the model takes, lowest first; empty when it reasons but
    /// the catalog does not say how it is controlled.
    pub efforts: Vec<ReasoningEffort>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<ReasoningEffort>,
}

/// Millionths of a US dollar per million tokens (so per token in USD,
/// exactly), the unit `Usage::cost_micro_usd` is counted in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Price {
    pub input: u64,
    pub output: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_read: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_write: Option<u64>,
}

/// Every provider [`crate::connect`] serves, with its models.
pub fn providers() -> Vec<ProviderInfo> {
    ProviderKind::ALL.into_iter().map(provider).collect()
}

pub fn provider(kind: ProviderKind) -> ProviderInfo {
    let (name, auth, needs_base_url, vendor, priced) = match kind {
        ProviderKind::Anthropic => (
            "Anthropic",
            AuthKind::ApiKey,
            false,
            Some("anthropic"),
            true,
        ),
        ProviderKind::ClaudeCode => (
            "Claude Code",
            AuthKind::Subscription,
            true,
            Some("anthropic"),
            false,
        ),
        ProviderKind::OpenAi => ("OpenAI", AuthKind::ApiKey, false, Some("openai"), true),
        ProviderKind::ChatGpt => (
            "ChatGPT",
            AuthKind::Subscription,
            false,
            Some("chatgpt"),
            false,
        ),
        ProviderKind::Gemini => (
            "Google Gemini",
            AuthKind::ApiKey,
            false,
            Some("gcp.gemini"),
            true,
        ),
        ProviderKind::OpenRouter => (
            "OpenRouter",
            AuthKind::ApiKey,
            false,
            Some("openrouter"),
            true,
        ),
        ProviderKind::OpenAiCompatible => {
            ("OpenAI-compatible", AuthKind::Optional, true, None, false)
        }
    };
    let models = vendor.map_or_else(Vec::new, |vendor| {
        let specs: Vec<&ModelSpec> = Catalog::builtin()
            .iter()
            .filter(|spec| spec.provider.vendor() == vendor && usable(spec))
            .collect();
        let listed = |id: &str| specs.iter().any(|spec| spec.id == id);
        specs
            .iter()
            .filter(|spec| snapshot_of(&spec.id).is_none_or(|base| !listed(base)))
            .map(|spec| model(spec, priced))
            .collect()
    });
    ProviderInfo {
        id: kind.id(),
        name,
        auth,
        needs_base_url,
        models,
    }
}

/// An agent's model: it calls tools, reads text and is not withdrawn.
fn usable(spec: &ModelSpec) -> bool {
    spec.tools && spec.input.text && !spec.deprecated
}

/// The model `id` is a dated snapshot of (`claude-haiku-4-5-20251001`,
/// `gpt-4o-2024-08-06`), which the list leaves out when the model itself
/// is listed: the user picks a model, the provider resolves the date.
fn snapshot_of(id: &str) -> Option<&str> {
    let digits = |text: &str| text.bytes().all(|byte| byte.is_ascii_digit());
    let (base, date) = id.rsplit_once("-20")?;
    if date.len() == 6 && digits(date) {
        return Some(base);
    }
    // `-2024-08-06`: the year is split off with its own dash.
    let (base, _) = id.rsplit_once('-').and_then(|(rest, day)| {
        let (rest, month) = rest.rsplit_once('-')?;
        let (base, year) = rest.rsplit_once('-')?;
        (year.len() == 4
            && month.len() == 2
            && day.len() == 2
            && digits(year)
            && digits(month)
            && digits(day))
        .then_some((base, ()))
    })?;
    Some(base)
}

fn model(spec: &ModelSpec, priced: bool) -> ModelInfo {
    ModelInfo {
        id: spec.id.clone(),
        name: spec.display_name.clone(),
        context_window: spec.context_window,
        max_output_tokens: spec.max_output_tokens,
        images: spec.input.image,
        pdf: spec.input.pdf,
        reasoning: reasoning(&spec.reasoning),
        price: spec
            .pricing
            .as_ref()
            .filter(|_| priced)
            .map(|pricing| Price {
                input: micro(pricing.input),
                output: micro(pricing.output),
                cache_read: pricing.cache_read.map(micro),
                cache_write: pricing.cache_write.map(micro),
            }),
    }
}

fn reasoning(support: &ReasoningSupport) -> ReasoningInfo {
    match support {
        ReasoningSupport::None => ReasoningInfo {
            supported: false,
            efforts: Vec::new(),
            default: None,
        },
        ReasoningSupport::Unknown { default } => ReasoningInfo {
            supported: true,
            efforts: Vec::new(),
            default: default.and_then(effort),
        },
        ReasoningSupport::Listed {
            levels, default, ..
        } => ReasoningInfo {
            supported: true,
            efforts: levels.iter().copied().filter_map(effort).collect(),
            default: default.and_then(effort),
        },
        _ => ReasoningInfo {
            supported: true,
            efforts: Vec::new(),
            default: None,
        },
    }
}

/// Our efforts stop at `xhigh`: Rig's `max` has no counterpart yet.
fn effort(effort: Effort) -> Option<ReasoningEffort> {
    Some(match effort {
        Effort::Minimal => ReasoningEffort::Minimal,
        Effort::Low => ReasoningEffort::Low,
        Effort::Medium => ReasoningEffort::Medium,
        Effort::High => ReasoningEffort::High,
        Effort::XHigh => ReasoningEffort::Xhigh,
        _ => return None,
    })
}

fn micro(usd_per_million: f64) -> u64 {
    if usd_per_million.is_finite() && usd_per_million >= 0.0 {
        (usd_per_million * 1_000_000.0).round() as u64
    } else {
        0
    }
}
