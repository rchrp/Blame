//! A check's observation from its own invocation (`check-observation.ts`,
//! `test-type-evidence.ts`, `runtime-test-scope.ts`,
//! `project-test-command.ts`). Observations are ordered JSON, as the model
//! and the journal read them.

use super::catalog::{self, Task};
use super::report::{
    Counts, NodeEventBinding, node_event_evidence, parse_test_report, parse_test_reports,
};
use crate::identity::sha256_hex;
use crate::json::Json;
use crate::obj;
use crate::syntax::parse_code;
use crate::text::{js_trim, utf16_len, utf16_prefix};
use regex::Regex;
use std::sync::LazyLock;

/// A JavaScript pattern: `\b` is an ASCII word boundary there.
fn js(pattern: &str) -> Regex {
    Regex::new(&pattern.replace(r"\b", r"(?-u:\b)")).expect("pattern")
}

macro_rules! pattern {
    ($name:ident, $source:expr) => {
        static $name: LazyLock<Regex> = LazyLock::new(|| js($source));
    };
}

pattern!(MOCHA, r"(?:^|[\s/\\])mocha(?:\.[cm]?js)?(?:\s|$)");
pattern!(
    TEST_RUNNERS,
    r"(?:^|\s)(?:pytest|py\.test|vitest|jest)(?:\s|$)|\b(?:dotnet|mvn|mvnw|gradle|gradlew)\s+[^;&|]*\btest\b|\bnode\s+[^;&|]*--test\b"
);
pattern!(NODE_TEST, r"\bnode\b[^;&|]*--test\b");
pattern!(SGR, "\x1b\\[[0-9;]*m");
pattern!(PYTEST, r"\bpytest\b|\bpy\.test\b");
pattern!(PYTEST_SUMMARY, r"(?m)^=+ ([^\n]+) in [\d.]+s[^\n]*=+\s*$");
pattern!(PYTEST_ERRORS, r"\berrors?\b");
pattern!(
    PYTEST_COUNTED,
    r"\d+ (?:passed|failed|skipped|deselected|xfailed|xpassed)"
);
pattern!(VITEST_OR_JEST, r"\b(?:vitest|jest)\b");
pattern!(TESTS_SUMMARY, r"(?m)^\s*Tests\s*:?\s+([^\n]+)$");
pattern!(TOTAL, r"\((\d+)\)|(\d+) total");
pattern!(
    WORKER_SPEC,
    r"^\s*[✔✖]\s+(.+?)\s+\([\d.]+(?:ms|s)\)(?:\s.*)?$"
);
pattern!(WORKER_TAP, r"^\s*(?:not )?ok \d+ - (.+?)(?:\s+#\s.*)?$");
pattern!(SOURCE_LABEL, r"\.[cm]?[jt]sx?$");
pattern!(AND_AND, r"\s+&&\s+");
pattern!(TSC_STEP, r"^tsc(?:\s+[\w./:=@+-]+)*$");
pattern!(
    VITEST_STEP,
    r"^(?:vitest|node\s+(?:[\w./-]+/)?vitest\.[cm]?js)(?:\s+[\w./:=@+-]+)*$"
);
pattern!(VITEST_BANNER, r"(?m)^\s*RUN\s+v[1-3]\.\d+\.\d+[^\r\n]*$");
pattern!(
    NO_TEST_FILES,
    r"(?m)^No test files found, exiting with code 1\s*$"
);
pattern!(
    VITEST_FAILURE,
    r"(?m)^\s*(?:FAIL\b|Tests\s|Test Files\s|Unhandled\b|(?:Assertion|Syntax|Type)?Error\b|Type Errors\s)|\berror TS\d+:"
);
pattern!(VITEST, r"\bvitest(?:\.[cm]?js)?\b");
pattern!(TYPECHECK_FLAG, r"--(?:no-)?typecheck\b");
pattern!(TYPE_ERRORS_HEADING, r"(?m)^\s*Type Errors\s");
pattern!(VERSION_BANNER, r"(?m)^\s*RUN\s+v([^\s]+)[^\r\n]*$");
pattern!(TYPE_ERRORS_SUMMARY, r"(?m)^\s*Type Errors\s+([^\r\n]+)$");
pattern!(FAILED_SUMMARY, r"^(\d+) failed$");
pattern!(
    TYPECHECK_ERROR,
    r"\b(?:TypeCheckError|TSError):|\berror TS\d+:"
);
pattern!(SPACES, r"\s+");
pattern!(CHANGED_TEST, r"\.(?:test|spec)(?:-d)?\.[cm]?tsx?$");

