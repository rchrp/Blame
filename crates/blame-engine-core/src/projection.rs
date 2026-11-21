//! What a session's log means right now, computed from its records alone.
//!
//! Everything here is a pure function of the records: the same records give
//! the same messages and the same digest, byte for byte, which is what lets a
//! restarted engine keep the provider's prompt cache. The loop never keeps a
//! second copy of the conversation; it folds the log again whenever it needs
//! to decide what to do next.

use crate::digest::Sha256;
use crate::ports::{ModelMessage, ToolResultMessage};
use blame_engine_protocol::{
    AssistantBlock, ErrorInfo, ErrorKind, ModelRef, Obligation, ReasoningEffort, Record,
    RecordBody, Refusal, RequestId, Seq, SessionConfig, StopReason, TaskFailure, TaskOutcome,
    ToolCallId, ToolEffect, ToolOutcome, ToolResultBlock, ToolSpec, TurnId, TurnOutcome, UserBlock,
};
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};

/// Shown to the model in place of a result that does not exist: the call was
/// cut off by a rewind to the middle of a turn, or never ran.
pub const MISSING_RESULT: &str = "No result: this call did not complete.";

/// Opens the user message that stands for a compacted part of the history.
pub const SUMMARY_PREAMBLE: &str = "The earlier part of this conversation was compacted. \
This summary replaces it:\n\n";

/// One element of the history in effect: a record, or the point where a
/// rewind cut the log (which ends whatever was still open there).
#[derive(Clone, Copy, Debug)]
pub enum Item<'a> {
    Record(&'a Record),
    /// Stands for the `RewindFinished` at `at`.
    Boundary {
        at: Seq,
    },
}

impl<'a> Item<'a> {
    pub fn seq(&self) -> Seq {
        match self {
            Self::Record(record) => record.seq,
            Self::Boundary { at } => *at,
        }
    }

    pub fn record(&self) -> Option<&'a Record> {
        match self {
            Self::Record(record) => Some(record),
            Self::Boundary { .. } => None,
        }
    }
}

/// The records in effect, in log order, after applying every rewind and undo.
pub fn effective(records: &[Record]) -> Vec<Item<'_>> {
    let mut items: Vec<Item<'_>> = Vec::with_capacity(records.len());
    // What the latest rewind removed, while it can still be undone.
    let mut undoable: Option<(Seq, Vec<Item<'_>>)> = None;
    for record in records {
        match &record.body {
            // In flight until its `RewindFinished`; changes nothing by itself.
            RecordBody::RewindStarted { .. } => {}
            RecordBody::RewindFinished { to, .. } => {
                let cut = items.partition_point(|item| item.seq() <= *to);
                let removed = items.split_off(cut);
                items.push(Item::Boundary { at: record.seq });
                undoable = Some((record.seq, removed));
                continue;
            }
            RecordBody::RewindUndone { rewind } => {
                if let Some((finished, removed)) = undoable.take()
                    && finished == *rewind
                {
                    items.pop();
                    items.extend(removed);
                }
                continue;
            }
            _ => items.push(Item::Record(record)),
        }
        undoable = None;
    }
    items
}

/// A request's position in its turn, as far as the log knows.
#[derive(Clone, Debug, PartialEq)]
pub enum RequestOutcome<'a> {
    InFlight,
    Replied { stop: StopReason, has_calls: bool },
    Failed(&'a ErrorInfo),
}

#[derive(Clone, Debug, PartialEq)]
pub struct RequestState<'a> {
    pub request: &'a RequestId,
    pub attempt: u32,
    pub started: Seq,
    pub outcome: RequestOutcome<'a>,
    /// Attempts of this request that failed because the context was too big.
    pub overflows: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApprovalState {
    None,
    Requested,
    Approved,
    Denied,
}

/// A tool call of the turn's latest reply.
#[derive(Clone, Debug, PartialEq)]
pub struct CallState<'a> {
    pub call: &'a ToolCallId,
    pub name: &'a str,
    pub input: &'a Value,
    /// `ToolCallStarted` records seen for it; more than one when recovery
    /// ran it again.
    pub starts: u32,
    pub effect: Option<ToolEffect>,
    pub finished: Option<ToolOutcome>,
    pub approval: ApprovalState,
}

