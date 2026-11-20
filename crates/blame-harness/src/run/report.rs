//! Test reports a check's own invocation wrote (`test-report.ts`) and the
//! Node event side channel (`node-event-evidence.ts`): parsed only when the
//! harness owns them, never discovered.

use crate::identity::sha256_hex;
use crate::json::Json;
use crate::obj;
use crate::text::{js_trim, utf16_prefix};
use regex::Regex;
use std::sync::LazyLock;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Counts {
    pub executed: u64,
    pub passed: u64,
    pub failed: u64,
    pub skipped: u64,
}

impl Counts {
    pub fn to_json(self) -> Json {
        obj! { "executed" => self.executed, "passed" => self.passed, "failed" => self.failed, "skipped" => self.skipped }
    }
}

#[derive(Clone, Debug, Default)]
pub struct TestReport {
    pub counts: Counts,
    pub setup_failed: bool,
    /// `{ message, path?, line? }`.
    pub failures: Vec<Json>,
}

pub fn parse_test_reports(sources: &[String]) -> Option<TestReport> {
    if sources.is_empty() || sources.len() > 1_000 {
        return None;
    }
    let mut combined = TestReport::default();
    for source in sources {
        let report = parse_test_report(source)?;
        combined.counts.executed += report.counts.executed;
        combined.counts.passed += report.counts.passed;
        combined.counts.failed += report.counts.failed;
        combined.counts.skipped += report.counts.skipped;
        combined.setup_failed |= report.setup_failed;
        combined.failures.extend(report.failures);
        combined.failures.truncate(2);
    }
    Some(combined)
}

static DOCTYPE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)<!DOCTYPE|<!ENTITY").expect("pattern"));
static TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<[^>]*>").expect("pattern"));
static DIGITS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d+$").expect("pattern"));

/// Only the supplied invocation's report; it never grants freshness.
pub fn parse_test_report(source: &str) -> Option<TestReport> {
    if source.len() > 2 * 1024 * 1024 {
        return None;
    }
    let text = js_trim(source);
    if text.starts_with('{') {
        return jest_report(text);
    }
    if !text.starts_with('<') || DOCTYPE.is_match(text) {
        return None;
    }
    // Bound nesting before building a tree; refuse opaque declarations.
    let (mut depth, mut tags) = (0i64, 0usize);
    for token in TAG.find_iter(text) {
        tags += 1;
        if tags > 100_000 {
            return None;
        }
        let token = token.as_str();
        if token.starts_with("</") {
            depth -= 1;
        } else if !token.starts_with("<!") && !token.starts_with("<?") && !token.ends_with("/>") {
            depth += 1;
        }
        if !(0..=64).contains(&depth) {
            return None;
        }
    }
    let document = roxmltree::Document::parse(text).ok()?;
    let root = document.root_element();
    match root.tag_name().name() {
        "testsuite" | "testsuites" => junit(root),
        "TestRun" => trx(root),
        _ => None,
    }
}

type Node<'a, 'input> = roxmltree::Node<'a, 'input>;

/// `getElementsByTagNameNS("*", name)`: descendants, the node excluded.
fn elements<'a, 'input>(node: Node<'a, 'input>, name: &str) -> Vec<Node<'a, 'input>> {
    node.descendants()
        .skip(1)
        .filter(|item| item.is_element() && item.tag_name().name() == name)
        .collect()
}

fn integer(value: Option<&str>) -> Option<u64> {
    value
        .filter(|value| DIGITS.is_match(value))
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value <= 9_007_199_254_740_991)
}

fn text_content(node: Node<'_, '_>) -> String {
    node.descendants()
        .filter(|item| item.is_text())
        .filter_map(|item| item.text())
        .collect()
}

