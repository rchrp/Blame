//! The tools of one session, behind the core's single `ToolHost`: the
//! harness (when `engine_tools` names it) runs next to the workspace, the
//! client's tools are sent to the client.

mod client;
mod harness;

pub use harness::{Harness, HarnessCommand};

use crate::connection::Host;
use crate::log::log;
use async_trait::async_trait;
use blame_engine_core::ports::{
    InterruptedCall, SessionStore, ToolHost, ToolInvocation, ToolOutput, ToolProgress,
};
use blame_engine_protocol::{SessionConfig, SessionId, ToolSpec};
use serde_json::Value;
use std::collections::HashSet;
use std::sync::{Arc, Mutex, PoisonError};
use tokio_util::sync::CancellationToken;

/// The name of the harness in `SessionConfig::engine_tools` and
/// `SessionConfig::tool_options`.
pub const HARNESS: &str = "harness";

/// What every session's router shares.
#[derive(Clone)]
pub struct ToolShared {
    pub host: Arc<Host>,
    pub harness: Option<Arc<Harness>>,
    pub store: Arc<dyn SessionStore>,
}

/// One session's tools. The core asks for the specs when the session opens
/// and whenever its configuration changes; the router remembers from that
/// answer which tool goes where and the harness settings to call it with.
pub struct SessionTools {
    session: SessionId,
    shared: ToolShared,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    /// Names served by the harness for the configuration in effect.
    harness_tools: HashSet<String>,
    /// `tool_options.harness`, with the session id filled in.
    harness_options: Value,
}

impl SessionTools {
    pub fn new(session: SessionId, shared: ToolShared) -> Self {
        Self {
            session,
            shared,
            state: Mutex::new(State::default()),
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn harness_options(&self, config: &SessionConfig) -> Value {
        let mut options = config
            .tool_options
            .get(HARNESS)
            .cloned()
            .filter(Value::is_object)
            .unwrap_or_else(|| Value::Object(Default::default()));
        // The harness keys its journal and its caches by session.
        let contract = options
            .as_object_mut()
            .expect("an object")
            .entry("taskContract")
            .or_insert_with(|| Value::Object(Default::default()));
        if let Some(contract) = contract.as_object_mut() {
            contract
                .entry("session_id")
                .or_insert_with(|| Value::String(self.session.0.clone()));
        }
        options
    }
}

#[async_trait]
impl ToolHost for SessionTools {
    async fn specs(&self, config: &SessionConfig) -> Vec<ToolSpec> {
        let mut specs = Vec::new();
        let mut harness_tools = HashSet::new();
        let options = self.harness_options(config);
        for name in &config.engine_tools {
            match (name.as_str(), &self.shared.harness) {
                (HARNESS, Some(harness)) => match harness.describe(&options).await {
                    Ok(described) => {
                        harness_tools.extend(described.iter().map(|spec| spec.name.clone()));
                        specs.extend(described);
                    }
                    Err(error) => log!(
                        Error,
                        "session {}: the harness tools are unavailable: {error}",
                        self.session
                    ),
                },
                (HARNESS, None) => log!(
                    Error,
                    "session {} asks for the harness, but no --harness-command was given",
                    self.session
                ),
                // Served by the engine's core, which offers and answers it.
                (blame_engine_core::plan::TOOL_SET, _) => {}
                (other, _) => log!(
                    Warn,
                    "session {}: unknown engine tool set `{other}`",
                    self.session
                ),
            }
        }
        for spec in &config.client_tools {
            if harness_tools.contains(&spec.name) {
                log!(
                    Warn,
                    "session {}: client tool `{}` is shadowed by the harness tool of that name",
                    self.session,
                    spec.name
                );
                continue;
            }
            specs.push(spec.clone());
        }
        let mut state = self.state();
        state.harness_tools = harness_tools;
        state.harness_options = options;
        specs
    }

    async fn call(
        &self,
        invocation: ToolInvocation,
        progress: ToolProgress,
        cancel: CancellationToken,
    ) -> ToolOutput {
        let harness = {
            let state = self.state();
            state
                .harness_tools
                .contains(&invocation.name)
                .then(|| state.harness_options.clone())
        };
        match (harness, &self.shared.harness) {
            (Some(options), Some(host)) => {
                host.call(&invocation, &options, &*self.shared.store, cancel)
                    .await
            }
            _ => client::call(&self.shared.host, invocation, progress, cancel).await,
        }
    }

    async fn interrupted(&self, invocation: &ToolInvocation) -> InterruptedCall {
        if self.state().harness_tools.contains(&invocation.name) {
            return harness::interrupted(&invocation.name);
        }
        // Whatever the client did with it, nobody here can tell.
        InterruptedCall::Unknown
    }
}
