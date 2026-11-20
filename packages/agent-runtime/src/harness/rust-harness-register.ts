import { register } from "node:module";

// `node --import ./dist/harness/rust-harness-register.js --test ...` runs the
// harness tests against the Rust harness (see rust-harness-adapter.ts).
register("./rust-harness-hooks.js", import.meta.url);