pub fn is_mocha_invocation(command: &str) -> bool {
    MOCHA.is_match(command)
}

pub fn is_test_invocation(command: &str) -> bool {
    is_mocha_invocation(command) || TEST_RUNNERS.is_match(command)
}

/// A command's result as the process layer reports it.
pub struct CommandResult<'a> {
    pub all: &'a str,
    pub exit_code: Option<i32>,
    pub failed: bool,
    pub interruption: Option<&'static str>,
}

/// What a test invocation's own output (and, when attributed, its own
/// report or Node events) shows; never an older report.
pub fn observe_check(
    command: &str,
    result: &CommandResult<'_>,
    scope: &str,
    source_changed: bool,
    attributed: Option<&[String]>,
    attributed_single: bool,
    node_events: Option<&NodeEventBinding>,
) -> Json {
    // ANSI SGR from runners is presentation, not diagnostic content.
    let output = SGR.replace_all(result.all, "").into_owned();
    let report = match attributed {
        Some(sources) if !attributed_single => parse_test_reports(sources),
        Some(sources) => sources.first().and_then(|source| parse_test_report(source)),
        None => None,
    }
    .or_else(|| parse_test_report(&output));
    // Node can count an empty file worker as a test; text reporters cannot
    // tell it from a case named like a source path: withhold the aggregate.
    let ambiguous_node = NODE_TEST.is_match(command)
        && output
            .split('\n')
            .map(|line| line.strip_suffix('\r').unwrap_or(line))
            .any(node_file_worker_label);
    let structured = node_events.and_then(node_event_evidence);
    let counts: Option<Counts> = if node_events.is_some() {
        structured.as_ref().map(|evidence| evidence.counts)
    } else if ambiguous_node {
        None
    } else {
        report
            .as_ref()
            .map(|report| report.counts)
            .or_else(|| runner_counts(command, &output))
    };
    let reported = if is_mocha_invocation(command) {
        mocha_reported_counts(&output)
    } else {
        None
    };
    let interrupted = result.interruption.is_some();
    let typechecking = test_type_evidence(command, &output, interrupted);
    let no_test_files = !interrupted
        && result.exit_code == Some(1)
        && report.is_none()
        && counts.is_none()
        && reported.is_none()
        && vitest_no_test_files(command, &output);
    let execution = match counts {
        Some(counts) if counts.executed > 0 => "observed",
        Some(_) => "zero_tests",
        None => "not_observed",
    };
    let failed = result.failed
        || structured.as_ref().is_some_and(|evidence| evidence.failed)
        || report.as_ref().is_some_and(|report| report.setup_failed)
        || counts.is_some_and(|counts| counts.failed > 0)
        || reported
            .as_ref()
            .and_then(|reported| reported.get("failed"))
            .and_then(Json::as_f64)
            .is_some_and(|failed| failed > 0.0);
    let outcome = if interrupted {
        "unknown"
    } else if failed {
        "failed"
    } else if execution == "observed" && result.exit_code == Some(0) {
        "passed"
    } else {
        "unknown"
    };
    let origin = if structured.is_some() {
        "node_events"
    } else if report.is_some() {
        "report"
    } else if counts.is_some() || reported.is_some() {
        "runner_output"
    } else {
        "none"
    };
    let note = if node_events.is_some() && structured.is_none() {
        Some(
            "Invocation-owned Node events are incomplete or unsupported; executed case count remains unconfirmed.",
        )
    } else if ambiguous_node && structured.is_none() {
        Some(
            "Node text summaries can count empty file workers. Source-path labels leave the executed case count unconfirmed.",
        )
    } else {
        None
    };
    let diagnostics = report
        .as_ref()
        .filter(|report| !report.failures.is_empty())
        .map(|report| Json::Arr(report.failures.clone()));
    obj! {
        "process" => match result.interruption { Some("cancelled") => "cancelled", Some("timed_out") => "timed_out", _ => "exited" },
    }
    .with_opt("exitCode", result.exit_code)
    .with("execution", execution)
    .with("outcome", outcome)
    .with_opt("counts", counts.map(Counts::to_json))
    .with_opt("reportedCounts", reported)
    .with("scope", scope)
    .with("selection", "unknown")
    // A host process can have unobserved writers: equal snapshots prove nothing.
    .with("freshness", if source_changed { "stale" } else { "unknown" })
    .with("evidenceOrigin", origin)
    .with_opt("selectionFailure", no_test_files.then_some("no_test_files"))
    .with_opt("typechecking", typechecking)
    .with_opt("evidence", structured.map(|evidence| evidence.evidence))
    .with_opt("note", note)
    .with_opt("diagnostics", diagnostics)
}

