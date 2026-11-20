//! `blame-engine catalog`: the list `catalog/list` returns, on stdout.
//!
//! ```text
//! blame-engine catalog [--cache-dir DIR] [--refresh] [--catalog-url URL]
//! ```
//!
//! Without `--cache-dir` it reads the snapshot compiled in. `--refresh`
//! asks models.dev first and fails when that fails; with `--cache-dir` the
//! copy fetched is kept there, in the files the engine keeps in
//! `<data-dir>/catalog` (`scripts/refresh-model-catalog.sh` refreshes the
//! snapshot this way).

use crate::options;
use blame_engine_providers::catalog::{LiveCatalog, RefreshOptions};
use std::path::PathBuf;

pub struct Print {
    cache_dir: Option<PathBuf>,
    refresh: bool,
    options: RefreshOptions,
}

impl Print {
    pub fn parse(args: &[&str]) -> Result<Self, String> {
        let mut print = Self {
            cache_dir: None,
            refresh: false,
            options: RefreshOptions::default(),
        };
        for (name, value) in options(args, &["--cache-dir", "--catalog-url"], &["--refresh"])? {
            match (name.as_str(), value) {
                ("--cache-dir", Some(dir)) => print.cache_dir = Some(PathBuf::from(dir)),
                ("--catalog-url", Some(url)) => print.options.url = url.to_owned(),
                ("--refresh", _) => print.refresh = true,
                _ => unreachable!("only known options are returned"),
            }
        }
        Ok(print)
    }

    pub async fn run(self) -> Result<(), String> {
        let catalog = LiveCatalog::open(self.cache_dir, self.options);
        if self.refresh {
            catalog.refresh(true).await?;
        }
        crate::print_json(&catalog.listing())
    }
}