fn junit(root: Node<'_, '_>) -> Option<TestReport> {
    let cases = elements(root, "testcase");
    let mut suites = elements(root, "testsuite");
    if root.tag_name().name() == "testsuite" {
        suites.insert(0, root);
    }
    if suites.is_empty() {
        return None;
    }
    if suites.iter().any(|suite| {
        integer(suite.attribute("tests")) != Some(elements(*suite, "testcase").len() as u64)
    }) {
        return None;
    }
    if root.tag_name().name() == "testsuites"
        && root.has_attribute("tests")
        && integer(root.attribute("tests")) != Some(cases.len() as u64)
    {
        return None;
    }
    let mut result = TestReport::default();
    for item in &cases {
        let mut failures = elements(*item, "failure");
        failures.extend(elements(*item, "error"));
        if !failures.is_empty() {
            result.counts.failed += 1;
            let path = item.attribute("file").filter(|path| !path.is_empty());
            let line = integer(item.attribute("line")).filter(|line| *line > 0);
            for failure in failures {
                let content = text_content(failure);
                let message = if !content.is_empty() {
                    content
                } else {
                    failure
                        .attribute("message")
                        .filter(|message| !message.is_empty())
                        .unwrap_or("Test failed")
                        .to_string()
                };
                result.failures.push(
                    obj! { "message" => utf16_prefix(&message, 2_000) }
                        .with_opt("path", path)
                        .with_opt("line", line),
                );
            }
        } else if !elements(*item, "skipped").is_empty() {
            result.counts.skipped += 1;
        } else {
            result.counts.passed += 1;
        }
    }
    let leaves: Vec<&Node<'_, '_>> = suites
        .iter()
        .filter(|suite| elements(**suite, "testsuite").is_empty())
        .collect();
    let reported: u64 = leaves
        .iter()
        .map(|suite| {
            integer(suite.attribute("errors")).unwrap_or(0)
                + integer(suite.attribute("failures")).unwrap_or(0)
        })
        .sum();
    result.setup_failed = reported > result.counts.failed;
    result.counts.executed = result.counts.passed + result.counts.failed;
    result.failures.truncate(2);
    Some(result)
}

fn trx(root: Node<'_, '_>) -> Option<TestReport> {
    let counters = elements(root, "Counters");
    if counters.len() != 1 {
        return None;
    }
    let counter = counters[0];
    let total = integer(counter.attribute("total"))?;
    let executed = integer(counter.attribute("executed"))?;
    let passed = integer(counter.attribute("passed"))?;
    let failed = integer(counter.attribute("failed"))?;
    let cases = elements(root, "UnitTestResult");
    if total != cases.len() as u64 || executed != passed + failed {
        return None;
    }
    let outcome = |item: &Node<'_, '_>| item.attribute("outcome").unwrap_or("").to_string();
    if cases
        .iter()
        .any(|item| !["Passed", "Failed", "NotExecuted"].contains(&outcome(item).as_str()))
    {
        return None;
    }
    if cases
        .iter()
        .filter(|item| outcome(item) == "Passed")
        .count() as u64
        != passed
        || cases
            .iter()
            .filter(|item| outcome(item) == "Failed")
            .count() as u64
            != failed
    {
        return None;
    }
    let summaries = elements(root, "ResultSummary");
    if summaries.len() != 1 {
        return None;
    }
    let setup_failed = summaries
        .iter()
        .any(|item| !["Completed", "Passed"].contains(&item.attribute("outcome").unwrap_or("")));
    let failures = cases
        .iter()
        .filter(|item| outcome(item) == "Failed")
        .take(2)
        .map(|item| {
            let message = elements(*item, "Message")
                .into_iter()
                .map(text_content)
                .collect::<Vec<_>>()
                .join("\n");
            obj! { "message" => utf16_prefix(&message, 2_000) }
        })
        .collect();
    Some(TestReport {
        counts: Counts {
            executed,
            passed,
            failed,
            skipped: total - executed,
        },
        setup_failed,
        failures,
    })
}

fn safe_count(value: Option<&Json>) -> Option<u64> {
    let number = value?.as_f64()?;
    (number.fract() == 0.0 && (0.0..=9_007_199_254_740_991.0).contains(&number))
        .then_some(number as u64)
}

fn jest_report(text: &str) -> Option<TestReport> {
    let data = Json::parse(text).ok()?;
    let total = safe_count(data.get("numTotalTests"))?;
    let passed = safe_count(data.get("numPassedTests"))?;
    let failed = safe_count(data.get("numFailedTests"))?;
    let pending = safe_count(data.get("numPendingTests"))?;
    let todo = match data.get("numTodoTests") {
        None | Some(Json::Null) => 0,
        value => safe_count(value)?,
    };
    let results = data.get("testResults")?.as_array()?;
    if total != passed + failed + pending + todo {
        return None;
    }
    let assertions: Vec<&Json> = results
        .iter()
        .flat_map(|suite| {
            suite
                .get("assertionResults")
                .and_then(Json::as_array)
                .map(|items| items.iter().collect::<Vec<_>>())
                .unwrap_or_default()
        })
        .collect();
    let status = |wanted: &str| {
        assertions
            .iter()
            .filter(|item| item.get("status").and_then(Json::as_str) == Some(wanted))
            .count() as u64
    };
    if assertions.len() as u64 != total || status("passed") != passed || status("failed") != failed
    {
        return None;
    }
    Some(TestReport {
        counts: Counts {
            executed: passed + failed,
            passed,
            failed,
            skipped: pending + todo,
        },
        setup_failed: data.get("success").and_then(Json::as_bool) != Some(true),
        failures: Vec::new(),
    })
}

/// An invocation-owned Node reporter's events (`blame-node-events-v1`).
pub struct NodeEventBinding {
    pub report: Option<String>,
    pub invocation_id: String,
    pub reporter_sha256: String,
}