fn vitest_no_test_files(command: &str, output: &str) -> bool {
    // A bounded runner diagnostic: contradictory summaries or compiler and
    // setup failures keep their ordinary classification.
    let parts: Vec<&str> = AND_AND.split(js_trim(command)).collect();
    if parts.len() > 2 || (parts.len() == 2 && !TSC_STEP.is_match(parts[0])) {
        return false;
    }
    VITEST_STEP.is_match(parts[parts.len() - 1])
        && VITEST_BANNER.find_iter(output).count() == 1
        && NO_TEST_FILES.find_iter(output).count() == 1
        && !VITEST_FAILURE.is_match(output)
}

fn mocha_reported_counts(output: &str) -> Option<Json> {
    let mut values: Vec<Option<u64>> = Vec::new();
    let mut any = false;
    for field in ["passing", "failing", "pending", "skipped"] {
        let expression =
            Regex::new(&format!(r"(?m)^\s*(\d+) {field}(?: \([^\r\n]*\))?\s*$")).expect("pattern");
        let hits: Vec<u64> = expression
            .captures_iter(output)
            .filter_map(|captures| captures[1].parse().ok())
            .collect();
        if hits.len() > 1 {
            return None;
        }
        any |= !hits.is_empty();
        values.push(hits.first().copied());
    }
    if !any {
        return None;
    }
    let value = |index: usize| values[index].map_or(Json::Null, Json::from);
    Some(
        obj! { "passed" => value(0), "failed" => value(1), "pending" => value(2), "skipped" => value(3) },
    )
}

fn runner_counts(command: &str, output: &str) -> Option<Counts> {
    if NODE_TEST.is_match(command) {
        let field = |name: &str| {
            let expression =
                Regex::new(&format!(r"(?m)^(?:#|ℹ) {name} (\d+)\s*$")).expect("pattern");
            let hits: Vec<u64> = expression
                .captures_iter(output)
                .filter_map(|captures| captures[1].parse().ok())
                .collect();
            (hits.len() == 1).then(|| hits[0])
        };
        if let (Some(total), Some(passed), Some(failed), Some(skipped), Some(0), Some(todo)) = (
            field("tests"),
            field("pass"),
            field("fail"),
            field("skipped"),
            field("cancelled"),
            field("todo"),
        ) && total == passed + failed + skipped + todo
        {
            return Some(Counts {
                executed: passed + failed,
                passed,
                failed,
                skipped: skipped + todo,
            });
        }
    }
    if PYTEST.is_match(command) {
        let summaries: Vec<String> = PYTEST_SUMMARY
            .captures_iter(output)
            .map(|captures| captures[1].to_string())
            .collect();
        if summaries.len() != 1 {
            return None;
        }
        let summary = &summaries[0];
        if PYTEST_ERRORS.is_match(summary) || !PYTEST_COUNTED.is_match(summary) {
            return None;
        }
        let count = |label: &str| labelled_count(summary, label);
        let (passed, failed) = (count("passed"), count("failed"));
        return Some(Counts {
            executed: passed + failed,
            passed,
            failed,
            skipped: count("skipped") + count("xfailed") + count("xpassed"),
        });
    }
    if VITEST_OR_JEST.is_match(command) {
        let summaries: Vec<String> = TESTS_SUMMARY
            .captures_iter(output)
            .map(|captures| captures[1].to_string())
            .collect();
        if summaries.len() != 1 || !TOTAL.is_match(&summaries[0]) {
            return None;
        }
        let summary = &summaries[0];
        let count = |label: &str| labelled_count(summary, label);
        let (passed, failed, skipped) = (
            count("passed"),
            count("failed"),
            count("skipped") + count("todo"),
        );
        let total = TOTAL
            .captures(summary)
            .and_then(|captures| captures.get(1).or(captures.get(2)))
            .and_then(|value| value.as_str().parse::<u64>().ok());
        if total == Some(passed + failed + skipped) {
            return Some(Counts {
                executed: passed + failed,
                passed,
                failed,
                skipped,
            });
        }
    }
    None
}

