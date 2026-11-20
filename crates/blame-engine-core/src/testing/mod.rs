//! Fakes of every port, for this crate's tests and the binary's.
//!
//! They are deterministic and in memory: no network, no disk, no real time.
//! [`World`] wires them into [`crate::Ports`] the way most tests want.

mod clock;
mod provider;
mod store;
mod tools;

pub use clock::ManualClock;
pub use provider::{Script, ScriptedProvider, Step};
pub use store::MemoryStore;
pub use tools::{Behavior, ScriptedTools, ToolLog, Workspace, spec, standard_specs};

use crate::policy::NoContextEdits;
use crate::ports::{
    ApprovalRequest, Approver, CheckpointError, Checkpointer, IdSource, PathChange, PathChangeKind,
};
use crate::session::Ports;
use async_trait::async_trait;
use blame_engine_protocol::{
    ApprovalDecision, ModelRef, ReasoningEffort, SessionConfig, SessionId,
};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

/// Ids `prefix-1`, `prefix-2`… from one counter. Share one source across
/// engine restarts in a test, as a real source never repeats an id.
#[derive(Clone, Default)]
pub struct CountingIds {
    next: Arc<AtomicU64>,
}

impl CountingIds {
    pub fn new() -> Self {
        Self::default()
    }
}

impl IdSource for CountingIds {
    fn next(&self, prefix: &str) -> String {
        format!("{prefix}-{}", self.next.fetch_add(1, Ordering::Relaxed) + 1)
    }
}

/// What the recording checkpointer was asked to do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CheckpointCall {
    Snapshot(String),
    Restore(String),
    Release,
}

/// Snapshots a [`Workspace`] by copying it, and records every call.
#[derive(Clone, Default)]
pub struct RecordingCheckpointer {
    workspace: Workspace,
    inner: Arc<Mutex<CheckpointState>>,
}

#[derive(Default)]
struct CheckpointState {
    snapshots: HashMap<String, BTreeMap<String, String>>,
    calls: Vec<CheckpointCall>,
    fail_snapshots: u32,
    next: u64,
}