/// Everything the loop needs to decide a turn's next step.
#[derive(Clone, Debug, PartialEq)]
pub struct TurnState<'a> {
    pub turn: &'a TurnId,
    pub checkpoint: bool,
    /// Distinct requests sent (retries of one request count once).
    pub requests: u32,
    pub cost_micro_usd: u64,
    pub last_request: Option<RequestState<'a>>,
    /// A compaction happened after the last failed attempt.
    pub compacted_since_failure: bool,
    /// Calls of the latest reply, in the order the model made them.
    pub calls: Vec<CallState<'a>>,
    /// A steer arrived after the latest request was sent.
    pub steer_pending: bool,
    /// When the message that opened the turn was stored.
    pub started_at_ms: u64,
    /// Tokens of every reply of the turn: input, cache reads and writes,
    /// output.
    pub tokens: u64,
    /// Tools with a call that completed in this turn, in completion order.
    pub completed: Vec<&'a str>,
    /// The same, as it stood when the latest reply arrived: what a result
    /// in that reply could rely on.
    pub completed_before_reply: Vec<&'a str>,
    /// The call accepted as the turn's result.
    pub accepted: Option<&'a ToolCallId>,
    /// Why the result tool refused the turn's latest finish, when it said so.
    pub refused: Option<&'a Refusal>,
    /// Contract corrections sent in this turn.
    pub corrections: u32,
    /// A correction was stored after the latest request was sent.
    pub correction_pending: bool,
    /// The tool the latest correction forces, until a reply arrives.
    pub forced_tool: Option<&'a str>,
    /// The latest request gave the model a message the user sent into the
    /// running turn (a steer), for the first time.
    pub steer_in_last_request: bool,
    /// The turn had made tool calls before the latest request: work was
    /// under way when that request was sent.
    pub worked_before_last_request: bool,
    /// The model was asked to carry on after acknowledging a steer
    /// (`TurnContinued`), and the next request is not sent yet.
    pub continue_pending: bool,
}

impl TurnState<'_> {
    pub fn pending_calls(&self) -> impl Iterator<Item = &CallState<'_>> {
        self.calls.iter().filter(|call| call.finished.is_none())
    }
}

/// The meaning of a log: configuration, open turns and the model's view.
pub struct View<'a> {
    items: Vec<Item<'a>>,
    config: Option<&'a SessionConfig>,
    /// `(through, summary)` of the compaction in effect.
    compaction: Option<(Seq, &'a str)>,
    edits: HashMap<(Seq, u32), &'a str>,
    results: HashMap<&'a ToolCallId, &'a Record>,
    open_turns: Vec<&'a TurnId>,
    /// Open turns that have begun: a checkpoint or a request of their own.
    started: Vec<&'a TurnId>,
}

impl<'a> View<'a> {
    pub fn new(records: &'a [Record]) -> Self {
        let items = effective(records);
        let mut config = None;
        let mut compaction = None;
        let mut edits = HashMap::new();
        let mut results = HashMap::new();
        let mut open: Vec<&'a TurnId> = Vec::new();
        let mut started: Vec<&'a TurnId> = Vec::new();
        for item in &items {
            let Item::Record(record) = item else {
                open.clear();
                started.clear();
                continue;
            };
            match &record.body {
                RecordBody::SessionCreated { config: c }
                | RecordBody::ConfigChanged { config: c } => {
                    config = Some(&**c);
                }
                RecordBody::ContextCompacted {
                    through, summary, ..
                } => compaction = Some((*through, summary.as_str())),
                RecordBody::ContextEdited { edits: list } => {
                    for edit in list {
                        edits.insert((edit.target, edit.block), edit.replacement.as_str());
                    }
                }
                RecordBody::ToolCallFinished { call, .. } => {
                    results.entry(call).or_insert(*record);
                }
                RecordBody::UserMessage {
                    turn,
                    delivery: blame_engine_protocol::Delivery::Turn,
                    ..
                } => {
                    if !open.contains(&turn) {
                        open.push(turn);
                    }
                }
                RecordBody::CheckpointCreated { turn, .. }
                | RecordBody::RequestStarted { turn, .. } => {
                    if !started.contains(&turn) {
                        started.push(turn);
                    }
                }
                RecordBody::TurnEnded { turn, .. } => {
                    open.retain(|t| *t != turn);
                    started.retain(|t| *t != turn);
                }
                _ => {}
            }
        }
        Self {
            items,
            config,
            compaction,
            edits,
            results,
            open_turns: open,
            started,
        }
    }

