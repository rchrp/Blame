//! The agent's plan: a short list of steps it writes and ticks off.
//!
//! `update_plan` is a tool the engine serves itself, offered to a session
//! whose `engine_tools` name [`TOOL_SET`]. It changes nothing in the
//! workspace: it checks the whole list the model sends and answers. The plan
//! is not kept anywhere else, it is a projection of the log: the input of the
//! latest `update_plan` call that completed, among the records in effect
//! ([`View::plan`]). A rewind, a fork, a restart and an offline replay
//! therefore give it back as the log says, and `finish_task` is refused
//! while it has open steps (see [`crate::contract::open_plan_text`]).
//!
//! Every text here is a pure function of the plan, as the records require.

use crate::projection::View;
use blame_engine_protocol::{
    AssistantBlock, PlanStep, RecordBody, Seq, SessionConfig, StepStatus, ToolCallId, ToolEffect,
    ToolOutcome, ToolSpec, TurnId,
};
use serde_json::{Value, json};

/// The tool the model calls to set its plan.
pub const TOOL: &str = "update_plan";
/// Its name in `SessionConfig::engine_tools`.
pub const TOOL_SET: &str = "plan";

/// More steps than this is not a list anyone follows: the model groups.
pub const MAX_STEPS: usize = 15;
/// A step is one short line.
pub const MAX_STEP_CHARS: usize = 160;
pub const MAX_REASON_CHARS: usize = 240;
/// Problems reported per call; the model needs the first few.
const MAX_PROBLEMS: usize = 8;

/// The tool, as the model is offered it.
pub fn spec() -> ToolSpec {
    ToolSpec {
        name: TOOL.into(),
        description: "Sets your plan: a short list of steps that you tick off as you work, and \
that the person sees. Use it for work of three steps or more, not for a question or a small \
change. Send the whole plan on every call, finished steps included: it replaces the previous \
one. At most one step is `in_progress`; mark a step `completed` as soon as it is done. A step \
you will not do is `abandoned`, with a one-line reason: never just drop it. `finish_task` is \
refused while a step is `pending` or `in_progress`. This changes no file."
            .into(),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["plan"],
            "properties": {
                "plan": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": MAX_STEPS,
                    "items": {
                        "type": "object",
                        "additionalProperties": false,
                        "required": ["step", "status"],
                        "properties": {
                            "step": {
                                "type": "string",
                                "maxLength": MAX_STEP_CHARS,
                                "description": "One short imperative sentence, e.g. \"Add the endpoint\"."
                            },
                            "status": {
                                "type": "string",
                                "enum": ["pending", "in_progress", "completed", "abandoned"]
                            },
                            "reason": {
                                "type": "string",
                                "maxLength": MAX_REASON_CHARS,
                                "description": "Why the step is abandoned. Only for an abandoned step."
                            }
                        }
                    }
                }
            }
        }),
        effect: ToolEffect::ReadOnly,
        ends_turn: false,
        needs_approval: false,
    }
}

/// `specs` plus the plan tool when the session asks for it. The engine's
/// tool wins over a tool of the same name.
pub fn offered(config: &SessionConfig, mut specs: Vec<ToolSpec>) -> Vec<ToolSpec> {
    if config.engine_tools.iter().any(|set| set == TOOL_SET) {
        specs.retain(|spec| spec.name != TOOL);
        specs.push(spec());
    }
    specs
}

