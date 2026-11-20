//! The catalog in use, kept fresh from models.dev without ever making a
//! turn wait for the network.
//!
//! - **Start**: the copy in the cache directory if it is newer than the
//!   snapshot compiled in, else the snapshot. Nothing is fetched to start.
//! - **Refresh**: a conditional `GET` (`If-None-Match` with the copy's
//!   `ETag`; models.dev answers `304` when nothing changed, and gzips the
//!   body when it did). The new copy is cut to the served providers, read,
//!   checked, written to the cache directory, then swapped in. A refresh
//!   that fails keeps the last copy that loaded and says why.
//! - **When**: in the background when the engine starts and when a client
//!   lists a copy older than [`RefreshOptions::ttl`]; on demand when a
//!   client asks (`catalog/list { refresh: true }`, at most once per
//!   [`RefreshOptions::min_interval`]) or with `blame-engine catalog
//!   --refresh`. One refresh at a time.
//!
//! The request names nothing about the user, the machine or the project.

use super::sources::MODELS_DEV_KEYS;
use super::{Catalog, CatalogSource, Meta, ModelCatalog};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const MODELS_DEV_URL: &str = "https://models.dev/api.json";

/// The largest body accepted: `api.json` is about 7 MB today.
const MAX_BODY: usize = 64 * 1024 * 1024;

const DATA_FILE: &str = "models-dev.json";
const META_FILE: &str = "models-dev.meta.json";

#[derive(Clone, Debug)]
pub struct RefreshOptions {
    pub url: String,
    /// A copy checked longer ago than this is revalidated in the
    /// background when a client lists it.
    pub ttl: Duration,
    /// A refresh a client asks for within this of the last check answers
    /// from that check: a selector opened ten times sends one request.
    pub min_interval: Duration,
    /// How long the whole request may take.
    pub timeout: Duration,
}

impl Default for RefreshOptions {
    fn default() -> Self {
        Self {
            url: MODELS_DEV_URL.to_owned(),
            ttl: Duration::from_secs(15 * 60),
            min_interval: Duration::from_secs(30),
            timeout: Duration::from_secs(20),
        }
    }
}

/// What a refresh did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refreshed {
    /// models.dev has nothing newer.
    Unchanged,
    /// A new copy is in use.
    Updated,
    /// Checked too recently to ask again.
    Skipped,
}

#[derive(Debug)]
pub struct LiveCatalog {
    current: RwLock<Arc<Catalog>>,
    /// Where fetched copies are kept; `None` keeps them in memory only.
    dir: Option<PathBuf>,
    options: RefreshOptions,
    state: Mutex<State>,
    /// One refresh at a time.
    refreshing: tokio::sync::Mutex<()>,
}

#[derive(Debug, Default)]
struct State {
    checked: Option<Instant>,
    error: Option<String>,
}

impl Default for LiveCatalog {
    /// The snapshot, kept in memory only.
    fn default() -> Self {
        Self::new(Catalog::snapshot(), None, RefreshOptions::default())
    }
}

impl LiveCatalog {
    fn new(catalog: Arc<Catalog>, dir: Option<PathBuf>, options: RefreshOptions) -> Self {
        Self {
            current: RwLock::new(catalog),
            dir,
            options,
            state: Mutex::new(State::default()),
            refreshing: tokio::sync::Mutex::new(()),
        }
    }

    /// The newest of the snapshot and the copy kept in `dir`. A copy that
    /// does not read is ignored (and replaced by the next refresh).
    pub fn open(dir: Option<PathBuf>, options: RefreshOptions) -> Self {
        let snapshot = Catalog::snapshot();
        let cached = dir.as_deref().and_then(read_cache);
        let catalog = match cached {
            Some(cached) if cached.meta().fetched_at_ms > snapshot.meta().fetched_at_ms => {
                Arc::new(cached)
            }
            _ => snapshot,
        };
        Self::new(catalog, dir, options)
    }

