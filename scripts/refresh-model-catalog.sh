#!/bin/sh
# Refreshes the models.dev snapshot compiled into blame-engine
# (crates/blame-engine-providers/catalog/), the catalog an engine lists until
# it has fetched one itself: on its first start, or offline. The engine keeps
# itself up to date at run time; this only keeps the fallback recent. Run it
# when you like and commit the two files; the build itself never reaches the
# network.
set -eu
cd "$(dirname "$0")/.."
if ! command -v cargo >/dev/null 2>&1 && [ -f "$HOME/.cargo/env" ]; then
  . "$HOME/.cargo/env"
fi
cargo run --quiet -p blame-engine -- catalog \
  --cache-dir crates/blame-engine-providers/catalog --refresh >/dev/null
ls -l crates/blame-engine-providers/catalog