    pub fn items(&self) -> &[Item<'a>] {
        &self.items
    }

    /// The configuration in effect; `None` only for an empty log.
    pub fn config(&self) -> Option<&'a SessionConfig> {
        self.config
    }

    /// Turns opened and not ended, oldest first: the first one runs, the
    /// others wait their turn.
    pub fn open_turns(&self) -> &[&'a TurnId] {
        &self.open_turns
    }

    /// Whether an open turn has begun (a checkpoint or a request of its
    /// own). One that has not is a message still waiting: it can be taken
    /// back, and a quit leaves it waiting.
    pub fn has_started(&self, turn: &TurnId) -> bool {
        self.started.contains(&turn)
    }

    pub fn compacted_through(&self) -> Option<Seq> {
        self.compaction.map(|(through, _)| through)
    }

    /// The messages of the next request.
    pub fn messages(&self) -> Vec<ModelMessage> {
        self.emit(None)
    }

    /// The messages standing for the history up to `through`: what a
    /// compaction ending there summarises.
    pub fn messages_through(&self, through: Seq) -> Vec<ModelMessage> {
        self.emit(Some(through))
    }

    fn emit(&self, limit: Option<Seq>) -> Vec<ModelMessage> {
        let mut out = Vec::new();
        let summarised = self.compaction.map_or(0, |(through, _)| through);
        if let Some((_, summary)) = self.compaction {
            push_user(
                &mut out,
                vec![UserBlock::Text {
                    text: format!("{SUMMARY_PREAMBLE}{summary}"),
                }],
            );
        }
        // Turn messages that wait for the running turn to end.
        let mut open: VecDeque<&TurnId> = VecDeque::new();
        let mut deferred: HashMap<&TurnId, (Seq, &[UserBlock])> = HashMap::new();
        let mut steer: Vec<UserBlock> = Vec::new();
        for item in &self.items {
            let seq = item.seq();
            if limit.is_some_and(|limit| seq > limit) {
                break;
            }
            let shown = seq > summarised;
            let Item::Record(record) = item else {
                flush(&mut out, &mut steer);
                // A rewind to the middle of a turn ends it, and every turn
                // queued behind it, where the log was cut.
                open.pop_front();
                while let Some(turn) = open.pop_front() {
                    if let Some((origin, input)) = deferred.remove(turn) {
                        self.push_input(&mut out, origin, input, shown);
                    }
                }
                continue;
            };
            match &record.body {
                RecordBody::UserMessage {
                    turn,
                    input,
                    delivery,
                } => match delivery {
                    blame_engine_protocol::Delivery::Turn => {
                        if open.contains(&turn) {
                            continue;
                        }
                        open.push_back(turn);
                        if open.len() == 1 {
                            flush(&mut out, &mut steer);
                            self.push_input(&mut out, seq, input, shown);
                        } else {
                            deferred.insert(turn, (seq, input));
                        }
                    }
                    blame_engine_protocol::Delivery::Steer => {
                        if shown {
                            steer.extend(self.edited_user(seq, input));
                        }
                    }
                },
                RecordBody::RequestStarted { .. } => flush(&mut out, &mut steer),
                // Joins the turn like a steer: the model reads it at the
                // start of the next request.
                RecordBody::ContractCorrection { text, .. }
                | RecordBody::TurnContinued { text, .. } => {
                    if shown {
                        steer.push(UserBlock::Text { text: text.clone() });
                    }
                }
                RecordBody::AssistantMessage { blocks, .. } => {
                    // A steer stored while this reply streamed was not part of
                    // its request: it stays pending until the next one.
                    if shown {
                        self.push_reply(&mut out, seq, blocks);
                    }
                }
                RecordBody::TurnEnded { turn, .. } => {
                    flush(&mut out, &mut steer);
                    let was_running = open.front() == Some(&turn);
                    open.retain(|t| *t != turn);
                    if was_running
                        && let Some(next) = open.front()
                        && let Some((origin, input)) = deferred.remove(next)
                    {
                        self.push_input(&mut out, origin, input, shown);
                    }
                }
                _ => {}
            }
        }
        flush(&mut out, &mut steer);
        out
    }

    fn push_input(
        &self,
        out: &mut Vec<ModelMessage>,
        origin: Seq,
        input: &[UserBlock],
        shown: bool,
    ) {
        if shown {
            push_user(out, self.edited_user(origin, input));
        }
    }

    fn edited_user(&self, seq: Seq, input: &[UserBlock]) -> Vec<UserBlock> {
        input
            .iter()
            .enumerate()
            .filter_map(|(index, block)| match self.edit(seq, index) {
                Some("") => None,
                Some(text) => Some(UserBlock::Text { text: text.into() }),
                None => Some(block.clone()),
            })
            .collect()
    }

    fn push_reply(&self, out: &mut Vec<ModelMessage>, seq: Seq, blocks: &[AssistantBlock]) {
        let blocks: Vec<AssistantBlock> = blocks
            .iter()
            .enumerate()
            .filter_map(|(index, block)| match (self.edit(seq, index), block) {
                (Some(""), AssistantBlock::Text { .. } | AssistantBlock::Reasoning { .. }) => None,
                (Some(text), AssistantBlock::Text { .. }) => Some(AssistantBlock::Text {
                    text: text.into(),
                    native: None,
                }),
                (Some(text), AssistantBlock::Reasoning { .. }) => Some(AssistantBlock::Reasoning {
                    text: text.into(),
                    native: None,
                }),
                // A call's structure is what pairs it with its result.
                _ => Some(block.clone()),
            })
            .collect();
        let results: Vec<ToolResultMessage> = blocks
            .iter()
            .filter_map(|block| match block {
                AssistantBlock::ToolCall { call, .. } => Some(self.result_of(call)),
                _ => None,
            })
            .collect();
        if blocks.is_empty() {
            return;
        }
        out.push(ModelMessage::Assistant(blocks));
        if !results.is_empty() {
            out.push(ModelMessage::ToolResults(results));
        }
    }

    fn result_of(&self, call: &ToolCallId) -> ToolResultMessage {
        match self
            .results
            .get(call)
            .map(|record| (record.seq, &record.body))
        {
            Some((
                seq,
                RecordBody::ToolCallFinished {
                    outcome, content, ..
                },
            )) => ToolResultMessage {
                call: call.clone(),
                outcome: *outcome,
                content: content
                    .iter()
                    .enumerate()
                    .filter_map(|(index, block)| match self.edit(seq, index) {
                        Some("") => None,
                        Some(text) => Some(ToolResultBlock::Text { text: text.into() }),
                        None => Some(block.clone()),
                    })
                    .collect(),
            },
            _ => ToolResultMessage {
                call: call.clone(),
                outcome: ToolOutcome::Cancelled,
                content: vec![ToolResultBlock::Text {
                    text: MISSING_RESULT.into(),
                }],
            },
        }
    }

    fn edit(&self, seq: Seq, index: usize) -> Option<&'a str> {
        self.edit_of(seq, u32::try_from(index).ok()?)
    }

    /// The text in effect for block `block` of record `seq`, when an edit
    /// replaced it (the latest edit wins); empty when an edit removed it.
    /// A context policy reads it to propose only what changes.
    pub fn edit_of(&self, seq: Seq, block: u32) -> Option<&'a str> {
        self.edits.get(&(seq, block)).copied()
    }

    /// The `ToolCallFinished` that answers `call` in the history in effect:
    /// the first one stored, as the model is shown.
    pub fn result_record(&self, call: &ToolCallId) -> Option<&'a Record> {
        self.results.get(call).copied()
    }

    /// Where `turn` stands. Only meaningful for an open turn.
    pub fn turn_state(&self, turn: &TurnId) -> TurnState<'a> {
        let mut state = TurnState {
            turn: self
                .open_turns
                .iter()
                .copied()
                .find(|t| *t == turn)
                .unwrap_or_else(|| self.turn_ref(turn)),
            checkpoint: false,
            requests: 0,
            cost_micro_usd: 0,
            last_request: None,
            compacted_since_failure: false,
            calls: Vec::new(),
            steer_pending: false,
            started_at_ms: 0,
            tokens: 0,
            completed: Vec::new(),
            completed_before_reply: Vec::new(),
            accepted: None,
            refused: None,
            corrections: 0,
            correction_pending: false,
            forced_tool: None,
            steer_in_last_request: false,
            worked_before_last_request: false,
            continue_pending: false,
        };
        // The turn made a tool call in a reply so far.
        let mut made_calls = false;
        let mut seen_requests: Vec<&RequestId> = Vec::new();
        let mut calls: HashMap<&ToolCallId, usize> = HashMap::new();
        // Every call of the turn by its id, for the tools that completed.
        let mut names: HashMap<&ToolCallId, &'a str> = HashMap::new();
        let mut opened = false;
        for item in &self.items {
            let Item::Record(record) = item else {
                if opened {
                    // The turn was cut by a rewind; nothing after counts.
                    break;
                }
                continue;
            };
            match &record.body {
                RecordBody::UserMessage {
                    turn: t, delivery, ..
                } if t == turn => match delivery {
                    blame_engine_protocol::Delivery::Turn => {
                        if !opened {
                            state.started_at_ms = record.at_ms;
                        }
                        opened = true;
                    }
                    blame_engine_protocol::Delivery::Steer => state.steer_pending = true,
                },
                RecordBody::CheckpointCreated { turn: t, .. } if t == turn => {
                    state.checkpoint = true;
                }
                RecordBody::RequestStarted {
                    turn: t,
                    request,
                    attempt,
                    ..
                } if t == turn => {
                    if !seen_requests.contains(&request) {
                        seen_requests.push(request);
                        state.requests += 1;
                        // A retry of the same request carries the same
                        // messages: only a new request delivers a steer.
                        state.steer_in_last_request = state.steer_pending;
                        state.worked_before_last_request = made_calls;
                    }
                    let overflows = match &state.last_request {
                        Some(last) if last.request == request => last.overflows,
                        _ => 0,
                    };
                    state.last_request = Some(RequestState {
                        request,
                        attempt: *attempt,
                        started: record.seq,
                        outcome: RequestOutcome::InFlight,
                        overflows,
                    });
                    state.steer_pending = false;
                    state.correction_pending = false;
                    state.continue_pending = false;
                    state.compacted_since_failure = false;
                }
                RecordBody::AssistantMessage {
                    turn: t,
                    request,
                    blocks,
                    stop,
                    usage,
                } if t == turn => {
                    state.cost_micro_usd += usage.cost_micro_usd.unwrap_or(0);
                    state.tokens += usage.input_tokens.unwrap_or(0)
                        + usage.cache_read_tokens.unwrap_or(0)
                        + usage.cache_write_tokens.unwrap_or(0)
                        + usage.output_tokens.unwrap_or(0);
                    state.completed_before_reply = state.completed.clone();
                    state.forced_tool = None;
                    state.calls.clear();
                    calls.clear();
                    for block in blocks {
                        if let AssistantBlock::ToolCall {
                            call, name, input, ..
                        } = block
                        {
                            names.insert(call, name.as_str());
                            calls.insert(call, state.calls.len());
                            state.calls.push(CallState {
                                call,
                                name,
                                input,
                                starts: 0,
                                effect: None,
                                finished: None,
                                approval: ApprovalState::None,
                            });
                        }
                    }
                    made_calls |= !state.calls.is_empty();
                    if let Some(last) = &mut state.last_request
                        && last.request == request
                    {
                        last.outcome = RequestOutcome::Replied {
                            stop: *stop,
                            has_calls: !state.calls.is_empty(),
                        };
                    }
                }
                RecordBody::RequestFailed {
                    turn: t,
                    request,
                    error,
                } if t == turn => {
                    if let Some(last) = &mut state.last_request
                        && last.request == request
                    {
                        last.outcome = RequestOutcome::Failed(error);
                        if error.kind == ErrorKind::ContextOverflow {
                            last.overflows += 1;
                        }
                    }
                }
                RecordBody::ContextCompacted { .. } => {
                    if matches!(
                        state.last_request,
                        Some(RequestState {
                            outcome: RequestOutcome::Failed(_),
                            ..
                        })
                    ) {
                        state.compacted_since_failure = true;
                    }
                }
                RecordBody::ApprovalRequested { turn: t, call } if t == turn => {
                    if let Some(&index) = calls.get(call) {
                        state.calls[index].approval = ApprovalState::Requested;
                    }
                }
                RecordBody::ApprovalResolved {
                    turn: t,
                    call,
                    decision,
                } if t == turn => {
                    if let Some(&index) = calls.get(call) {
                        state.calls[index].approval = match decision {
                            blame_engine_protocol::ApprovalDecision::Approved => {
                                ApprovalState::Approved
                            }
                            blame_engine_protocol::ApprovalDecision::Denied => {
                                ApprovalState::Denied
                            }
                        };
                    }
                }
                RecordBody::ToolCallStarted {
                    turn: t,
                    call,
                    effect,
                    ..
                } if t == turn => {
                    if let Some(&index) = calls.get(call) {
                        state.calls[index].starts += 1;
                        state.calls[index].effect = Some(*effect);
                    }
                }
                RecordBody::ToolCallFinished {
                    turn: t,
                    call,
                    outcome,
                    ..
                } if t == turn => {
                    if let Some(&index) = calls.get(call)
                        && state.calls[index].finished.is_none()
                    {
                        state.calls[index].finished = Some(*outcome);
                    }
                    if *outcome == ToolOutcome::Completed
                        && let Some(name) = names.remove(call)
                    {
                        state.completed.push(name);
                    }
                }
                RecordBody::ResultAccepted { turn: t, call } if t == turn => {
                    state.accepted = Some(call);
                }
                RecordBody::ResultRejected {
                    turn: t,
                    refusal: Some(refusal),
                    ..
                } if t == turn => {
                    state.refused = Some(refusal);
                }
                RecordBody::ContractCorrection {
                    turn: t,
                    forced_tool,
                    ..
                } if t == turn => {
                    state.corrections += 1;
                    state.correction_pending = true;
                    state.forced_tool = forced_tool.as_deref();
                }
                RecordBody::TurnContinued { turn: t, .. } if t == turn => {
                    state.continue_pending = true;
                }
                _ => {}
            }
        }
        state
    }

    fn turn_ref(&self, turn: &TurnId) -> &'a TurnId {
        self.items
            .iter()
            .filter_map(Item::record)
            .find_map(|record| match &record.body {
                RecordBody::UserMessage { turn: t, .. } if t == turn => Some(t),
                _ => None,
            })
            .expect("turn_state is asked for a turn of this log")
    }

    /// The input the model gave a call, wherever it is in the log.
    pub fn call_input(&self, call: &ToolCallId) -> Option<(&'a str, &'a Value)> {
        self.items
            .iter()
            .filter_map(Item::record)
            .find_map(|record| match &record.body {
                RecordBody::AssistantMessage { blocks, .. } => {
                    blocks.iter().find_map(|block| match block {
                        AssistantBlock::ToolCall {
                            call: c,
                            name,
                            input,
                            ..
                        } if c == call => Some((name.as_str(), input)),
                        _ => None,
                    })
                }
                _ => None,
            })
    }

    /// A rough token count of the next request, for deciding when to compact.
    /// It uses the provider's own count of the latest reply when nothing has
    /// reshaped the history since, and four bytes a token for the rest.
    pub fn estimate_tokens(&self, tools: &[ToolSpec]) -> u64 {
        let fixed = self.config.map_or(0, |c| c.system_prompt.len())
            + serde_json::to_vec(tools).map_or(0, |bytes| bytes.len());
        let last_reply = self.items.iter().rposition(|item| {
            matches!(
                item.record().map(|r| &r.body),
                Some(RecordBody::AssistantMessage { usage, .. }) if usage.input_tokens.is_some()
            )
        });
        let reshaped_after = |index: usize| {
            self.items[index..].iter().any(|item| {
                matches!(
                    item,
                    Item::Boundary { .. }
                        | Item::Record(Record {
                            body: RecordBody::ContextCompacted { .. }
                                | RecordBody::ContextEdited { .. },
                            ..
                        })
                )
            })
        };
        match last_reply {
            Some(index) if !reshaped_after(index) => {
                let Some(RecordBody::AssistantMessage { usage, .. }) =
                    self.items[index].record().map(|r| &r.body)
                else {
                    unreachable!("found above")
                };
                let counted = usage.input_tokens.unwrap_or(0)
                    + usage.cache_read_tokens.unwrap_or(0)
                    + usage.cache_write_tokens.unwrap_or(0)
                    + usage.output_tokens.unwrap_or(0);
                let after: usize = self.items[index + 1..]
                    .iter()
                    .filter_map(Item::record)
                    .map(|record| record_weight(&record.body))
                    .sum();
                counted + (after / 4) as u64
            }
            _ => {
                let messages = serde_json::to_vec(&messages_json(&self.messages()))
                    .map_or(0, |bytes| bytes.len());
                ((fixed + messages) / 4) as u64
            }
        }
    }

    /// Where a compaction may end so that roughly `keep_tokens` of the most
    /// recent history stay verbatim: just before a request or a new turn, and
    /// after the compaction already in effect.
    pub fn compaction_cut(&self, keep_tokens: u64) -> Option<Seq> {
        let floor = self.compaction.map_or(0, |(through, _)| through);
        // A cut is useful only if it summarises at least one message.
        let first_content = self.items.iter().position(|item| {
            item.seq() > floor
                && matches!(
                    item.record().map(|r| &r.body),
                    Some(RecordBody::UserMessage { .. } | RecordBody::AssistantMessage { .. })
                )
        })?;
        let mut kept = 0usize;
        let mut best = None;
        for index in (1..self.items.len()).rev() {
            if let Some(record) = self.items[index].record() {
                kept += record_weight(&record.body);
            }
            let starts_step = matches!(
                self.items[index].record().map(|r| &r.body),
                Some(
                    RecordBody::RequestStarted { .. }
                        | RecordBody::UserMessage {
                            delivery: blame_engine_protocol::Delivery::Turn,
                            ..
                        }
                )
            );
            let through = self.items[index - 1].seq();
            if !starts_step || through <= floor {
                continue;
            }
            if first_content >= index {
                break;
            }
            best = Some(through);
            if (kept / 4) as u64 >= keep_tokens {
                break;
            }
        }
        best
    }
}

