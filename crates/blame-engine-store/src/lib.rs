//! Durable storage for session logs.
//!
//! Implements the core's `SessionStore` on an embedded SQLite database that
//! lives on the machine the engine runs on, and replicates it to a
//! `RemoteLog` in the background so a session can be reopened elsewhere.