fn labelled_count(summary: &str, label: &str) -> u64 {
    js(&format!(r"(\d+) {label}\b"))
        .captures(summary)
        .and_then(|captures| captures[1].parse().ok())
        .unwrap_or(0)
}

fn node_file_worker_label(line: &str) -> bool {
    let label = WORKER_SPEC
        .captures(line)
        .or_else(|| WORKER_TAP.captures(line))
        .map(|captures| captures[1].to_string());
    label.is_some_and(|label| SOURCE_LABEL.is_match(js_trim(&label)))
}

/// Vitest's typecheck heading, as a diagnostic that never proves which test
/// files were typechecked (Vitest 3.2.4 prints "no errors" with none selected).
pub fn test_type_evidence(command: &str, output: &str, interrupted: bool) -> Option<Json> {
    if !VITEST.is_match(command)
        || (!TYPECHECK_FLAG.is_match(command) && !TYPE_ERRORS_HEADING.is_match(output))
    {
        return None;
    }
    let parts: Vec<&str> = AND_AND.split(js_trim(command)).collect();
    let last = parts[parts.len() - 1];
    let literal = parts.len() <= 2
        && (parts.len() == 1 || TSC_STEP.is_match(parts[0]))
        && VITEST_STEP.is_match(last);
    let banners: Vec<String> = VERSION_BANNER
        .captures_iter(output)
        .map(|captures| captures[1].to_string())
        .collect();
    let supported = literal && !interrupted && banners.len() == 1 && banners[0] == "3.2.4";
    let tokens: Vec<&str> = if supported {
        SPACES.split(last).collect()
    } else {
        Vec::new()
    };
    let summaries: Vec<String> = TYPE_ERRORS_SUMMARY
        .captures_iter(output)
        .map(|captures| captures[1].to_string())
        .collect();
    let summary = (supported && summaries.len() == 1).then(|| js_trim(&summaries[0]).to_string());
    let failed = summary
        .as_deref()
        .and_then(|summary| FAILED_SUMMARY.captures(summary))
        .and_then(|captures| captures[1].parse::<u64>().ok());
    // The heading counts failing typecheck cases, not suite-level compiler
    // errors: Vitest can print "no errors" next to a failed TypeCheckError suite.
    let contradictory = summary.as_deref() == Some("no errors") && TYPECHECK_ERROR.is_match(output);
    let reported = if contradictory {
        "unknown"
    } else if summary.as_deref() == Some("no errors") {
        "none"
    } else if failed.is_some_and(|failed| failed > 0) {
        "present"
    } else {
        "unknown"
    };
    Some(obj! {
        "runner" => "vitest",
        "requested" => boolean_flag(&tokens, &["typecheck", "typecheck.enabled"], Some("typecheck.only")).map_or(Json::Null, Json::from),
        "sourceErrorsIgnored" => boolean_flag(&tokens, &["typecheck.ignoreSourceErrors"], None).map_or(Json::Null, Json::from),
        "reportedErrors" => reported,
        "testFileSelection" => "unknown",
        "note" => "Vitest runtime and typecheck selections differ. Summary text and case counts establish no delivered-test typecheck coverage; file selection is unknown. This diagnostic grants no verification.",
    })
}

fn boolean_flag(tokens: &[&str], names: &[&str], enabling_only: Option<&str>) -> Option<bool> {
    let mut values: Vec<bool> = Vec::new();
    for (index, token) in tokens.iter().enumerate() {
        for name in names.iter().copied().chain(enabling_only) {
            let negative = *token == format!("--no-{name}");
            let matched = *token == format!("--{name}")
                || negative
                || *token == format!("--{name}=true")
                || *token == format!("--{name}=false");
            if !matched {
                continue;
            }
            let next = tokens.get(index + 1).copied();
            let value = !(negative
                || token.ends_with("=false")
                || (*token == format!("--{name}") && next == Some("false")));
            if Some(name) != enabling_only || value {
                values.push(value);
            }
        }
    }
    (!values.is_empty() && values.iter().all(|value| *value == values[0])).then(|| values[0])
}