fn record_weight(body: &RecordBody) -> usize {
    match body {
        RecordBody::UserMessage { .. }
        | RecordBody::AssistantMessage { .. }
        | RecordBody::ToolCallFinished { .. } => {
            serde_json::to_vec(body).map_or(0, |bytes| bytes.len())
        }
        _ => 0,
    }
}

/// Keeps user content in one message: no API accepts two user turns in a
/// row, and merging here keeps the provider adapters simple.
fn push_user(out: &mut Vec<ModelMessage>, blocks: Vec<UserBlock>) {
    if blocks.is_empty() {
        return;
    }
    match out.last_mut() {
        Some(ModelMessage::User(existing)) => existing.extend(blocks),
        _ => out.push(ModelMessage::User(blocks)),
    }
}

fn flush(out: &mut Vec<ModelMessage>, steer: &mut Vec<UserBlock>) {
    push_user(out, std::mem::take(steer));
}

/// Appends a user instruction after `messages`, merged into a trailing user
/// message if there is one.
pub fn with_user_text(mut messages: Vec<ModelMessage>, text: &str) -> Vec<ModelMessage> {
    push_user(&mut messages, vec![UserBlock::Text { text: text.into() }]);
    messages
}

fn messages_json(messages: &[ModelMessage]) -> Value {
    Value::Array(
        messages
            .iter()
            .map(|message| match message {
                ModelMessage::User(blocks) => json!({ "role": "user", "content": blocks }),
                ModelMessage::Assistant(blocks) => {
                    json!({ "role": "assistant", "content": blocks })
                }
                ModelMessage::ToolResults(results) => json!({
                    "role": "tool",
                    "content": results.iter().map(|result| json!({
                        "call": result.call,
                        "outcome": result.outcome,
                        "content": result.content,
                    })).collect::<Vec<_>>(),
                }),
            })
            .collect(),
    )
}

