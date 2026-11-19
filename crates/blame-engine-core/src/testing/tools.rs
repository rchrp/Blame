use crate::ports::{InterruptedCall, ToolHost, ToolInvocation, ToolOutput, ToolProgress};
use async_trait::async_trait;
use blame_engine_protocol::{SessionConfig, ToolCallId, ToolEffect, ToolOutcome, ToolSpec};
use serde_json::json;
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, PoisonError};
use tokio_util::sync::CancellationToken;

/// Files of a pretend workspace, shared by the scripted tools that write
/// them and the recording checkpointer that snapshots them.
pub type Workspace = Arc<Mutex<BTreeMap<String, String>>>;

/// What a scripted tool does when called.
#[derive(Clone, Debug)]
pub enum Behavior {
    Output(ToolOutput),
    /// Sends `progress`, then returns the output.
    Progress(Vec<String>, ToolOutput),
    /// Runs until cancelled, then reports `Cancelled`.
    UntilCancelled,
    /// Yields to the runtime a few times before returning, so calls that
    /// run side by side overlap.
    Slow(ToolOutput),
    /// Waits for the gate to open (or the call to be cancelled).
    Gated(Arc<tokio::sync::Notify>, ToolOutput),
}

type Handler = dyn Fn(&ToolInvocation, &Workspace) -> Behavior + Send + Sync;

/// Tools defined by the test. Clones share the execution log, which lives as
/// long as "the world" does: across engine restarts in a crash test.
#[derive(Clone)]
pub struct ScriptedTools {
    specs: Vec<ToolSpec>,
    handler: Arc<Handler>,
    workspace: Workspace,
    log: Arc<Mutex<ToolLog>>,
}

#[derive(Default, Debug, Clone)]
pub struct ToolLog {
    /// Every call that ran, in the order it started.
    pub executions: Vec<ToolInvocation>,
    /// Calls that were asked about after a crash, with the answer given.
    pub interrupted: Vec<(ToolCallId, InterruptedCall)>,
    /// Calls running right now, and the most that ever ran at once.
    pub running: usize,
    pub max_running: usize,
}

impl ScriptedTools {
    pub fn new(
        specs: Vec<ToolSpec>,
        handler: impl Fn(&ToolInvocation, &Workspace) -> Behavior + Send + Sync + 'static,
    ) -> Self {
        Self {
            specs,
            handler: Arc::new(handler),
            workspace: Workspace::default(),
            log: Arc::default(),
        }
    }

    /// The usual coding tools on a pretend workspace: `read` (input `path`),
    /// `write` (`path`, `text`), `run` (`command`), `finish` (ends the turn)
    /// and `deploy` (needs approval).
    pub fn standard() -> Self {
        Self::new(standard_specs(), |invocation, workspace| {
            let input = &invocation.input;
            let path = input["path"].as_str().unwrap_or_default().to_owned();
            let mut files = workspace.lock().unwrap_or_else(PoisonError::into_inner);
            Behavior::Output(match invocation.name.as_str() {
                "read" => match files.get(&path) {
                    Some(text) => ToolOutput::text(ToolOutcome::Completed, text.clone()),
                    None => ToolOutput::text(ToolOutcome::Failed, format!("{path}: not found")),
                },
                "write" => {
                    let text = input["text"].as_str().unwrap_or_default().to_owned();
                    files.insert(path.clone(), text);
                    ToolOutput::text(ToolOutcome::Completed, format!("wrote {path}"))
                }
                "run" => ToolOutput::text(
                    ToolOutcome::Completed,
                    format!("ran {}", input["command"].as_str().unwrap_or_default()),
                ),
                "finish" => ToolOutput::text(ToolOutcome::Completed, "done"),
                "deploy" => ToolOutput::text(ToolOutcome::Completed, "deployed"),
                other => ToolOutput::text(ToolOutcome::Failed, format!("no tool {other}")),
            })
        })
    }

    pub fn workspace(&self) -> Workspace {
        self.workspace.clone()
    }

