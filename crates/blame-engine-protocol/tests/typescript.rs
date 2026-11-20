//! The TypeScript client types are generated, never edited: this fails when
//! the committed file is not what the Rust types produce.

#![cfg(feature = "ts")]

use std::path::Path;

/// Where `packages/engine-client` keeps the generated declarations.
const COMMITTED: &str = "../../packages/engine-client/src/generated/protocol.ts";

#[test]
fn the_committed_typescript_matches_the_rust_types() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(COMMITTED);
    let committed = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()));
    assert!(
        committed == blame_engine_protocol::typescript::declarations(),
        "{} is out of date: run `pnpm --filter @blame/engine-client generate`",
        path.display()
    );
}