pub struct NodeEvidence {
    pub counts: Counts,
    pub failed: bool,
    pub evidence: Json,
}

#[derive(Clone, Copy, Default)]
struct EventCounts {
    tests: u64,
    passed: u64,
    failed: u64,
    skipped: u64,
    todo: u64,
    cancelled: u64,
}

fn event_counts(value: Option<&Json>) -> Option<EventCounts> {
    let fields = value.filter(|value| value.is_object())?;
    let field = |key: &str| safe_count(fields.get(key)).filter(|count| *count <= 10_000_000);
    let counts = EventCounts {
        tests: field("tests")?,
        passed: field("passed")?,
        failed: field("failed")?,
        skipped: field("skipped")?,
        todo: field("todo")?,
        cancelled: field("cancelled")?,
    };
    (counts.tests
        == counts.passed + counts.failed + counts.skipped + counts.todo + counts.cancelled)
        .then_some(counts)
}

pub fn node_event_evidence(binding: &NodeEventBinding) -> Option<NodeEvidence> {
    let report = binding.report.as_deref()?;
    if report.is_empty() || report.len() > 2 * 1024 * 1024 {
        return None;
    }
    let mut events = Vec::new();
    for line in js_trim(report).split('\n') {
        events.push(Json::parse(line).ok()?);
    }
    let header = events.first()?;
    let runner = header.get("runner").filter(|runner| runner.is_object())?;
    let version = runner.get("version").and_then(Json::as_str)?;
    if header.get("format").and_then(Json::as_str) != Some("blame-node-events-v1")
        || !version.starts_with("v24.")
        || runner.get("executable").and_then(Json::as_str).is_none()
        || events.last()?.get("type").and_then(Json::as_str) != Some("complete")
    {
        return None;
    }
    let mut files: Vec<(String, EventCounts)> = Vec::new();
    let mut last: Option<EventCounts> = None;
    for event in &events[1..events.len() - 1] {
        if last.is_some() {
            return None;
        }
        let value = event_counts(event.get("counts"))?;
        if event.get("type").and_then(Json::as_str) != Some("summary") || value.cancelled > 0 {
            return None;
        }
        match event.get("file") {
            None => last = Some(value),
            Some(Json::Str(file))
                if !file.is_empty() && !files.iter().any(|(known, _)| known == file) =>
            {
                files.push((file.clone(), value))
            }
            Some(_) => return None,
        }
    }
    let last = last?;
    let mut totals = EventCounts::default();
    for (_, file) in &files {
        totals.tests += file.tests;
        totals.passed += file.passed;
        totals.failed += file.failed;
        totals.skipped += file.skipped;
        totals.todo += file.todo;
    }
    // Final aggregates include inert or failing file workers: never cases.
    if last.tests < totals.tests
        || last.passed < totals.passed
        || last.failed < totals.failed
        || last.skipped != totals.skipped
        || last.todo != totals.todo
    {
        return None;
    }
    Some(NodeEvidence {
        counts: Counts {
            executed: totals.passed + totals.failed,
            passed: totals.passed,
            failed: totals.failed,
            skipped: totals.skipped + totals.todo,
        },
        failed: last.failed > 0,
        evidence: obj! {
            "invocationId" => binding.invocation_id.as_str(),
            "reporterSha256" => binding.reporter_sha256.as_str(),
            "reportSha256" => sha256_hex(report.as_bytes()),
            "runner" => runner.clone(),
            "caseFiles" => Json::Arr(files.iter().take(128).map(|(file, _)| Json::from(file)).collect()),
            "caseFilesTruncated" => files.len() > 128,
            "boundary" => "Actual runner/version and reported case files; dependency coverage and complete environment remain unknown.",
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_junit_and_jest() {
        let junit = r#"<testsuite tests="2" failures="1"><testcase name="a"/><testcase name="b" file="a.py" line="3"><failure message="boom"/></testcase></testsuite>"#;
        let report = parse_test_report(junit).unwrap();
        assert_eq!(
            report.counts,
            Counts {
                executed: 2,
                passed: 1,
                failed: 1,
                skipped: 0
            }
        );
        assert!(!report.setup_failed);
        assert_eq!(
            report.failures[0].stringify(),
            r#"{"message":"boom","path":"a.py","line":3}"#
        );
        let jest = r#"{"numTotalTests":1,"numPassedTests":1,"numFailedTests":0,"numPendingTests":0,"success":true,"testResults":[{"assertionResults":[{"status":"passed"}]}]}"#;
        assert_eq!(parse_test_report(jest).unwrap().counts.passed, 1);
        assert!(parse_test_report("<!DOCTYPE x><testsuite/>").is_none());
    }
}
