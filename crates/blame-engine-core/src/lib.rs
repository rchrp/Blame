//! The agent loop of the Blame engine.
//!
//! This crate decides *what happens next* in a session: which request to
//! send, which tools to run, what to do after a crash. It performs no I/O
//! itself. Storage, model providers, tools and workspace snapshots are reached
//! through the traits in [`ports`], so the same loop runs on a laptop, in the
//! runtime VM and in the cloud, and runs in tests against in-memory fakes with
//! no network and no clock.
//!
//! - [`projection`] folds a log into what is in effect: the configuration,
//!   the open turns and the exact messages of the next request.
//! - [`Session`] runs one session: commands in, records and deltas out.

mod digest;
mod error;
pub mod policy;
pub mod ports;
pub mod projection;
mod race;
mod session;

pub use error::EngineError;
pub use policy::{
    CompactionOptions, ContextPolicy, EngineOptions, NoContextEdits, RecoveryPolicy, RetryPolicy,
    WatchdogOptions,
};
pub use session::{NOTICE_CHECKPOINT_FAILED, Ports, Session, SessionEvent, Subscription};
