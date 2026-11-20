//! Blame's Light Semantic Harness in Rust: the code tools a model works with,
//! independent of the agent engine. See `README.md`.
//!
//! Layers, from the disk up: `files` (paths, snapshots, revisions),
//! `journal`/`coverage`/`attention`/`aliases` (session state), `syntax`/
//! `languages`/`fold`/`navigation` (code intelligence), `lexical`/`search`
//! (search_code), `workspace` (read_code and the session), `edit` and its
//! modules (edit_code), `run` (run_task), `turn` (one session's operations
//! taking turns), `checks`/`finish` (check reports and finish_task),
//! `tools`/`validate`/`present` (the model-facing surface),
//! `harness`/`server` (execution).

pub mod aliases;
pub mod ask;
pub mod attention;
pub mod base64;
pub mod checks;
pub mod cline_patch;
pub mod commit;
pub mod compiler;
pub mod coverage;
pub mod diff;
pub mod edit;
pub mod failure;
pub mod files;
pub mod finish;
pub mod fold;
pub mod harness;
pub mod identity;
pub mod journal;
pub mod json;
pub mod languages;
pub mod lexical;
pub mod lock;
pub mod navigation;
pub mod patch;
pub mod pathx;
pub mod platform;
pub mod present;
pub mod read_results;
pub mod run;
pub mod search;
pub mod search_results;
pub mod server;
pub mod symbol_edit;
pub mod syntax;
pub mod text;
pub mod tools;
pub mod turn;
pub mod validate;
pub mod validation;
pub mod workspace;