    /// The copy in use now. A request keeps the one it started with.
    pub fn current(&self) -> Arc<Catalog> {
        self.current
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    pub fn listing(&self) -> ModelCatalog {
        let error = self.state().error.clone();
        self.current().listing(error)
    }

    /// Whether the copy has not been checked within the time to live.
    pub fn is_stale(&self) -> bool {
        self.state()
            .checked
            .is_none_or(|at| at.elapsed() >= self.options.ttl)
    }

    /// Revalidates in the background when the copy is stale; returns at
    /// once. Needs a tokio runtime.
    pub fn refresh_if_stale(self: &Arc<Self>) {
        if !self.is_stale() || self.refreshing.try_lock().is_err() {
            return;
        }
        let live = Arc::clone(self);
        tokio::spawn(async move {
            let _ = live.refresh(false).await;
        });
    }

    /// Asks models.dev for a newer copy. Without `force`, answers from the
    /// last check when it is more recent than `min_interval`.
    pub async fn refresh(&self, force: bool) -> Result<Refreshed, String> {
        let _one = self.refreshing.lock().await;
        if !force
            && self
                .state()
                .checked
                .is_some_and(|at| at.elapsed() < self.options.min_interval)
        {
            return Ok(Refreshed::Skipped);
        }
        let result = self.fetch().await;
        let mut state = self.state();
        match &result {
            Ok(_) => {
                state.checked = Some(Instant::now());
                state.error = None;
            }
            Err(error) => state.error = Some(error.clone()),
        }
        result
    }

    async fn fetch(&self) -> Result<Refreshed, String> {
        let current = self.current();
        let etag = current.meta().etag.clone();
        let fetched = fetch(&self.options, etag.as_deref()).await?;
        let Some((body, etag)) = fetched else {
            return Ok(Refreshed::Unchanged);
        };
        let data = served_sections(&body)?;
        let meta = Meta {
            fetched_at_ms: now_ms(),
            etag,
        };
        let catalog = Catalog::read(&data, meta, CatalogSource::ModelsDev)?;
        if catalog
            .providers()
            .iter()
            .all(|provider| provider.models.is_empty())
        {
            return Err("models.dev sent no model of a served provider".to_owned());
        }
        if let Some(dir) = &self.dir {
            write_cache(dir, &data, catalog.meta()).map_err(|error| {
                format!("cannot keep the catalog in {}: {error}", dir.display())
            })?;
        }
        *self.current.write().unwrap_or_else(PoisonError::into_inner) = Arc::new(catalog);
        Ok(Refreshed::Updated)
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// `None` when models.dev answered `304 Not Modified`; otherwise the body
/// and its `ETag`.
async fn fetch(
    options: &RefreshOptions,
    etag: Option<&str>,
) -> Result<Option<(Vec<u8>, Option<String>)>, String> {
    use rig_reqwest::reqwest;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(options.timeout)
        .user_agent(concat!("blame-engine/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| format!("cannot reach models.dev: {error}"))?;
    let mut request = client.get(&options.url);
    if let Some(etag) = etag {
        request = request.header(reqwest::header::IF_NONE_MATCH, etag);
    }
    let failed = |error: reqwest::Error| format!("models.dev did not answer: {error}");
    let mut response = request.send().await.map_err(failed)?;
    let status = response.status();
    if status == reqwest::StatusCode::NOT_MODIFIED {
        return Ok(None);
    }
    if !status.is_success() {
        return Err(format!("models.dev answered {status}"));
    }
    let etag = response
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(failed)? {
        if body.len() + chunk.len() > MAX_BODY {
            return Err("models.dev sent more than 64 MB".to_owned());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(Some((body, etag)))
}

/// `api.json` cut to [`MODELS_DEV_KEYS`], each section kept as sent.
fn served_sections(body: &[u8]) -> Result<String, String> {
    use serde_json::value::RawValue;
    let sections: std::collections::HashMap<&str, &RawValue> = serde_json::from_slice(body)
        .map_err(|error| format!("models.dev sent something that is not its catalog: {error}"))?;
    let mut out = String::from("{");
    for key in MODELS_DEV_KEYS {
        if let Some(section) = sections.get(key) {
            if out.len() > 1 {
                out.push(',');
            }
            out.push_str(&serde_json::to_string(key).unwrap_or_default());
            out.push(':');
            out.push_str(section.get());
        }
    }
    out.push('}');
    Ok(out)
}

fn read_cache(dir: &Path) -> Option<Catalog> {
    let data = std::fs::read_to_string(dir.join(DATA_FILE)).ok()?;
    let meta: Meta =
        serde_json::from_str(&std::fs::read_to_string(dir.join(META_FILE)).ok()?).ok()?;
    Catalog::read(&data, meta, CatalogSource::ModelsDev).ok()
}

/// Writes the data, then its meta, each through a rename: a crash leaves
/// either the old copy or the new data with an older `ETag`, which the next
/// request simply replaces.
fn write_cache(dir: &Path, data: &str, meta: &Meta) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    replace(&dir.join(DATA_FILE), data.as_bytes())?;
    let mut text = serde_json::to_string_pretty(meta).map_err(std::io::Error::other)?;
    text.push('\n');
    replace(&dir.join(META_FILE), text.as_bytes())
}

fn replace(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let partial = path.with_extension("partial");
    std::fs::write(&partial, bytes)?;
    std::fs::rename(&partial, path)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| {
            u64::try_from(since.as_millis()).unwrap_or(u64::MAX)
        })
}
