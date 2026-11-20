//! The providers and models a client may offer, as `catalog/list` returns
//! them. The data comes from models.dev, fetched by the engine at run time:
//! every client (the desktop app, later a phone through the cloud) sees the
//! same list, and a model published there is offered without a Blame
//! release.

use crate::content::ReasoningEffort;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(optional_fields))]
pub struct ModelCatalog {
    /// Every provider the engine serves, in the order to show them.
    pub providers: Vec<ProviderInfo>,
    pub source: CatalogSource,
    /// When the models.dev data in use was fetched, in milliseconds since
    /// the Unix epoch.
    pub fetched_at_ms: u64,
    /// Why the last refresh failed, when it did. The list is then the last
    /// copy that loaded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_error: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum CatalogSource {
    /// The copy compiled into this engine: nothing newer was fetched yet.
    Snapshot,
    /// A copy fetched from models.dev, now or on an earlier run.
    ModelsDev,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct ProviderInfo {
    /// The id `ModelRef::provider` takes.
    pub id: String,
    pub name: String,
    pub auth: AuthKind,
    /// Whether the credential must carry a base URL.
    pub needs_base_url: bool,
    /// The models.dev providers its models come from; empty when the models
    /// depend on the server (`openai-compatible`: its own `/models`).
    pub sources: Vec<String>,
    /// Newest first. A model missing here can still be used: the provider
    /// decides, and says so when it refuses.
    pub models: Vec<ModelInfo>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum AuthKind {
    ApiKey,
    /// A plan the user signs in to (ChatGPT, Claude Code). models.dev does
    /// not say which models a plan includes: every model of the vendor is
    /// listed, and the provider refuses the ones the plan lacks.
    Subscription,
    /// A key or token if the server wants one.
    Optional,
}

/// One model. Every field but `id` and `name` may be unknown for a model
/// models.dev has only just listed; unknown reads as "not offered" for
/// inputs and as "ask the provider" for limits, never as "refuse".
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(optional_fields))]
pub struct ModelInfo {
    /// models.dev's id, which the provider's API takes as is.
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub family: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u32>,
    /// When the provider reads less than the context window.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_input_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u32>,
    pub images: bool,
    pub pdf: bool,
    pub reasoning: ReasoningInfo,
    /// Absent when unknown or billed by subscription.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub price: Option<Price>,
    /// `YYYY-MM-DD` or `YYYY-MM`, as models.dev gives it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release_date: Option<String>,
    /// `alpha` or `beta` while the provider says so.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(optional_fields))]
pub struct ReasoningInfo {
    pub supported: bool,
    /// The levels the model takes, lowest first. A model that takes a
    /// token budget lists the levels the engine turns into one. Empty when
    /// it reasons but the catalog does not say how it is controlled: any
    /// level is then sent as asked.
    pub efforts: Vec<ReasoningEffort>,
    /// Whether `ReasoningEffort::Off` turns its reasoning off; otherwise
    /// `Off` asks for its lowest level.
    pub can_disable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<ReasoningEffort>,
}

/// Millionths of a US dollar per million tokens (so per token in USD,
/// exactly), the unit `Usage::cost_micro_usd` is counted in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(optional_fields))]
pub struct Price {
    pub input: u64,
    pub output: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write: Option<u64>,
}
