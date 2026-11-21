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

#[test]
fn a_compiler_that_cannot_start_answers_like_a_failed_worker() {
    let workspace = Workspace::new(
        "nocompiler",
        &[("a.ts", b"export function calculate() {\n  return 1;\n}\n")],
    );
    let compiler =
        blame_harness::compiler::configured(Some(r#"["/nonexistent/node","compiler.js"]"#));
    let harness = Harness::new(compiler);
    let search = request(
        "search_code",
        &workspace.root(),
        "nocompiler",
        obj! { "query" => "a.ts#calculate", "mode" => "references" },
    );
    let result = harness.execute(&search, &Signal::default()).unwrap();
    let data = result.get("data").unwrap();
    assert_eq!(
        data.get("engine").and_then(Json::as_str),
        Some("lexical_fallback")
    );
    assert_eq!(
        data.get("semanticFallback").and_then(Json::as_str),
        Some("worker_failed")
    );
}

/// `describe` gives what the TypeScript harness described for each response
/// style, environment, tool filter and the symbolic opt-in
/// (`tests/fixtures/describe.json`, recorded from `describeEngineTools`).
#[test]
fn describes_the_tools_as_the_typescript_harness_did() {
    let cases = Json::parse(include_str!("fixtures/describe.json").trim()).unwrap();
    for symbolic in [false, true] {
        let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_blame-harness"))
            .arg("serve")
            .env(
                "BLAME_AGENT_SYMBOLIC_ANALYSIS",
                if symbolic { "true" } else { "false" },
            )
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        let selected: Vec<&Json> = cases
            .as_array()
            .unwrap()
            .iter()
            .filter(|case| case.get("symbolic") == Some(&Json::Bool(symbolic)))
            .collect();
        for (index, case) in selected.iter().enumerate() {
            let line = obj! { "id" => format!("d{index}"), "describe" => case.get("request").cloned().unwrap() }.stringify();
            writeln!(stdin, "{line}").unwrap();
        }
        drop(stdin);
        let output = child.wait_with_output().unwrap();
        let text = String::from_utf8(output.stdout).unwrap();
        for (index, case) in selected.iter().enumerate() {
            let answer = text
                .lines()
                .filter_map(|line| Json::parse(line).ok())
                .find(|message| {
                    message.get("id").and_then(Json::as_str) == Some(&format!("d{index}"))
                })
                .unwrap();
            assert_eq!(
                answer.get("tools").unwrap().stringify(),
                case.get("tools").unwrap().stringify(),
                "describe {}",
                case.get("request").unwrap().stringify()
            );
        }
    }
}

/// The engine's finish_task: a verified finish answers with its summary and
/// leaves the project memory candidate the engine host saves; screenshots
/// are refused on this path, and an invalid input says what to fix.
#[test]
fn an_engine_finish_answers_its_summary_and_leaves_the_memory() {
    let workspace = Workspace::new(
        "finish-memory",
        &[
            ("index.js", b"export const answer = 42;\n"),
            (
                "package.json",
                br#"{"name":"m","private":true,"scripts":{"build":"node index.js"}}"#,
            ),
        ],
    );
    let root = workspace.root();
    let git = |args: &[&str]| {
        std::process::Command::new("git")
            .args(args)
            .current_dir(&workspace.0)
            .output()
            .unwrap();
    };
    git(&["init", "-q"]);
    git(&["add", "."]);
    git(&[
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.invalid",
        "commit",
        "-qm",
        "init",
    ]);
    let session = "finish-memory";
    let call = |id: &str, tool: &str, input: Json| {
        obj! { "id" => id, "call" => obj! {
            "tool" => tool, "workspaceRoot" => root.as_str(), "input" => input,
            "taskContract" => obj! { "session_id" => session, "objective" => "Change the answer" },
            "toolContext" => obj! { "sessionId" => session, "toolCallId" => id },
        } }
    };
    let answers = serve_in_order(&[
        call(
            "1",
            "edit_code",
            obj! { "operations" => Json::Arr(vec![obj! { "kind" => "patch", "patch" => "*** Begin Patch\n*** Update File: index.js\n@@\n-export const answer = 42;\n+export const answer = 43;\n*** End Patch" }]) },
        ),
        call(
            "2",
            "run_task",
            obj! { "kind" => "project", "task" => "build" },
        ),
        call(
            "3",
            "finish_task",
            obj! { "summary" => "  Changed the answer.  " },
        ),
        call(
            "4",
            "finish_task",
            obj! { "summary" => "x", "images" => Json::Arr(vec![obj! { "ref" => format!("screenshot:{}", "a".repeat(64)), "caption" => "after" }]) },
        ),
        call("5", "finish_task", obj! { "summary" => "" }),
        // A screenshot the engine says this conversation took is accepted.
        obj! { "id" => "6", "call" => obj! {
            "tool" => "finish_task", "workspaceRoot" => root.as_str(),
            "input" => obj! { "summary" => "Shown.", "images" => Json::Arr(vec![obj! { "ref" => format!("screenshot:{}", "b".repeat(64)), "caption" => "the card" }]) },
            "taskContract" => obj! { "session_id" => session, "objective" => "Change the answer" },
            "toolContext" => obj! { "sessionId" => session, "toolCallId" => "6" },
            "knownScreenshots" => Json::Arr(vec![Json::Str("b".repeat(64))]),
        } },
    ]);
    let presented = |id: &str| {
        answers
            .iter()
            .find(|answer| answer.get("id").and_then(Json::as_str) == Some(id))
            .and_then(|answer| answer.get("presented"))
            .cloned()
            .unwrap()
    };
    assert_eq!(
        presented("3").stringify(),
        r#"{"ok":true,"content":"Changed the answer."}"#
    );
    let memory = workspace.0.join(".blame/harness/light").join(format!(
        "{}.memory.json",
        &blame_harness::identity::sha256_hex(session.as_bytes())[..24]
    ));
    let memory =
        Json::parse(&std::fs::read_to_string(memory).expect("the memory candidate")).unwrap();
    assert_eq!(
        memory.get("validationTaskId").and_then(Json::as_str),
        Some("build")
    );
    assert_eq!(
        memory.get("objective").and_then(Json::as_str),
        Some("Change the answer")
    );
    let refused = presented("4");
    assert_eq!(refused.get("ok"), Some(&Json::Bool(false)));
    assert!(
        refused
            .get("content")
            .and_then(Json::as_str)
            .unwrap()
            .starts_with("finish_task images must be screenshots taken in this conversation.")
    );
    assert_eq!(
        presented("6").stringify(),
        r#"{"ok":true,"content":"Shown."}"#
    );
    assert_eq!(
        presented("5").get("content").and_then(Json::as_str),
        Some(
            "finish_task was not accepted: summary: Too small: expected string to have >=1 characters. Fix this and call finish_task again."
        )
    );
}

/// The binary over its pipes, one message after the other's answer.
fn serve_in_order(lines: &[Json]) -> Vec<Json> {
    use std::io::BufRead as _;
    let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_blame-harness"))
        .arg("serve")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap()).lines();
    let mut answers = vec![Json::parse(&stdout.next().unwrap().unwrap()).unwrap()];
    for line in lines {
        writeln!(stdin, "{}", line.stringify()).unwrap();
        let id = line.get("id").cloned();
        loop {
            let answer = Json::parse(&stdout.next().unwrap().unwrap()).unwrap();
            let done = answer.get("id").cloned() == id;
            answers.push(answer);
            if done {
                break;
            }
        }
    }
    drop(stdin);
    let _ = child.wait();
    answers
}

/// A run_task command of an isolated session, run by `harness`.
#[cfg(unix)]
fn command(harness: &Harness, root: &str, session: &str, text: &str) -> Json {
    let request = obj! {
        "tool" => "run_task", "workspaceRoot" => root, "input" => obj! { "kind" => "command", "command" => text },
        "taskContract" => obj! { "session_id" => session, "environment" => obj! { "isolated" => true, "managedPreview" => false } },
    };
    harness.execute(&request, &Signal::default()).unwrap()
}

/// Whether the session's workspace still knows its first run.
#[cfg(unix)]
fn run_known(harness: &Harness, root: &str, session: &str) -> bool {
    let request = obj! {
        "tool" => "run_task", "workspaceRoot" => root, "input" => obj! { "kind" => "inspect", "run" => "r1", "until" => "now" },
        "taskContract" => obj! { "session_id" => session, "environment" => obj! { "isolated" => true, "managedPreview" => false } },
    };
    harness
        .execute(&request, &Signal::default())
        .unwrap()
        .get("status")
        .and_then(Json::as_str)
        == Some("ok")
}

#[cfg(unix)]
#[test]
fn drops_workspaces_idle_past_the_limit_and_keeps_one_serving_a_request() {
    let workspace = Workspace::new("idle-cache", &[("a.txt", b"a")]);
    let root = workspace.root();
    let harness =
        Arc::new(Harness::default().with_workspace_cache(8, std::time::Duration::from_millis(300)));
    command(&harness, &root, "idle", "echo idle");
    let slow = {
        let (harness, root) = (harness.clone(), root.clone());
        std::thread::spawn(move || command(&harness, &root, "busy", "sleep 1; echo busy"))
    };
    std::thread::sleep(std::time::Duration::from_millis(700));
    assert!(!run_known(&harness, &root, "idle"));
    slow.join().unwrap();
    assert!(run_known(&harness, &root, "busy"));
}

#[cfg(unix)]
#[test]
fn keeps_the_most_recently_used_workspaces_up_to_the_limit() {
    let workspace = Workspace::new("lru-cache", &[("a.txt", b"a")]);
    let root = workspace.root();
    let harness = Harness::default().with_workspace_cache(2, std::time::Duration::from_secs(3600));
    for session in ["a", "b", "c"] {
        command(&harness, &root, session, "echo ok");
    }
    assert!(!run_known(&harness, &root, "a"));
    assert!(run_known(&harness, &root, "c"));
}

#[test]
fn a_finish_refused_for_a_failing_check_says_which_check_typed() {
    let workspace = Workspace::new(
        "finish-refused",
        &[
            ("index.js", b"process.exit(1);\n"),
            (
                "package.json",
                br#"{"name":"m","private":true,"scripts":{"build":"node index.js"}}"#,
            ),
        ],
    );
    let root = workspace.root();
    for args in [
        &["init", "-q"][..],
        &["add", "."],
        &[
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@example.invalid",
            "commit",
            "-qm",
            "init",
        ],
    ] {
        std::process::Command::new("git")
            .args(args)
            .current_dir(&workspace.0)
            .output()
            .unwrap();
    }
    let session = "finish-refused";
    let call = |id: &str, tool: &str, input: Json| {
        obj! { "id" => id, "call" => obj! {
            "tool" => tool, "workspaceRoot" => root.as_str(), "input" => input,
            "taskContract" => obj! { "session_id" => session, "objective" => "Fix the build" },
            "toolContext" => obj! { "sessionId" => session, "toolCallId" => id },
        } }
    };
    let answers = serve_in_order(&[
        call(
            "1",
            "edit_code",
            obj! { "operations" => Json::Arr(vec![obj! { "kind" => "patch", "patch" => "*** Begin Patch\n*** Update File: index.js\n@@\n-process.exit(1);\n+process.exit(2);\n*** End Patch" }]) },
        ),
        call(
            "2",
            "run_task",
            obj! { "kind" => "project", "task" => "build" },
        ),
        call(
            "3",
            "finish_task",
            obj! { "summary" => "Changed the exit code." },
        ),
    ]);
    let refused = answers
        .iter()
        .find(|answer| answer.get("id").and_then(Json::as_str) == Some("3"))
        .and_then(|answer| answer.get("presented"))
        .cloned()
        .unwrap();
    assert_eq!(refused.get("ok"), Some(&Json::Bool(false)));
    assert!(
        refused
            .get("content")
            .and_then(Json::as_str)
            .unwrap()
            .starts_with("Current validation is still failing: build."),
        "{}",
        refused.stringify()
    );
    assert_eq!(
        refused.get("refusal").map(Json::stringify).as_deref(),
        Some(r#"{"kind":"failing_checks","tasks":["build"]}"#)
    );
}