/// A typecheck task of the test's package, offered after runtime tests.
#[derive(Clone, Debug)]
pub struct TypecheckSelection {
    pub task: String,
    pub cwd: String,
}

pub fn typecheck_selections(tasks: &[Task], cwd: &str) -> Vec<TypecheckSelection> {
    tasks
        .iter()
        .filter(|task| catalog::kind(task) == "typecheck" && catalog::cwd(task) == cwd)
        .take(3)
        .map(|task| TypecheckSelection {
            task: catalog::task_id(task).to_string(),
            cwd: catalog::cwd(task).to_string(),
        })
        .collect()
}

/// Forwarded arguments and runtime cases do not establish a wrapper's
/// static-check mode: said when changed tests or arguments make it matter.
pub fn runtime_test_scope(
    check: &Json,
    script: Option<&str>,
    args: &[String],
    changed_paths: &[String],
    selections: &[TypecheckSelection],
) -> Option<Json> {
    let tests: Vec<&String> = changed_paths
        .iter()
        .filter(|path| CHANGED_TEST.is_match(path))
        .collect();
    if tests.is_empty() && args.is_empty() {
        return None;
    }
    let executed = check
        .get("counts")
        .and_then(|counts| counts.get("executed"))
        .cloned()
        .unwrap_or(Json::Null);
    Some(
        obj! { "kind" => "runtime_test_scope", "runtimeCases" => executed, "testCompilation" => "not_established" }
            .with_opt("declaredScript", script)
            .with("forwardedArgs", Json::Arr(args.iter().take(12).map(|arg| Json::from(utf16_prefix(arg, 512))).collect()))
            .with("forwardedArgsSha256", sha256_hex(Json::Arr(args.iter().map(Json::from).collect()).stringify().as_bytes()))
            .with("argumentsTruncated", args.len() > 12 || args.iter().any(|arg| utf16_len(arg) > 512))
            .with("argumentInterpretation", if args.is_empty() { "no_extra_arguments" } else { "defined_by_script_not_verified" })
            .with("changedTypeScriptTests", Json::Arr(tests.iter().take(12).map(|path| Json::from(path.as_str())).collect()))
            .with("changedTestCount", tests.len())
            .with("omittedTests", tests.len().saturating_sub(12))
            .with(
                "nextTypecheckSelections",
                Json::Arr(
                    selections
                        .iter()
                        .take(3)
                        .map(|item| {
                            let input = obj! { "kind" => "project", "task" => item.task.as_str() }.with_opt("packagePath", (item.cwd != ".").then_some(item.cwd.as_str()));
                            obj! { "input" => input, "coverage" => "inspect_configuration" }
                        })
                        .collect(),
                ),
            )
            .with("guidance", "These runtime results do not establish compilation of changed test files. Arguments are forwarded to the declared script; an argument named types does not prove a compiler mode was selected. Inspect the script/configuration and run the actual test compiler when needed. Listed typecheck tasks are selections, not proof of file coverage. This diagnostic runs no command and admits no verification."),
    )
}

fn quoted(text: &str, kind: &str, wanted: &str, quote: char) -> bool {
    kind == wanted && text.len() >= 2 && text.starts_with(quote) && text.ends_with(quote)
}