impl RecordingCheckpointer {
    pub fn new(workspace: Workspace) -> Self {
        Self {
            workspace,
            inner: Arc::default(),
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, CheckpointState> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn calls(&self) -> Vec<CheckpointCall> {
        self.state().calls.clone()
    }

    /// The next `count` snapshots fail.
    pub fn fail_snapshots(&self, count: u32) {
        self.state().fail_snapshots = count;
    }

    fn files(&self) -> BTreeMap<String, String> {
        self.workspace
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
}

#[async_trait]
impl Checkpointer for RecordingCheckpointer {
    async fn snapshot(
        &self,
        _root: &Path,
        _session: &SessionId,
    ) -> Result<String, CheckpointError> {
        let files = self.files();
        let mut state = self.state();
        if state.fail_snapshots > 0 {
            state.fail_snapshots -= 1;
            return Err(CheckpointError::Failed("scripted failure".into()));
        }
        state.next += 1;
        let id = format!("snap-{}", state.next);
        state.snapshots.insert(id.clone(), files);
        state.calls.push(CheckpointCall::Snapshot(id.clone()));
        Ok(id)
    }

    async fn restore(&self, _root: &Path, snapshot: &str) -> Result<(), CheckpointError> {
        let mut state = self.state();
        state.calls.push(CheckpointCall::Restore(snapshot.into()));
        let files = state
            .snapshots
            .get(snapshot)
            .cloned()
            .ok_or_else(|| CheckpointError::MissingSnapshot(snapshot.into()))?;
        drop(state);
        *self
            .workspace
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = files;
        Ok(())
    }

    async fn changes(
        &self,
        _root: &Path,
        from: &str,
        to: Option<&str>,
    ) -> Result<Vec<PathChange>, CheckpointError> {
        let state = self.state();
        let before = state
            .snapshots
            .get(from)
            .cloned()
            .ok_or_else(|| CheckpointError::MissingSnapshot(from.into()))?;
        let after = match to {
            Some(to) => state
                .snapshots
                .get(to)
                .cloned()
                .ok_or_else(|| CheckpointError::MissingSnapshot(to.into()))?,
            None => self.files(),
        };
        let mut changes = Vec::new();
        for (path, text) in &after {
            match before.get(path) {
                None => changes.push((path, PathChangeKind::Added)),
                Some(old) if old != text => changes.push((path, PathChangeKind::Modified)),
                Some(_) => {}
            }
        }
        for path in before.keys().filter(|path| !after.contains_key(*path)) {
            changes.push((path, PathChangeKind::Deleted));
        }
        changes.sort_by(|a, b| a.0.cmp(b.0));
        Ok(changes
            .into_iter()
            .map(|(path, kind)| PathChange {
                path: path.clone(),
                kind,
            })
            .collect())
    }

    async fn release(&self, _root: &Path, _session: &SessionId) -> Result<(), CheckpointError> {
        self.state().calls.push(CheckpointCall::Release);
        Ok(())
    }
}

/// Answers approvals from a queue, then with a default.
#[derive(Clone)]
pub struct ScriptedApprover {
    inner: Arc<Mutex<ApproverState>>,
}

struct ApproverState {
    queue: VecDeque<Option<ApprovalDecision>>,
    default: Option<ApprovalDecision>,
    requests: Vec<ApprovalRequest>,
}

impl ScriptedApprover {
    /// `None` as the default leaves every unqueued question unanswered, as a
    /// user away from the screen would.
    pub fn new(default: Option<ApprovalDecision>) -> Self {
        Self {
            inner: Arc::new(Mutex::new(ApproverState {
                queue: VecDeque::new(),
                default,
                requests: Vec::new(),
            })),
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, ApproverState> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn push(&self, decision: Option<ApprovalDecision>) {
        self.state().queue.push_back(decision);
    }

    pub fn requests(&self) -> Vec<ApprovalRequest> {
        self.state().requests.clone()
    }
}

#[async_trait]
impl Approver for ScriptedApprover {
    async fn approve(&self, request: ApprovalRequest) -> ApprovalDecision {
        let decision = {
            let mut state = self.state();
            state.requests.push(request);
            let default = state.default;
            state.queue.pop_front().unwrap_or(default)
        };
        match decision {
            Some(decision) => decision,
            None => std::future::pending().await,
        }
    }
}

/// A complete set of fakes. Clones share everything, so a second `ports()`
/// after a "crash" reaches the same store, workspace and tool log.
#[derive(Clone)]
pub struct World {
    pub store: MemoryStore,
    pub provider: ScriptedProvider,
    pub tools: ScriptedTools,
    pub checkpointer: RecordingCheckpointer,
    pub approver: ScriptedApprover,
    pub clock: ManualClock,
    pub ids: CountingIds,
}

impl World {
    pub fn new(provider: ScriptedProvider) -> Self {
        let clock = ManualClock::new();
        let tools = ScriptedTools::standard();
        Self {
            store: MemoryStore::with_clock(Arc::new(clock.clone())),
            checkpointer: RecordingCheckpointer::new(tools.workspace()),
            provider: provider.with_clock(clock.clone()),
            tools,
            approver: ScriptedApprover::new(Some(ApprovalDecision::Approved)),
            clock,
            ids: CountingIds::new(),
        }
    }

    pub fn with_tools(mut self, tools: ScriptedTools) -> Self {
        let tools = tools.with_workspace(self.tools.workspace());
        self.tools = tools;
        self
    }

    pub fn ports(&self) -> Ports {
        Ports {
            store: Arc::new(self.store.clone()),
            provider: Arc::new(self.provider.clone()),
            tools: Arc::new(self.tools.clone()),
            checkpointer: Arc::new(self.checkpointer.clone()),
            approver: Arc::new(self.approver.clone()),
            clock: Arc::new(self.clock.clone()),
            ids: Arc::new(self.ids.clone()),
            context_policy: Arc::new(NoContextEdits),
        }
    }

    pub fn files(&self) -> BTreeMap<String, String> {
        self.tools
            .workspace()
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
}

/// A configuration for tests: checkpoints on, a pretend model.
pub fn config() -> SessionConfig {
    SessionConfig {
        purpose: "development".into(),
        workspace_root: "/work".into(),
        model: ModelRef {
            provider: "fake".into(),
            model: "fake-1".into(),
        },
        reasoning: Some(ReasoningEffort::Medium),
        system_prompt: "You are a test agent.".into(),
        max_output_tokens: Some(1000),
        engine_tools: vec!["harness".into()],
        client_tools: Vec::new(),
        tool_options: Default::default(),
        limits: Default::default(),
        checkpoints: true,
        kind: Default::default(),
        contract: None,
    }
}
