//! Model providers.
//!
//! Implements the core's `ModelProvider` for each supported provider. The
//! client library used to reach them (Rig, pinned to one exact version) is
//! an implementation detail of this crate: none of its types appear in the
//! public API, in stored sessions or on the wire. What a provider returned
//! verbatim (thinking signatures, encrypted reasoning, thought signatures)
//! is stored as the provider's own JSON and replayed only to the model that
//! produced it.
//!
//! - [`connect`] turns a provider id and a credential into a [`Provider`].
//! - [`catalog`] lists the providers and models offered to the user.
//! - [`chatgpt`] signs in to a ChatGPT subscription, on the user's machine.

pub mod catalog;
pub mod chatgpt;
mod error;
mod native;
mod registry;
mod request;
mod stream;
mod wire;

pub use registry::{Options, Provider, ProviderKind, connect};
