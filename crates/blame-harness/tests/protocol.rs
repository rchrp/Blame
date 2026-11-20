//! The served protocol and the session state across harness instances, on
//! real temporary workspaces.

use blame_harness::failure::Signal;
use blame_harness::harness::Harness;
use blame_harness::json::Json;
use blame_harness::obj;
use std::io::{BufReader, Cursor, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

struct Workspace(PathBuf);

impl Workspace {
    fn new(name: &str, files: &[(&str, &[u8])]) -> Workspace {
        let root =
            std::env::temp_dir().join(format!("blame-harness-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for (path, content) in files {
            let file = root.join(path);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, content).unwrap();
        }
        Workspace(root)
    }

    fn root(&self) -> String {
        self.0.to_string_lossy().into_owned()
    }
}

impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[derive(Clone, Default)]
struct Output(Arc<Mutex<Vec<u8>>>);

impl Write for Output {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn serve(lines: &[Json]) -> Vec<Json> {
    let input: String = lines
        .iter()
        .map(|line| format!("{}\n", line.stringify()))
        .collect();
    let output = Output::default();
    blame_harness::server::serve(
        BufReader::new(Cursor::new(input)),
        output.clone(),
        Arc::new(Harness::default()),
    );
    let text = String::from_utf8(output.0.lock().unwrap().clone()).unwrap();
    text.lines()
        .map(|line| Json::parse(line).unwrap())
        .collect()
}

fn request(tool: &str, root: &str, session: &str, input: Json) -> Json {
    obj! { "tool" => tool, "workspaceRoot" => root, "input" => input, "taskContract" => obj! { "session_id" => session } }
}

#[test]
fn serves_ready_describe_and_errors_by_id() {
    let answers = serve(&[
        obj! { "id" => "1", "describe" => Json::obj() },
        obj! { "id" => 2, "nothing" => true },
        obj! { "describe" => Json::obj() },
        Json::from("not an object"),
    ]);
    assert_eq!(answers[0].stringify(), r#"{"ready":true,"protocol":1}"#);
    let tools = answers[1].get("tools").and_then(Json::as_array).unwrap();
    assert_eq!(tools.len(), 5);
    assert_eq!(
        answers[2].stringify(),
        r#"{"id":"2","error":"A request is required."}"#
    );
    // Messages without an id are ignored.
    assert_eq!(answers.len(), 3);
}

#[test]
fn a_new_instance_resumes_the_session_from_its_journal() {
    let workspace = Workspace::new("journal", &[("a.ts", b"export const a = 1;\n")]);
    let read = request(
        "read_code",
        &workspace.root(),
        "resume",
        obj! { "target" => "a.ts" },
    );
    let first = Harness::default()
        .execute(&read, &Signal::default())
        .unwrap();
    assert_eq!(
        first.get("data").and_then(|data| data.get("complete")),
        Some(&Json::Bool(true))
    );
    // Another harness (a restarted process) replays coverage and receipts.
    let again = Harness::default()
        .execute(&read, &Signal::default())
        .unwrap();
    let directory = workspace.0.join(".blame/harness/light");
    assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 1);
    assert_eq!(again.get("receipt").and_then(Json::as_str), Some("r2"));
    let journal = std::fs::read_to_string(
        std::fs::read_dir(&directory)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path(),
    )
    .unwrap();
    assert!(journal.lines().all(|line| Json::parse(line).is_ok()));
    assert!(journal.contains(r#""type":"coverage""#));
}

#[test]
fn call_presents_validation_errors_and_results() {
    let workspace = Workspace::new(
        "call",
        &[(
            "src/a.ts",
            b"export function needle() {\n  return \"x\";\n}\n",
        )],
    );
    let harness = Harness::default();
    let invalid = harness
        .call(&obj! { "tool" => "search_code", "workspaceRoot" => workspace.root(), "input" => obj! { "query" => "" } }, &Signal::default())
        .unwrap();
    assert!(!invalid.ok);
    assert_eq!(
        invalid.content.as_str(),
        Some(
            r#"{"status":"blocked","category":"input","message":"query: Too small: expected string to have >=1 characters"}"#
        )
    );
    let found = harness
        .call(&obj! { "tool" => "search_code", "workspaceRoot" => workspace.root(), "input" => obj! { "query" => "needle", "limit" => "3" } }, &Signal::default())
        .unwrap();
    assert!(found.ok);
    let unknown = harness
        .call(
            &obj! { "tool" => "grep", "workspaceRoot" => workspace.root() },
            &Signal::default(),
        )
        .unwrap();
    assert_eq!(
        unknown.content.as_str(),
        Some("There is no harness tool named grep.")
    );
}

#[test]
fn binary_files_match_only_before_their_first_nul_when_walked() {
    // 600 files exceed the 24,000 listed characters, so the search walks.
    let names: Vec<String> = (0..600)
        .map(|index| format!("directory-with-a-long-name/file-{index:03}.txt"))
        .collect();
    let mut files: Vec<(&str, &[u8])> = names
        .iter()
        .map(|name| (name.as_str(), b"other\n" as &[u8]))
        .collect();
    files.push(("binary.dat", b"needle\n\0needle\n"));
    files.push(("text.txt", b"needle\n"));
    let workspace = Workspace::new("binary", &files);
    let search = request(
        "search_code",
        &workspace.root(),
        "binary",
        obj! { "query" => "needle", "output" => "files" },
    );
    let result = Harness::default()
        .execute(&search, &Signal::default())
        .unwrap();
    let data = result.get("data").unwrap();
    // ripgrep quits a walked file at its first NUL: none of its lines count.
    assert_eq!(
        data.get("totalMatchingLines").and_then(Json::as_f64),
        Some(1.0)
    );
    assert_eq!(
        data.get("files").unwrap().stringify(),
        r#"[{"path":"text.txt","matchingLines":1}]"#
    );
}
