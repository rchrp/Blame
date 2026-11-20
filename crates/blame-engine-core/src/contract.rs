//! Enforcing a turn's completion contract: what is still unmet, what the
//! engine tells the model, and whether a result's input matches its schema.
//!
//! Every text here is a pure function of the contract and of what the turn
//! did, so the records the engine writes are the same each time and a run
//! can be audited, or replayed, from its log.

mod schema;

pub use schema::{unsupported_keywords, validate};

use blame_engine_protocol::{CompletionContract, Obligation, ResultTool, ToolEffect, ToolSpec};

/// Text of the result of an accepted `submit` call.
pub const ACCEPTED: &str = "Accepted: this is the result. Nothing more is needed.";
/// Text of a call made after the result was accepted.
pub const NOT_RUN_ACCEPTED: &str = "Not run: the result was already accepted.";

/// What the turn still owes: each required tool that has not completed,
/// then the result itself.
pub fn unmet<'a>(
    contract: &CompletionContract,
    completed: impl IntoIterator<Item = &'a str> + Clone,
) -> Vec<Obligation> {
    let mut unmet: Vec<Obligation> = contract
        .required
        .iter()
        .filter(|tool| !completed.clone().into_iter().any(|done| done == *tool))
        .map(|tool| Obligation::Call { tool: tool.clone() })
        .collect();
    unmet.push(Obligation::Result {
        tool: contract.result.name().to_owned(),
    });
    unmet
}

/// The tool a forced request makes the model call: the first required tool
/// not yet done, else the result tool.
pub fn tool_to_force(unmet: &[Obligation]) -> Option<&str> {
    unmet.first().map(|obligation| match obligation {
        Obligation::Call { tool } | Obligation::Result { tool } => tool.as_str(),
    })
}

/// The message sent to a model that stopped without fulfilling the contract.
pub fn correction_text(unmet: &[Obligation]) -> String {
    let mut text = String::from(
        "You stopped without completing the task. It ends only through an accepted result",
    );
    let calls: Vec<&str> = unmet
        .iter()
        .filter_map(|obligation| match obligation {
            Obligation::Call { tool } => Some(tool.as_str()),
            Obligation::Result { .. } => None,
        })
        .collect();
    let result = unmet.iter().find_map(|obligation| match obligation {
        Obligation::Result { tool } => Some(tool.as_str()),
        Obligation::Call { .. } => None,
    });
    text.push_str(".\n");
    if !calls.is_empty() {
        let returns = if calls.len() == 1 {
            "it returns"
        } else {
            "they return"
        };
        text.push_str(&format!(
            "First call {} and read what {returns}.\n",
            list(&calls)
        ));
    }
    if let Some(result) = result {
        text.push_str(&format!(
            "Then call `{result}` with the result. Do not answer in text: only that call counts."
        ));
    }
    text
}

/// The error a refused result call returns to the model.
pub fn rejection_text(result_tool: &str, invalid: &[String], unmet: &[Obligation]) -> String {
    let mut text = format!("Not accepted: `{result_tool}` was refused.");
    if !invalid.is_empty() {
        text.push_str(" Its input does not match the schema:");
        for error in invalid {
            text.push_str("\n- ");
            text.push_str(error);
        }
    }
    let calls: Vec<&str> = unmet
        .iter()
        .filter_map(|obligation| match obligation {
            Obligation::Call { tool } => Some(tool.as_str()),
            Obligation::Result { .. } => None,
        })
        .collect();
    if !calls.is_empty() {
        text.push_str(&format!(
            "\nBefore the result, call {} in an earlier reply and use what it returns.",
            list(&calls)
        ));
    }
    text.push_str(&format!("\nFix this and call `{result_tool}` again."));
    text
}

fn list(tools: &[&str]) -> String {
    let named: Vec<String> = tools.iter().map(|tool| format!("`{tool}`")).collect();
    match named.as_slice() {
        [] => String::new(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// The tools a session under `contract` is offered: the host's, narrowed
/// to the allowed ones, plus the result tool when the engine defines it.
pub fn offered(contract: Option<&CompletionContract>, mut specs: Vec<ToolSpec>) -> Vec<ToolSpec> {
    let Some(contract) = contract else {
        return specs;
    };
    let result = contract.result.name();
    if let Some(allowed) = &contract.allowed {
        specs.retain(|spec| spec.name == result || allowed.contains(&spec.name));
    }
    if let ResultTool::Submit {
        name,
        description,
        input_schema,
    } = &contract.result
    {
        specs.retain(|spec| spec.name != *name);
        specs.push(ToolSpec {
            name: name.clone(),
            description: description.clone(),
            input_schema: input_schema.clone(),
            effect: ToolEffect::ReadOnly,
            ends_turn: false,
            needs_approval: false,
        });
    }
    specs
}

/// Why a contract cannot be enforced as written, before any session runs
/// with it.
pub fn check(contract: &CompletionContract) -> Result<(), String> {
    if contract.result.name().is_empty() {
        return Err("the result tool has no name".into());
    }
    if contract
        .required
        .iter()
        .any(|tool| tool == contract.result.name())
    {
        return Err("the result tool cannot also be a required tool".into());
    }
    if let ResultTool::Submit { input_schema, .. } = &contract.result {
        let unsupported = unsupported_keywords(input_schema);
        if !unsupported.is_empty() {
            return Err(format!(
                "the result schema uses keywords the engine does not check: {}",
                unsupported.join(", ")
            ));
        }
    }
    if let Some(allowed) = &contract.allowed
        && let Some(tool) = contract
            .required
            .iter()
            .find(|tool| !allowed.contains(tool))
    {
        return Err(format!("the required tool `{tool}` is not allowed"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn contract(required: &[&str]) -> CompletionContract {
        CompletionContract {
            result: ResultTool::Submit {
                name: "submit".into(),
                description: "The result.".into(),
                input_schema: json!({ "type": "object" }),
            },
            required: required.iter().map(|tool| (*tool).to_owned()).collect(),
            allowed: None,
            max_corrections: 2,
        }
    }

    #[test]
    fn obligations_list_the_missing_calls_then_the_result() {
        let contract = contract(&["read", "grep"]);
        assert_eq!(
            unmet(&contract, ["grep"]),
            [
                Obligation::Call {
                    tool: "read".into()
                },
                Obligation::Result {
                    tool: "submit".into()
                }
            ]
        );
        assert_eq!(
            tool_to_force(&unmet(&contract, ["grep", "read"])),
            Some("submit")
        );
        assert_eq!(
            tool_to_force(&unmet(&contract, Vec::<&str>::new())),
            Some("read")
        );
    }

    #[test]
    fn the_correction_names_what_is_missing() {
        let text = correction_text(&unmet(&contract(&["read", "grep"]), Vec::<&str>::new()));
        assert_eq!(
            text,
            "You stopped without completing the task. It ends only through an accepted result.\n\
First call `read` and `grep` and read what they return.\n\
Then call `submit` with the result. Do not answer in text: only that call counts."
        );
    }

    #[test]
    fn contracts_that_cannot_hold_are_refused() {
        assert!(check(&contract(&["submit"])).is_err());
        let mut restricted = contract(&["read"]);
        restricted.allowed = Some(vec!["grep".into()]);
        assert!(check(&restricted).is_err());
        let mut pattern = contract(&[]);
        pattern.result = ResultTool::Submit {
            name: "submit".into(),
            description: String::new(),
            input_schema: json!({ "type": "string", "pattern": "^a" }),
        };
        assert_eq!(
            check(&pattern),
            Err("the result schema uses keywords the engine does not check: /pattern".into())
        );
    }
}
