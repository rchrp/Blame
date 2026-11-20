//! The tool inputs are validated as zod validates them in the TypeScript
//! harness: `fixtures/input-validation.jsonl` holds zod's verdicts (the
//! repaired value, or the message the model reads) for tricky inputs.

use blame_harness::json::Json;
use blame_harness::tools::normalize_search_input;
use blame_harness::validate::{
    issues_message, parse_leniently, read_code_schema, search_code_schema,
};

#[test]
fn inputs_validate_as_zod_validates_them() {
    let fixture = [
        include_str!("fixtures/input-validation.jsonl"),
        include_str!("fixtures/edit-input-validation.jsonl"),
    ]
    .concat();
    let mut checked = 0;
    for line in fixture.lines().filter(|line| !line.is_empty()) {
        let case = Json::parse(line).expect("fixture line");
        let tool = case.get("tool").and_then(Json::as_str).expect("tool");
        // The two oversized inputs are rebuilt rather than stored.
        let input = match (
            case.get("input"),
            case.get("message").and_then(Json::as_str),
        ) {
            (Some(input), _) => input.clone(),
            (None, Some(message)) if message.starts_with("operations: Too big") => {
                let operation = blame_harness::obj! { "kind" => "patch", "patch" => "p" };
                blame_harness::obj! { "operations" => Json::Arr(vec![operation; 51]) }
            }
            (None, _) => {
                let operation =
                    blame_harness::obj! { "kind" => "patch", "patch" => "x".repeat(2_097_153) };
                blame_harness::obj! { "operations" => Json::Arr(vec![operation]) }
            }
        };
        let (schema, value) = match tool {
            "search_code" => (search_code_schema(), normalize_search_input(&input)),
            "edit_code" => (blame_harness::validate::edit_code_schema(), input.clone()),
            _ => (read_code_schema(), input.clone()),
        };
        let outcome = parse_leniently(&schema, &value);
        match (case.get("ok").and_then(Json::as_bool), outcome) {
            (Some(true), Ok(parsed)) => {
                assert_eq!(Some(&parsed), case.get("data"), "{tool} {input}")
            }
            (Some(false), Err(issues)) => {
                assert_eq!(
                    Some(issues_message(&issues).as_str()),
                    case.get("message").and_then(Json::as_str),
                    "{tool} {input}"
                )
            }
            (expected, outcome) => panic!(
                "{tool} {input}: expected ok={expected:?}, got {:?}",
                outcome.map_err(|issues| issues_message(&issues))
            ),
        }
        checked += 1;
    }
    assert!(checked > 70);
}
