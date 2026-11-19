use super::ManualClock;
use crate::ports::{
    Clock, ModelEvent, ModelMessage, ModelProvider, ModelRequest, ModelStream, ProviderError,
};
use async_trait::async_trait;
use blame_engine_protocol::{AssistantBlock, BlockKind, ErrorKind, StopReason, ToolCallId, Usage};
use futures_core::Stream;
use serde_json::Value;
use std::collections::VecDeque;
use std::pin::Pin;
use std::sync::{Arc, Mutex, PoisonError};
use std::task::{Context, Poll};
use std::time::Duration;

/// One thing a scripted stream does.
#[derive(Clone, Debug)]
pub enum Step {
    Event(ModelEvent),
    /// The stream fails here, after what came before.
    Error(ProviderError),
    /// Nothing more ever arrives and the stream stays open.
    Stall,
    /// Waits on the provider's clock before going on.
    Delay(Duration),
}

/// How the provider answers one request.
#[derive(Clone, Debug)]
pub enum Script {
    /// `stream` itself fails.
    Reject(ProviderError),
    Stream(Vec<Step>),
}

impl Script {
    /// A plain text reply that ends the turn.
    pub fn text(text: &str) -> Self {
        Self::reply(
            vec![AssistantBlock::Text {
                text: text.into(),
                native: None,
            }],
            StopReason::EndTurn,
        )
    }

    /// A reply that calls tools, given as `(name, input)`.
    pub fn tool_calls(calls: &[(&str, Value)]) -> Self {
        Self::reply(
            calls
                .iter()
                .map(|(name, input)| AssistantBlock::ToolCall {
                    // Replaced by the loop with an engine id.
                    call: ToolCallId::from("provider-id"),
                    name: (*name).into(),
                    input: input.clone(),
                    native: None,
                })
                .collect(),
            StopReason::ToolUse,
        )
    }

    /// The events a real provider would send for `blocks`.
    pub fn reply(blocks: Vec<AssistantBlock>, stop: StopReason) -> Self {
        let mut steps = Vec::new();
        for (index, block) in blocks.into_iter().enumerate() {
            let index = index as u32;
            let (kind, tool) = match &block {
                AssistantBlock::Text { .. } | AssistantBlock::Opaque { .. } => {
                    (BlockKind::Text, None)
                }
                AssistantBlock::Reasoning { .. } => (BlockKind::Reasoning, None),
                AssistantBlock::ToolCall { name, .. } => (BlockKind::ToolCall, Some(name.clone())),
            };
            steps.push(Step::Event(ModelEvent::BlockStarted { index, kind, tool }));
            match &block {
                AssistantBlock::Text { text, .. } => {
                    for piece in split(text) {
                        steps.push(Step::Event(ModelEvent::TextDelta { index, text: piece }));
                    }
                }
                AssistantBlock::Reasoning { text, .. } => {
                    steps.push(Step::Event(ModelEvent::ReasoningDelta {
                        index,
                        text: text.clone(),
                    }));
                }
                AssistantBlock::ToolCall { input, .. } => {
                    steps.push(Step::Event(ModelEvent::ToolInputDelta {
                        index,
                        json: input.to_string(),
                    }));
                }
                AssistantBlock::Opaque { .. } => {}
            }
            steps.push(Step::Event(ModelEvent::BlockFinished { index, block }));
        }
        steps.push(Step::Event(ModelEvent::Finished {
            stop,
            usage: Usage {
                input_tokens: Some(10),
                output_tokens: Some(5),
                ..Usage::default()
            },
        }));
        Self::Stream(steps)
    }

    /// Replaces the usage of the final event.
    pub fn with_usage(mut self, usage: Usage) -> Self {
        if let Self::Stream(steps) = &mut self
            && let Some(Step::Event(ModelEvent::Finished { usage: u, .. })) = steps.last_mut()
        {
            *u = usage;
        }
        self
    }

    /// The same stream, failing with `kind` once `after` steps have gone.
    pub fn failing_after(self, after: usize, kind: ErrorKind) -> Self {
        match self {
            Self::Stream(mut steps) => {
                steps.truncate(after);
                steps.push(Step::Error(ProviderError::new(kind, "scripted failure")));
                Self::Stream(steps)
            }
            other => other,
        }
    }