/// Fingerprint of everything a request sends that the provider caches: the
/// model, the system prompt, the tools and the messages, in order.
pub fn request_digest(
    model: &ModelRef,
    system: &str,
    tools: &[ToolSpec],
    reasoning: Option<ReasoningEffort>,
    messages: &[ModelMessage],
) -> String {
    let value = json!({
        "model": model,
        "system": system,
        "tools": tools,
        "reasoning": reasoning,
        "messages": messages_json(messages),
    });
    let bytes = serde_json::to_vec(&value).expect("JSON values always serialize");
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    format!("sha256:{}", hasher.finish_hex())
}

/// Cache breakpoints for `messages`: the end of the request, so the next one
/// reads it back, and the end of the previous exchange, which the request
/// before this one wrote.
pub fn cache_breakpoints(messages: &[ModelMessage]) -> Vec<usize> {
    let Some(last) = messages.len().checked_sub(1) else {
        return Vec::new();
    };
    let previous = messages[..last]
        .iter()
        .rposition(|message| matches!(message, ModelMessage::Assistant(_)))
        .and_then(|assistant| assistant.checked_sub(1));
    match previous {
        Some(previous) if previous != last => vec![previous, last],
        _ => vec![last],
    }
}

/// How a task ended, once its turn has: `None` while it runs (or when the
/// log is not a task's).
pub fn task_outcome(records: &[Record]) -> Option<TaskOutcome> {
    let view = View::new(records);
    let items = view.items();
    let (turn, outcome) = items
        .iter()
        .filter_map(Item::record)
        .find_map(|record| match &record.body {
            RecordBody::TurnEnded { turn, outcome } => Some((turn, outcome)),
            _ => None,
        })?;
    let failed = |failure| TaskOutcome::Failed { failure };
    Some(match outcome {
        TurnOutcome::Completed => {
            let accepted =
                items
                    .iter()
                    .filter_map(Item::record)
                    .find_map(|record| match &record.body {
                        RecordBody::ResultAccepted { turn: t, call } if t == turn => Some(call),
                        _ => None,
                    });
            match accepted.and_then(|call| Some((call, view.call_input(call)?))) {
                Some((call, (_, input))) => TaskOutcome::Completed {
                    call: call.clone(),
                    result: input.clone(),
                },
                None => failed(TaskFailure::ContractUnmet {
                    unmet: vec![Obligation::Result {
                        tool: view
                            .config()
                            .and_then(|config| config.contract.as_ref())
                            .map(|contract| contract.result.name().to_owned())
                            .unwrap_or_default(),
                    }],
                }),
            }
        }
        // A task takes no messages, so none of its turns is ever withdrawn.
        TurnOutcome::Interrupted | TurnOutcome::Withdrawn => TaskOutcome::Interrupted,
        TurnOutcome::LimitReached { limit } => failed(TaskFailure::LimitReached {
            limit: limit.clone(),
        }),
        TurnOutcome::Failed { error } => failed(TaskFailure::ProviderError {
            error: error.clone(),
        }),
        TurnOutcome::ContractUnmet { unmet, .. } => failed(TaskFailure::ContractUnmet {
            unmet: unmet.clone(),
        }),
    })
}

