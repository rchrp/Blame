//! What a helper's records say about how it ended.

use blame_engine_core::projection::task_outcome;
use blame_engine_protocol::{
    Obligation, Record, RecordBody, SessionId, SubAgentBrief, SubAgentReport, SubAgentResult,
    SubAgentStatus, TaskFailure, TaskOutcome, Usage,
};

/// The result of the helper at `index`, read from its log once it ended.
pub(super) fn result(
    index: u32,
    brief: &SubAgentBrief,
    session: SessionId,
    records: &[Record],
) -> SubAgentResult {
    let (status, report, reason) = match task_outcome(records) {
        Some(TaskOutcome::Completed { result, .. }) => {
            match serde_json::from_value::<SubAgentReport>(result) {
                Ok(report) => (SubAgentStatus::Completed, Some(report), None),
                // The engine checked the schema before it accepted the
                // report, so this is a mismatch between the two, not a model.
                Err(error) => (
                    SubAgentStatus::Failed,
                    None,
                    Some(format!("its report could not be read: {error}")),
                ),
            }
        }
        Some(TaskOutcome::Interrupted) => (
            SubAgentStatus::Cancelled,
            None,
            Some("It was stopped before it reported.".into()),
        ),
        Some(TaskOutcome::Failed { failure }) => {
            (SubAgentStatus::Failed, None, Some(failure_text(&failure)))
        }
        None => (
            SubAgentStatus::Failed,
            None,
            Some("Its log stopped before it ended.".into()),
        ),
    };
    SubAgentResult {
        index,
        role: brief.role,
        title: brief.title.clone(),
        status,
        session,
        report,
        reason,
        tokens: tokens(records),
        duration_ms: duration_ms(records),
    }
}

fn failure_text(failure: &TaskFailure) -> String {
    match failure {
        TaskFailure::ContractUnmet { unmet } => {
            let reports = unmet
                .iter()
                .any(|obligation| matches!(obligation, Obligation::Result { .. }));
            if reports {
                "It stopped without reporting.".into()
            } else {
                "It stopped before it finished.".into()
            }
        }
        TaskFailure::LimitReached { limit } => {
            format!("It reached its {limit} limit before it reported.")
        }
        TaskFailure::ProviderError { error } => format!("The model failed: {}", error.message),
    }
}

/// Tokens of every reply of the log: input, cache reads and writes, output.
pub(super) fn tokens(records: &[Record]) -> u64 {
    records
        .iter()
        .filter_map(|record| match &record.body {
            RecordBody::AssistantMessage { usage, .. } => Some(total(usage)),
            _ => None,
        })
        .sum()
}

fn total(usage: &Usage) -> u64 {
    [
        usage.input_tokens,
        usage.output_tokens,
        usage.cache_read_tokens,
        usage.cache_write_tokens,
    ]
    .into_iter()
    .flatten()
    .sum()
}

/// From the instruction to the end of the turn (or the last record).
fn duration_ms(records: &[Record]) -> u64 {
    let start = records
        .iter()
        .find(|record| matches!(record.body, RecordBody::UserMessage { .. }))
        .map(|record| record.at_ms);
    let end = records
        .iter()
        .rev()
        .find(|record| matches!(record.body, RecordBody::TurnEnded { .. }))
        .or(records.last())
        .map(|record| record.at_ms);
    match (start, end) {
        (Some(start), Some(end)) => end.saturating_sub(start),
        _ => 0,
    }
}
