//! models.dev rows → the [`ProviderInfo`] a client shows.

use super::sources::{self, Source};
use super::{Catalog, ModelInfo, Price, ProviderInfo, ReasoningInfo};
use crate::registry::ProviderKind;
use blame_engine_protocol::ReasoningEffort;
use rig_core::catalog::{ModelSpec, ReasoningSupport};
use rig_core::completion::Effort;
use serde_json::Value;
use std::collections::HashSet;

pub(super) fn provider(catalog: &Catalog, kind: ProviderKind) -> ProviderInfo {
    let source = sources::source(kind);
    let mut models: Vec<ModelInfo> = Vec::new();
    for (key, vendor) in source.keys.iter().zip(source.data_vendors()) {
        let specs: Vec<&ModelSpec> = catalog
            .data_specs(vendor)
            .filter(|spec| usable(spec))
            .collect();
        let listed: HashSet<&str> = specs.iter().map(|spec| spec.id.as_str()).collect();
        for spec in specs {
            if snapshot_of(&spec.id).is_some_and(|base| listed.contains(base)) {
                continue;
            }
            // Rig's reviewed row when it has one, for the vendor the wire
            // speaks as (a subscription's own Rig vendor first).
            let fact = facts_vendor(kind)
                .and_then(|own| catalog.fact_of(own, &spec.id))
                .or_else(|| catalog.fact_of(vendor, &spec.id))
                .unwrap_or(spec);
            models.push(model(fact, &source));
        }
        for (path, info) in &catalog.loose {
            if path
                .split_once(".models.")
                .is_some_and(|(at, _)| at == *key)
                && !models.iter().any(|known| known.id == info.id)
            {
                models.push(info.clone());
            }
        }
    }
    // Newest first; models.dev dates are `YYYY-MM-DD` or `YYYY-MM`, which
    // sort as text.
    models.sort_by(|a, b| {
        b.release_date
            .cmp(&a.release_date)
            .then_with(|| a.name.cmp(&b.name))
    });
    ProviderInfo {
        id: kind.id().to_owned(),
        name: source.name.to_owned(),
        auth: source.auth,
        needs_base_url: source.needs_base_url,
        sources: source.keys.iter().map(|key| (*key).to_owned()).collect(),
        models,
    }
}

/// The Rig vendor a provider's wire names itself by, when it is not the
/// vendor its models come from.
fn facts_vendor(kind: ProviderKind) -> Option<&'static str> {
    (kind == ProviderKind::ChatGpt).then_some("chatgpt")
}

/// An agent's model: it calls tools, reads text, is a chat model and is not
/// withdrawn. Nothing else is required: a model with unknown limits or
/// prices is offered.
fn usable(spec: &ModelSpec) -> bool {
    spec.tools
        && spec.input.text
        && !spec.deprecated
        && spec
            .details
            .kind
            .as_deref()
            .is_none_or(|kind| kind == "chat")
}