/// The steps of an `update_plan` input, trimmed, or what is wrong with it,
/// each problem worded for the model to fix.
pub fn parse(input: &Value) -> Result<Vec<PlanStep>, Vec<String>> {
    let Some(list) = input.get("plan").and_then(Value::as_array) else {
        return Err(vec![
            "`plan` must be an array of steps, each with a `step` and a `status`".into(),
        ]);
    };
    let mut problems = Vec::new();
    if list.is_empty() {
        problems.push("`plan` needs at least one step".to_owned());
    }
    if list.len() > MAX_STEPS {
        problems.push(format!(
            "`plan` has {} steps and {MAX_STEPS} is the most: group related work into one step",
            list.len()
        ));
    }
    let mut steps = Vec::with_capacity(list.len());
    let mut in_progress = Vec::new();
    for (index, item) in list.iter().enumerate() {
        let number = index + 1;
        let Some(object) = item.as_object() else {
            problems.push(format!(
                "step {number}: expected an object with a `step` and a `status`"
            ));
            continue;
        };
        let text = object
            .get("step")
            .and_then(Value::as_str)
            .map(one_line)
            .filter(|text| !text.is_empty());
        match &text {
            None => problems.push(format!("step {number}: `step` must be a non-empty string")),
            Some(text) if text.chars().count() > MAX_STEP_CHARS => problems.push(format!(
                "step {number}: `step` is {} characters, keep it under {MAX_STEP_CHARS}",
                text.chars().count()
            )),
            Some(_) => {}
        }
        let status = match object.get("status").and_then(Value::as_str) {
            Some("pending") => Some(StepStatus::Pending),
            Some("in_progress") => Some(StepStatus::InProgress),
            Some("completed") => Some(StepStatus::Completed),
            Some("abandoned") => Some(StepStatus::Abandoned),
            _ => {
                problems.push(format!(
                    "step {number}: `status` must be `pending`, `in_progress`, `completed` or `abandoned`"
                ));
                None
            }
        };
        let reason = object
            .get("reason")
            .and_then(Value::as_str)
            .map(one_line)
            .filter(|reason| !reason.is_empty());
        match (status, &reason) {
            (Some(StepStatus::Abandoned), None) => problems.push(format!(
                "step {number}: an abandoned step needs a one-line `reason`"
            )),
            (Some(StepStatus::Abandoned), Some(reason))
                if reason.chars().count() > MAX_REASON_CHARS =>
            {
                problems.push(format!(
                    "step {number}: `reason` is {} characters, keep it under {MAX_REASON_CHARS}",
                    reason.chars().count()
                ));
            }
            (Some(StepStatus::Abandoned) | None, _) | (_, None) => {}
            (Some(_), Some(_)) => problems.push(format!(
                "step {number}: `reason` is only for an abandoned step"
            )),
        }
        if status == Some(StepStatus::InProgress) {
            in_progress.push(number);
        }
        if let (Some(step), Some(status)) = (text, status) {
            steps.push(PlanStep {
                step,
                status,
                reason: reason.filter(|_| status == StepStatus::Abandoned),
            });
        }
    }
    if in_progress.len() > 1 {
        let numbers: Vec<String> = in_progress.iter().map(usize::to_string).collect();
        problems.push(format!(
            "only one step can be `in_progress`, and steps {} are: finish one or set the others back to `pending`",
            numbers.join(", ")
        ));
    }
    problems.truncate(MAX_PROBLEMS);
    if problems.is_empty() {
        Ok(steps)
    } else {
        Err(problems)
    }
}

/// A step or a reason on one line: no newline, no run of spaces.
fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// What the model reads after an accepted update.
pub fn applied_text(steps: &[PlanStep]) -> String {
    let count = |status: StepStatus| steps.iter().filter(|step| step.status == status).count();
    let mut text = format!(
        "Plan updated: {} of {} done",
        count(StepStatus::Completed),
        steps.len()
    );
    if count(StepStatus::Abandoned) > 0 {
        text.push_str(&format!(", {} abandoned", count(StepStatus::Abandoned)));
    }
    text.push('.');
    match steps
        .iter()
        .find(|step| step.status == StepStatus::InProgress)
    {
        Some(step) => text.push_str(&format!(" In progress: {}.", step.step)),
        None if steps.iter().any(|step| step.status.is_open()) => {
            text.push_str(" No step is in progress: mark the one you start `in_progress`.");
        }
        None => text.push_str(" No step is open."),
    }
    text
}

/// The error a refused update returns to the model.
pub fn rejected_text(problems: &[String]) -> String {
    let mut text = String::from("Plan not updated:");
    for problem in problems {
        text.push_str("\n- ");
        text.push_str(problem);
    }
    text.push_str("\nFix this and call `update_plan` again with the whole plan.");
    text
}

/// The plan in effect and where it was set.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CurrentPlan {
    pub steps: Vec<PlanStep>,
    /// The turn whose call set it.
    pub turn: TurnId,
    pub call: ToolCallId,
    /// The record that answered the call: the plan took effect there.
    pub seq: Seq,
}