    /// Uses `workspace` instead of a fresh one, to share it with a checkpointer.
    pub fn with_workspace(mut self, workspace: Workspace) -> Self {
        self.workspace = workspace;
        self
    }

    pub fn log(&self) -> ToolLog {
        self.log
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// How many times each call ran.
    pub fn runs(&self) -> HashMap<ToolCallId, usize> {
        let mut runs = HashMap::new();
        for invocation in self.log().executions {
            *runs.entry(invocation.call).or_default() += 1;
        }
        runs
    }

    pub fn effect_of(&self, name: &str) -> Option<ToolEffect> {
        self.specs.iter().find(|s| s.name == name).map(|s| s.effect)
    }
}

pub fn spec(name: &str, effect: ToolEffect) -> ToolSpec {
    ToolSpec {
        name: name.into(),
        description: format!("The {name} tool."),
        input_schema: json!({ "type": "object" }),
        effect,
        ends_turn: false,
        needs_approval: false,
    }
}

pub fn standard_specs() -> Vec<ToolSpec> {
    vec![
        spec("read", ToolEffect::ReadOnly),
        spec("write", ToolEffect::WorkspaceWrite),
        spec("run", ToolEffect::Command),
        ToolSpec {
            ends_turn: true,
            ..spec("finish", ToolEffect::ReadOnly)
        },
        ToolSpec {
            needs_approval: true,
            ..spec("deploy", ToolEffect::External)
        },
    ]
}

#[async_trait]
impl ToolHost for ScriptedTools {
    async fn specs(&self, _config: &SessionConfig) -> Vec<ToolSpec> {
        self.specs.clone()
    }

    async fn call(
        &self,
        invocation: ToolInvocation,
        progress: ToolProgress,
        cancel: CancellationToken,
    ) -> ToolOutput {
        {
            let mut log = self.log.lock().unwrap_or_else(PoisonError::into_inner);
            log.executions.push(invocation.clone());
            log.running += 1;
            log.max_running = log.max_running.max(log.running);
        }
        let behavior = (self.handler)(&invocation, &self.workspace);
        let cancelled = || ToolOutput::text(ToolOutcome::Cancelled, "cancelled");
        let output = match behavior {
            Behavior::Output(output) => output,
            Behavior::Progress(lines, output) => {
                for line in lines {
                    progress(line);
                }
                output
            }
            Behavior::UntilCancelled => {
                cancel.cancelled().await;
                cancelled()
            }
            Behavior::Slow(output) => {
                for _ in 0..3 {
                    tokio::task::yield_now().await;
                }
                output
            }
            Behavior::Gated(gate, output) => {
                match crate::race::race(cancel.cancelled(), gate.notified()).await {
                    crate::race::Either::Left(()) => cancelled(),
                    crate::race::Either::Right(()) => output,
                }
            }
        };
        self.log
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .running -= 1;
        output
    }

    /// Answers like a careful host would: a call it never ran is
    /// `NotApplied`; a file write it ran is `Applied` with the same result
    /// (writes are idempotent and checkable); anything else that ran is
    /// `Unknown`.
    async fn interrupted(&self, invocation: &ToolInvocation) -> InterruptedCall {
        let ran = self
            .log()
            .executions
            .iter()
            .any(|e| e.call == invocation.call);
        let answer = match (ran, self.effect_of(&invocation.name)) {
            (false, _) => InterruptedCall::NotApplied,
            (true, Some(ToolEffect::WorkspaceWrite | ToolEffect::ReadOnly)) => {
                match (self.handler)(invocation, &self.workspace) {
                    Behavior::Output(output)
                    | Behavior::Progress(_, output)
                    | Behavior::Slow(output)
                    | Behavior::Gated(_, output) => InterruptedCall::Applied(output),
                    Behavior::UntilCancelled => InterruptedCall::Unknown,
                }
            }
            (true, _) => InterruptedCall::Unknown,
        };
        self.log
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .interrupted
            .push((invocation.call.clone(), answer.clone()));
        answer
    }
}