/// How a tool call is named in `RewindFinished::unreverted_commands`: the
/// command line when the input has one, else the tool and its input.
pub fn describe_call(name: &str, input: &Value) -> String {
    match input.get("command").and_then(Value::as_str) {
        Some(command) => command.to_owned(),
        None => format!("{name} {input}"),
    }
}

/// The snapshot restoring the workspace to how it was at `to`: the first
/// checkpoint after `to`, provided nothing wrote to the workspace between
/// the two. `None` when no such checkpoint exists; `Some(None)` when nothing
/// changed the workspace after `to` at all.
pub fn checkpoint_for(view: &View<'_>, to: Seq) -> Option<Option<(String, String)>> {
    for item in view.items() {
        if item.seq() <= to {
            continue;
        }
        match item.record().map(|r| &r.body) {
            Some(RecordBody::CheckpointCreated {
                checkpoint,
                snapshot,
                ..
            }) => return Some(Some((checkpoint.0.clone(), snapshot.clone()))),
            Some(RecordBody::ToolCallStarted { effect, .. }) if *effect != ToolEffect::ReadOnly => {
                return None;
            }
            _ => {}
        }
    }
    Some(None)
}

/// Commands and external calls among the records a rewind to `to` removes.
pub fn unreverted_commands(view: &View<'_>, to: Seq) -> Vec<String> {
    view.items()
        .iter()
        .filter(|item| item.seq() > to)
        .filter_map(|item| match item.record().map(|r| &r.body) {
            Some(RecordBody::ToolCallStarted {
                call,
                name,
                effect: ToolEffect::Command | ToolEffect::External,
                ..
            }) => Some(match view.call_input(call) {
                Some((name, input)) => describe_call(name, input),
                None => name.clone(),
            }),
            _ => None,
        })
        .collect()
}

#[cfg(test)]
mod tests;