static PLAIN_WORD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_./:@%=,+-]+$").expect("pattern"));
static UNSAFE_STRING: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[$`\\\r\n]").expect("pattern"));

/// A literal `npm test -- …` / `npm run <script> -- …` selection of one
/// catalogued npm test task; never shell expansion or compound commands.
pub fn project_test_command(
    command: &str,
    cwd: &str,
    tasks: &[Task],
) -> Option<(String, Vec<String>)> {
    // The raw command runs in cmd.exe on Windows: Bash quoting does not apply.
    if cfg!(windows) {
        return None;
    }
    let parsed = parse_code("command.sh", command.as_bytes());
    let tree = parsed.trees.first()?;
    let root = tree.root.root();
    let nodes: Vec<_> = root.children().collect();
    if nodes.len() != 1 || nodes[0].kind() != "command" || nodes[0].text() != js_trim(command) {
        return None;
    }
    let mut words: Vec<String> = Vec::new();
    for node in nodes[0].children() {
        let (text, kind) = (node.text().to_string(), node.kind());
        let word = if (kind == "word" || kind == "command_name") && PLAIN_WORD.is_match(&text) {
            text
        } else if quoted(&text, &kind, "raw_string", '\'')
            || (quoted(&text, &kind, "string", '"') && !UNSAFE_STRING.is_match(&text))
        {
            text[1..text.len() - 1].to_string()
        } else {
            return None;
        };
        words.push(word);
    }
    if words.first().map(String::as_str) != Some("npm") {
        return None;
    }
    let (script, offset) = match words.get(1).map(String::as_str) {
        Some("run") => (words.get(2).cloned(), 3),
        Some("test") => (Some("test".to_string()), 2),
        _ => (None, 2),
    };
    // npm options before -- are not arguments passed to the test script.
    let script = script?;
    if words.get(offset).map(String::as_str) != Some("--") {
        return None;
    }
    let args: Vec<String> = words[offset + 1..].to_vec();
    if args.len() > 32
        || args
            .iter()
            .any(|arg| arg.is_empty() || utf16_len(arg) > 2_048 || arg.contains('\0'))
    {
        return None;
    }
    let candidates: Vec<&Task> = tasks
        .iter()
        .filter(|task| {
            catalog::cwd(task) == cwd
                && catalog::kind(task) == "test"
                && catalog::text(task, "package_manager") == Some("npm")
                && catalog::text(task, "script") == Some(script.as_str())
        })
        .collect();
    (candidates.len() == 1).then(|| (catalog::task_id(candidates[0]).to_string(), args))
}

/// `checkReporting`: recorded evidence as reported, never inferred counters.
pub fn check_reporting(check: &Json, include_guidance: bool) -> Json {
    let field = |key: &str| check.get(key).cloned();
    let count = |key: &str| {
        check
            .get("counts")
            .and_then(|counts| counts.get(key))
            .filter(|value| !matches!(value, Json::Null))
            .cloned()
    };
    let reported = |key: &str| {
        check
            .get("reportedCounts")
            .and_then(|counts| counts.get(key))
            .filter(|value| !matches!(value, Json::Null))
            .cloned()
    };
    obj! {
        "process" => field("process").unwrap_or(Json::Null),
        "exitCode" => field("exitCode").unwrap_or(Json::Null),
        "execution" => field("execution").unwrap_or(Json::Null),
        "outcome" => field("outcome").unwrap_or(Json::Null),
        "counts" => obj! {
            "executed" => count("executed").unwrap_or(Json::Null),
            "passed" => count("passed").or_else(|| reported("passed")).unwrap_or(Json::Null),
            "failed" => count("failed").or_else(|| reported("failed")).unwrap_or(Json::Null),
            "skipped" => count("skipped").or_else(|| reported("skipped")).unwrap_or(Json::Null),
            "pending" => reported("pending").unwrap_or(Json::Null),
        },
        "evidenceOrigin" => field("evidenceOrigin").unwrap_or(Json::Null),
        "selection" => field("selection").unwrap_or(Json::Null),
    }
    .with_opt("selectionFailure", field("selectionFailure"))
    .with_opt("typechecking", field("typechecking"))
    .with("freshness", field("freshness").unwrap_or(Json::Null))
    .with("admission", "unverified")
    .with_opt(
        "guidance",
        include_guidance.then_some("Null means unreported, never zero. Pending is distinct from skipped. Counters follow the runner (some combine skipped/todo). Process success, passing tests, admitted source verification and user acceptance are separate claims."),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn observes_runner_output() {
        let result = CommandResult {
            all: "# tests 2\n# pass 2\n# fail 0\n# skipped 0\n# cancelled 0\n# todo 0\n",
            exit_code: Some(0),
            failed: false,
            interruption: None,
        };
        let check = observe_check("node --test", &result, ".", false, None, false, None);
        assert_eq!(check.get("outcome").and_then(Json::as_str), Some("passed"));
        assert_eq!(
            check.get("evidenceOrigin").and_then(Json::as_str),
            Some("runner_output")
        );
        assert!(is_test_invocation("npx vitest run"));
        assert!(!is_test_invocation("ls"));
    }
}
