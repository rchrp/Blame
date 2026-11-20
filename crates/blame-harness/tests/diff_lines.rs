//! `diff::diff_lines` gives jsdiff 9's parts: `fixtures/diff-lines.jsonl`
//! holds jsdiff's own output for 400 random line pairs (LF and CRLF).

use blame_harness::diff::diff_lines;
use blame_harness::json::Json;

#[test]
fn parts_match_jsdiff() {
    for line in include_str!("fixtures/diff-lines.jsonl").lines() {
        let case = Json::parse(line).unwrap();
        let (old, new) = (
            case.get("old").and_then(Json::as_str).unwrap(),
            case.get("new").and_then(Json::as_str).unwrap(),
        );
        let parts: Vec<Json> = diff_lines(old, new)
            .into_iter()
            .map(|part| {
                blame_harness::obj! { "value" => part.value, "added" => part.added, "removed" => part.removed, "count" => part.count }
            })
            .collect();
        assert_eq!(
            Json::Arr(parts).stringify(),
            case.get("parts").unwrap().stringify(),
            "{old:?} -> {new:?}"
        );
    }
}
