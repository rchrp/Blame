//! The agent loop of the Blame engine.
//!
//! This crate decides *what happens next* in a session: which request to
//! send, which tools to run, what to do after a crash. It performs no I/O
//! itself. Storage, model providers, tools and workspace snapshots are reached
//! through the traits in [`ports`], so the same loop runs on a laptop, in the
//! runtime VM and in the cloud, and runs in tests against in-memory fakes with
//! no network and no clock.

pub mod ports;