/// The model `id` is a dated snapshot of (`claude-haiku-4-5-20251001`,
/// `gpt-4o-2024-08-06`), which the list leaves out when the model itself
/// is listed: the user picks a model, the provider resolves the date.
pub(super) fn snapshot_of(id: &str) -> Option<&str> {
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

fn model(spec: &ModelSpec, source: &Source) -> ModelInfo {
    let details = &spec.details;
    ModelInfo {
        id: spec.id.clone(),
        name: spec.display_name.clone(),
        family: details.family.clone(),
        context_window: spec.context_window,
        max_input_tokens: spec.max_input_tokens,
        max_output_tokens: spec.max_output_tokens,
        images: spec.input.image,
        pdf: spec.input.pdf,
        reasoning: reasoning(&spec.reasoning),
        price: spec
            .pricing
            .as_ref()
            .filter(|_| source.priced)
            .map(|pricing| Price {
                input: micro(pricing.input),
                output: micro(pricing.output),
                cache_read: pricing.cache_read.map(micro),
                cache_write: pricing.cache_write.map(micro),
            }),
        release_date: details.release_date.clone(),
        status: details
            .status
            .clone()
            .filter(|status| status == "alpha" || status == "beta"),
    }
}

/// The levels a budget-only model is offered: the engine turns each into a
/// token budget inside the model's range.
const BUDGET_LEVELS: [ReasoningEffort; 4] = [
    ReasoningEffort::Low,
    ReasoningEffort::Medium,
    ReasoningEffort::High,
    ReasoningEffort::Max,
];

fn reasoning(support: &ReasoningSupport) -> ReasoningInfo {
    match support {
        ReasoningSupport::None => ReasoningInfo {
            supported: false,
            efforts: Vec::new(),
            can_disable: false,
            default: None,
        },
        ReasoningSupport::Unknown { default } => ReasoningInfo {
            supported: true,
            efforts: Vec::new(),
            can_disable: false,
            default: default.and_then(effort),
        },
        ReasoningSupport::Listed {
            levels,
            budget,
            can_disable,
            default,
        } => ReasoningInfo {
            supported: true,
            efforts: if levels.is_empty() && budget.is_some() {
                BUDGET_LEVELS.to_vec()
            } else {
                levels.iter().copied().filter_map(effort).collect()
            },
            can_disable: *can_disable,
            default: default.and_then(effort),
        },
        // A state a later Rig adds: it reasons, nothing more is known.
        _ => ReasoningInfo {
            supported: true,
            efforts: Vec::new(),
            can_disable: false,
            default: None,
        },
    }
}

pub(crate) fn effort(effort: Effort) -> Option<ReasoningEffort> {
    Some(match effort {
        Effort::Minimal => ReasoningEffort::Minimal,
        Effort::Low => ReasoningEffort::Low,
        Effort::Medium => ReasoningEffort::Medium,
        Effort::High => ReasoningEffort::High,
        Effort::XHigh => ReasoningEffort::Xhigh,
        Effort::Max => ReasoningEffort::Max,
        #[allow(unreachable_patterns)]
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

/// The rows at `paths` (`key.models.id`) that Rig could not read, with
/// what can be read of them: a new model whose row has a field in a shape
/// nobody has seen yet is still offered. Rows that say they take no tools
/// or are deprecated are left out, as readable ones are.
pub(super) fn loose_rows(json: &str, paths: &HashSet<String>) -> Vec<(String, ModelInfo)> {
    let Ok(Value::Object(sections)) = serde_json::from_str::<Value>(json) else {
        return Vec::new();
    };
    let mut rows = Vec::new();
    for (key, section) in &sections {
        let Some(models) = section.get("models").and_then(Value::as_object) else {
            continue;
        };
        for (id, row) in models {
            let path = format!("{key}.models.{id}");
            if !paths.contains(&path) {
                continue;
            }
            let flag = |name: &str| row.get(name).and_then(Value::as_bool);
            let text = |name: &str| row.get(name).and_then(Value::as_str).map(str::to_owned);
            if flag("tool_call") == Some(false) || text("status").as_deref() == Some("deprecated") {
                continue;
            }
            let limit = |name: &str| {
                row.get("limit")
                    .and_then(|limit| limit.get(name))
                    .and_then(Value::as_u64)
                    .and_then(|tokens| u32::try_from(tokens).ok())
            };
            let inputs: Vec<&str> = row
                .pointer("/modalities/input")
                .and_then(Value::as_array)
                .map(|inputs| inputs.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            let reads = |kind: &str| inputs.iter().any(|input| input.starts_with(kind));
            rows.push((
                path,
                ModelInfo {
                    id: id.clone(),
                    name: text("name").unwrap_or_else(|| id.clone()),
                    family: text("family"),
                    context_window: limit("context"),
                    max_input_tokens: limit("input"),
                    max_output_tokens: limit("output"),
                    images: reads("image"),
                    pdf: reads("pdf") || reads("application/pdf"),
                    reasoning: ReasoningInfo {
                        supported: flag("reasoning").unwrap_or(false),
                        efforts: Vec::new(),
                        can_disable: false,
                        default: None,
                    },
                    price: None,
                    release_date: text("release_date"),
                    status: text("status").filter(|status| status == "alpha" || status == "beta"),
                },
            ));
        }
    }
    rows
}