    /// The same stream, stalling once `after` steps have gone.
    pub fn stalling_after(self, after: usize) -> Self {
        match self {
            Self::Stream(mut steps) => {
                steps.truncate(after);
                steps.push(Step::Stall);
                Self::Stream(steps)
            }
            other => other,
        }
    }

    pub fn error(kind: ErrorKind) -> Self {
        Self::Reject(ProviderError::new(kind, "scripted error"))
    }
}

fn split(text: &str) -> Vec<String> {
    let middle = text
        .char_indices()
        .nth(text.chars().count() / 2)
        .map_or(0, |(i, _)| i);
    [&text[..middle], &text[middle..]]
        .into_iter()
        .filter(|piece| !piece.is_empty())
        .map(str::to_owned)
        .collect()
}

type Responder = dyn Fn(&ModelRequest) -> Script + Send + Sync;

/// A model that answers from a script: queued answers first, then a
/// function of the request if one is set.
#[derive(Clone, Default)]
pub struct ScriptedProvider {
    inner: Arc<Mutex<ProviderState>>,
    responder: Option<Arc<Responder>>,
    clock: Option<ManualClock>,
}

#[derive(Default)]
struct ProviderState {
    queue: VecDeque<Script>,
    requests: Vec<ModelRequest>,
}

impl ScriptedProvider {
    pub fn new() -> Self {
        Self::default()
    }

    /// Answers every request not served by the queue with `responder`.
    pub fn responding(responder: impl Fn(&ModelRequest) -> Script + Send + Sync + 'static) -> Self {
        Self {
            responder: Some(Arc::new(responder)),
            ..Self::default()
        }
    }

    /// The clock `Step::Delay` waits on.
    pub fn with_clock(mut self, clock: ManualClock) -> Self {
        self.clock = Some(clock);
        self
    }

    fn state(&self) -> std::sync::MutexGuard<'_, ProviderState> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn push(&self, script: Script) -> &Self {
        self.state().queue.push_back(script);
        self
    }

    /// Every request received, in order.
    pub fn requests(&self) -> Vec<ModelRequest> {
        self.state().requests.clone()
    }

    pub fn request_messages(&self) -> Vec<Vec<ModelMessage>> {
        self.state()
            .requests
            .iter()
            .map(|request| request.messages.clone())
            .collect()
    }
}

#[async_trait]
impl ModelProvider for ScriptedProvider {
    async fn stream(&self, request: ModelRequest) -> Result<ModelStream, ProviderError> {
        let script = {
            let mut state = self.state();
            state.requests.push(request.clone());
            state.queue.pop_front()
        };
        let script = match (script, &self.responder) {
            (Some(script), _) => script,
            (None, Some(responder)) => responder(&request),
            (None, None) => Script::Reject(ProviderError::new(
                ErrorKind::Internal,
                "the provider script is exhausted",
            )),
        };
        match script {
            Script::Reject(error) => Err(error),
            Script::Stream(steps) => Ok(Box::pin(ScriptedStream {
                steps: steps.into(),
                clock: self.clock.clone(),
                delay: None,
            })),
        }
    }
}

struct ScriptedStream {
    steps: VecDeque<Step>,
    clock: Option<ManualClock>,
    delay: Option<Pin<Box<dyn std::future::Future<Output = ()> + Send>>>,
}

impl Stream for ScriptedStream {
    type Item = Result<ModelEvent, ProviderError>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        loop {
            if let Some(delay) = &mut self.delay {
                match delay.as_mut().poll(cx) {
                    Poll::Ready(()) => self.delay = None,
                    Poll::Pending => return Poll::Pending,
                }
            }
            match self.steps.front() {
                None => return Poll::Ready(None),
                Some(Step::Stall) => return Poll::Pending,
                _ => {}
            }
            match self.steps.pop_front() {
                Some(Step::Event(event)) => return Poll::Ready(Some(Ok(event))),
                Some(Step::Error(error)) => {
                    self.steps.clear();
                    return Poll::Ready(Some(Err(error)));
                }
                Some(Step::Delay(duration)) => {
                    let clock = self
                        .clock
                        .clone()
                        .expect("Step::Delay needs ScriptedProvider::with_clock");
                    self.delay = Some(Box::pin(async move { clock.sleep(duration).await }));
                }
                Some(Step::Stall) | None => unreachable!("handled above"),
            }
        }
    }
}