impl View<'_> {
    /// The plan the session has now: the input of the latest `update_plan`
    /// call that completed, among the records in effect. Calls of one reply
    /// count in the order the model made them, whatever order they ran in.
    /// `None` until a call completed.
    pub fn plan(&self) -> Option<CurrentPlan> {
        let mut current = None;
        for record in self.items().iter().filter_map(|item| item.record()) {
            let RecordBody::AssistantMessage { turn, blocks, .. } = &record.body else {
                continue;
            };
            for block in blocks {
                let AssistantBlock::ToolCall {
                    call, name, input, ..
                } = block
                else {
                    continue;
                };
                if name != TOOL {
                    continue;
                }
                let Some(answer) = self.result_record(call) else {
                    continue;
                };
                let RecordBody::ToolCallFinished {
                    outcome: ToolOutcome::Completed,
                    ..
                } = &answer.body
                else {
                    continue;
                };
                if let Ok(steps) = parse(input) {
                    current = Some(CurrentPlan {
                        steps,
                        turn: turn.clone(),
                        call: call.clone(),
                        seq: answer.seq,
                    });
                }
            }
        }
        current
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(steps: &[(&str, &str)]) -> Value {
        json!({ "plan": steps
            .iter()
            .map(|(step, status)| json!({ "step": step, "status": status }))
            .collect::<Vec<_>>() })
    }

    fn problems(input: &Value) -> Vec<String> {
        parse(input).expect_err("refused")
    }

    #[test]
    fn a_valid_plan_is_trimmed_and_kept_in_order() {
        let steps = parse(&json!({ "plan": [
            { "step": "  Add the\nendpoint ", "status": "completed" },
            { "step": "Wire the form", "status": "in_progress", "reason": "" },
            { "step": "Support SSO", "status": "abandoned", "reason": "Out of scope" },
            { "step": "Write tests", "status": "pending" },
        ] }))
        .expect("valid");
        let seen: Vec<(&str, StepStatus, Option<&str>)> = steps
            .iter()
            .map(|s| (s.step.as_str(), s.status, s.reason.as_deref()))
            .collect();
        assert_eq!(
            seen,
            [
                ("Add the endpoint", StepStatus::Completed, None),
                ("Wire the form", StepStatus::InProgress, None),
                ("Support SSO", StepStatus::Abandoned, Some("Out of scope")),
                ("Write tests", StepStatus::Pending, None),
            ]
        );
    }

    #[test]
    fn the_shape_of_the_input_is_checked() {
        assert_eq!(
            problems(&json!({})),
            ["`plan` must be an array of steps, each with a `step` and a `status`"]
        );
        assert_eq!(
            problems(&json!({ "plan": [] })),
            ["`plan` needs at least one step"]
        );
        assert_eq!(
            problems(&json!({ "plan": ["Add it"] })),
            ["step 1: expected an object with a `step` and a `status`"]
        );
        assert_eq!(
            problems(&json!({ "plan": [{ "step": " ", "status": "later" }] })),
            [
                "step 1: `step` must be a non-empty string",
                "step 1: `status` must be `pending`, `in_progress`, `completed` or `abandoned`",
            ]
        );
    }

    #[test]
    fn at_most_one_step_is_in_progress() {
        assert_eq!(
            problems(&input(&[
                ("a", "in_progress"),
                ("b", "completed"),
                ("c", "in_progress"),
            ])),
            [
                "only one step can be `in_progress`, and steps 1, 3 are: finish one or set the others back to `pending`"
            ]
        );
    }

    #[test]
    fn a_reason_goes_with_an_abandoned_step_only() {
        assert_eq!(
            problems(&input(&[("a", "abandoned")])),
            ["step 1: an abandoned step needs a one-line `reason`"]
        );
        assert_eq!(
            problems(&json!({ "plan": [{ "step": "a", "status": "pending", "reason": "why" }] })),
            ["step 1: `reason` is only for an abandoned step"]
        );
    }

    #[test]
    fn the_size_of_the_plan_is_bounded() {
        let many: Vec<(&str, &str)> = vec![("a step", "pending"); MAX_STEPS + 1];
        assert_eq!(
            problems(&input(&many)),
            ["`plan` has 16 steps and 15 is the most: group related work into one step"]
        );
        let long = "x".repeat(MAX_STEP_CHARS + 1);
        assert_eq!(
            problems(&input(&[(long.as_str(), "pending")])),
            ["step 1: `step` is 161 characters, keep it under 160"]
        );
    }

    #[test]
    fn what_the_model_reads_back_says_where_the_plan_stands() {
        let steps = parse(&input(&[
            ("a", "completed"),
            ("b", "in_progress"),
            ("c", "pending"),
        ]))
        .expect("valid");
        assert_eq!(
            applied_text(&steps),
            "Plan updated: 1 of 3 done. In progress: b."
        );
        let idle = parse(&input(&[("a", "completed"), ("b", "pending")])).expect("valid");
        assert_eq!(
            applied_text(&idle),
            "Plan updated: 1 of 2 done. No step is in progress: mark the one you start `in_progress`."
        );
        let closed = parse(&json!({ "plan": [
            { "step": "a", "status": "completed" },
            { "step": "b", "status": "abandoned", "reason": "Not needed" },
        ] }))
        .expect("valid");
        assert_eq!(
            applied_text(&closed),
            "Plan updated: 1 of 2 done, 1 abandoned. No step is open."
        );
        assert_eq!(
            rejected_text(&["step 1: `step` must be a non-empty string".into()]),
            "Plan not updated:\n- step 1: `step` must be a non-empty string\nFix this and call `update_plan` again with the whole plan."
        );
    }

    #[test]
    fn the_declared_schema_is_one_the_engine_can_check() {
        assert_eq!(
            crate::contract::unsupported_keywords(&spec().input_schema),
            Vec::<String>::new()
        );
    }
}
