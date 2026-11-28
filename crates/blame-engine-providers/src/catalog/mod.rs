//! The providers and models offered to the user, and the facts the wires
//! encode and price with, from models.dev.
//!
//! The data is models.dev's `api.json` cut to the providers the engine
//! serves ([`sources`]). It comes from, newest first: a copy fetched at run
//! time and kept in the data directory ([`live`]), or the snapshot compiled
//! into the binary (`catalog/models-dev.json`, refreshed by
//! `scripts/refresh-model-catalog.sh`). Rig reads it (`from_models_dev`,
//! lenient) and lays it over its own reviewed copy, so a model models.dev
//! has just listed is offered and encoded at once, and a model Rig reviewed
//! keeps the facts Rig pinned.
//!
//! Permissive by design: a model is offered as soon as models.dev lists it
//! for a served provider. A row Rig cannot read is still offered with what
//! could be read, and a model missing from the catalog can still be asked
//! for: the provider decides, and its refusal names the model
//! (`ErrorKind::ModelUnavailable`).

mod listing;
pub mod live;
pub(crate) mod sources;

pub use blame_engine_protocol::catalog::{
    AuthKind, CatalogSource, ModelCatalog, ModelInfo, Price, ProviderInfo, ReasoningInfo,
};
pub use live::{LiveCatalog, RefreshOptions};
pub use sources::MODELS_DEV_KEYS;

use crate::registry::ProviderKind;
use blame_engine_protocol::ModelRef;
use rig_core::catalog::{Catalog as RigCatalog, ModelFacts, ModelSpec, SkipReason};
use rig_core::providers::registry::ProviderId;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::{Arc, OnceLock};

/// The snapshot compiled into this build, and when it was fetched.
const SNAPSHOT: &str = include_str!("../../catalog/models-dev.json");
const SNAPSHOT_META: &str = include_str!("../../catalog/models-dev.meta.json");

/// What is known about a copy of the data besides its contents.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Meta {
    /// When models.dev sent this copy, in milliseconds since the epoch.
    pub fetched_at_ms: u64,
    /// models.dev's `ETag` for it, for a conditional request.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub etag: Option<String>,
}

/// One copy of the data, read. Cheap to share: [`LiveCatalog`] swaps a new
/// one in after a refresh, and a request keeps the one it started with.
#[derive(Debug)]
pub struct Catalog {
    /// Rig's reviewed copy with this data laid over it: what the wires
    /// encode and price with.
    facts: RigCatalog,
    /// This data alone: what is offered.
    data: RigCatalog,
    /// Rows Rig could not read, offered with what could be read.
    loose: Vec<(String, ModelInfo)>,
    meta: Meta,
    source: CatalogSource,
}

impl Catalog {
    /// The snapshot compiled into this build.
    ///
    /// # Panics
    ///
    /// When the compiled snapshot does not parse; a unit test parses it, so
    /// a build that passed its tests never panics here.
    pub fn snapshot() -> Arc<Catalog> {
        static SNAPSHOT_CATALOG: OnceLock<Arc<Catalog>> = OnceLock::new();
        SNAPSHOT_CATALOG
            .get_or_init(|| {
                #[allow(clippy::panic)]
                let meta: Meta = serde_json::from_str(SNAPSHOT_META)
                    .unwrap_or_else(|error| panic!("catalog/models-dev.meta.json: {error}"));
                #[allow(clippy::panic)]
                let catalog = Catalog::read(SNAPSHOT, meta, CatalogSource::Snapshot)
                    .unwrap_or_else(|error| panic!("catalog/models-dev.json: {error}"));
                Arc::new(catalog)
            })
            .clone()
    }

    /// Reads data in models.dev's shape. Fails only when it is not a JSON
    /// object; anything inside that does not read is left out, or offered
    /// with safe defaults.
    pub fn read(json: &str, meta: Meta, source: CatalogSource) -> Result<Catalog, String> {
        let (data, skipped) =
            RigCatalog::from_models_dev(json).map_err(|error| error.to_string())?;
        let unread: HashSet<String> = skipped
            .into_iter()
            .filter(|skip| matches!(skip.reason, SkipReason::Invalid(_)))
            .map(|skip| skip.path)
            .collect();
        let loose = if unread.is_empty() {
            Vec::new()
        } else {
            listing::loose_rows(json, &unread)
        };
        Ok(Catalog {
            facts: RigCatalog::builtin().with_models_dev(&data),
            data,
            loose,
            meta,
            source,
        })
    }

    pub fn meta(&self) -> &Meta {
        &self.meta
    }

    pub fn source(&self) -> CatalogSource {
        self.source
    }

    /// Every provider [`crate::connect`] serves, with its models.
    pub fn providers(&self) -> Vec<ProviderInfo> {
        ProviderKind::ALL
            .into_iter()
            .map(|kind| self.provider(kind))
            .collect()
    }

    pub fn provider(&self, kind: ProviderKind) -> ProviderInfo {
        listing::provider(self, kind)
    }

    /// Whether `model` reads images, as its provider lists it (a dated
    /// snapshot as its model). A model listed nowhere, such as an
    /// OpenAI-compatible server's own, is taken not to.
    pub fn reads_images(&self, model: &ModelRef) -> bool {
        let Some(kind) = ProviderKind::from_id(&model.provider) else {
            return false;
        };
        let id = model.model.as_str();
        let base = listing::snapshot_of(id);
        self.provider(kind)
            .models
            .iter()
            .any(|info| info.images && (info.id == id || Some(info.id.as_str()) == base))
    }

    /// The list a client is given.
    pub fn listing(&self, refresh_error: Option<String>) -> ModelCatalog {
        ModelCatalog {
            providers: self.providers(),
            source: self.source,
            fetched_at_ms: self.meta.fetched_at_ms,
            refresh_error,
        }
    }

    /// The facts of `model` as the provider of `kind` serves it, under
    /// Rig's `vendor` (the wire's descriptor name): Rig's own row for that
    /// vendor, else the row of the vendor whose models the provider
    /// offers (a subscription's), re-filed under `vendor`. `None` for a
    /// model listed nowhere: the wire then uses its defaults.
    pub(crate) fn spec(&self, kind: ProviderKind, vendor: &str, model: &str) -> Option<ModelSpec> {
        let provider = ProviderId::catalog(vendor)?;
        if let Some(found) = self.facts.get(provider, model) {
            return Some(found.spec.clone());
        }
        sources::source(kind).data_vendors().find_map(|other| {
            let other = ProviderId::catalog(other)?;
            let mut spec = self.facts.get(other, model)?.spec.clone();
            spec.provider = provider;
            Some(spec)
        })
    }

    /// What the wire of `vendor` encodes `model` with and prices it by.
    pub(crate) fn facts(&self, kind: ProviderKind, vendor: &str, model: &str) -> ModelFacts {
        match self.spec(kind, vendor, model) {
            Some(spec) => ModelFacts::new(spec).with_catalog(&self.facts),
            None => ModelFacts::default().with_catalog(&self.facts),
        }
    }

    fn data_specs<'a>(&'a self, vendor: &'a str) -> impl Iterator<Item = &'a ModelSpec> + 'a {
        self.data
            .iter()
            .filter(move |spec| spec.provider.vendor() == vendor)
    }

    fn fact_of(&self, vendor: &str, model: &str) -> Option<&ModelSpec> {
        let provider = ProviderId::catalog(vendor)?;
        self.facts.get_exact(provider, model)
    }
}

/// The snapshot's providers: what `blame-engine catalog` printed before the
/// engine fetched anything.
pub fn providers() -> Vec<ProviderInfo> {
    Catalog::snapshot().providers()
}

#[cfg(test)]
mod tests;
