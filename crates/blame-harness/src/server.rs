//! The harness's JSON-lines protocol (that of the TypeScript runner's serve
//! mode it replaced, which the engine already spoke).
//!
//! The harness writes `{"ready":true,"protocol":1}`, then answers each
//! message by its `id`:
//! - `request`: a workspace operation, answered with its raw `result`;
//! - `call`: a model's tool call, validated and presented as the in-process
//!   tools present it, answered with `presented`;
//! - `describe`: the model-facing tools, answered with `tools`;
//! - `cancel`: aborts the request or call with that id, and what it started:
//!   a command that became a managed run is still stopped by its call's
//!   cancel after the call answered, as an aborted signal stops it in process.
//!
//! Requests run on their own threads, so a slow search never delays a read;
//! one workspace's operations take turns behind its lock.

use crate::failure::Signal;
use crate::harness::Harness;
use crate::json::Json;
use crate::obj;
use crate::tools::describe;
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};
use std::thread;

pub fn serve<R: BufRead, W: Write + Send + 'static>(input: R, output: W, harness: Arc<Harness>) {
    serve_with(input, output, harness, false);
}

/// `asks`: the client answers the harness's questions (`ask.rs`).
pub fn serve_with<R: BufRead, W: Write + Send + 'static>(
    input: R,
    output: W,
    harness: Arc<Harness>,
    asks: bool,
) {
    let output = Arc::new(Mutex::new(output));
    let write = {
        let output = output.clone();
        move |value: Json| {
            let mut output = output
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let _ = writeln!(output, "{}", value.stringify());
            let _ = output.flush();
        }
    };
    write(obj! { "ready" => true, "protocol" => 1 });
    if asks {
        let write = write.clone();
        harness.asker.connect(Arc::new(write));
    }
    let in_flight: Arc<Mutex<HashMap<String, Signal>>> = Arc::new(Mutex::new(HashMap::new()));
    // Signals of answered requests, newest last: a managed run keeps its call's.
    let answered: Arc<Mutex<std::collections::VecDeque<(String, Signal)>>> =
        Arc::new(Mutex::new(std::collections::VecDeque::new()));
    let mut workers = Vec::new();
    for line in input.lines() {
        let Ok(line) = line else { break };
        let Ok(message) = Json::parse(&line) else {
            continue;
        };
        if let Some(answer) = message.get("answer") {
            harness.asker.answered(answer);
            continue;
        }
        let id = match message.get("id") {
            None | Some(Json::Null) => String::new(),
            Some(Json::Str(id)) => id.clone(),
            Some(other) => other.stringify(),
        };
        if id.is_empty() {
            continue;
        }
        if message.get("cancel").is_some_and(truthy) {
            if let Some(signal) = in_flight
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .get(&id)
            {
                signal.abort();
            }
            if let Some((_, signal)) = answered
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .iter()
                .find(|(known, _)| *known == id)
            {
                signal.abort();
            }
            continue;
        }
        if let Some(request) = message.get("describe").filter(|value| truthy(value)) {
            write(obj! { "id" => id.as_str(), "tools" => describe(request) });
            continue;
        }
        if let Some(request) = message.get("approval").filter(|value| truthy(value)) {
            let needed = crate::harness::needs_approval(request);
            write(obj! { "id" => id.as_str(), "needed" => needed });
            continue;
        }
        let (call, request) = match (
            message.get("call").filter(|value| truthy(value)),
            message.get("request").filter(|value| truthy(value)),
        ) {
            (Some(call), _) => (true, call.clone()),
            (None, Some(request)) => (false, request.clone()),
            (None, None) => {
                write(obj! { "id" => id.as_str(), "error" => "A request is required." });
                continue;
            }
        };
        let signal = Signal::default();
        in_flight
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(id.clone(), signal.clone());
        let harness = harness.clone();
        let write = write.clone();
        let in_flight = in_flight.clone();
        let answered = answered.clone();
        // A command, and a finish that runs final checks, returns its own
        // result when cancelled (an interrupted check, a refused finish),
        // never the cancellation in its place.
        let runs_commands = matches!(
            request.get("tool").and_then(Json::as_str),
            Some("run_task" | "task_runner" | "finish_task")
        );
        workers.push(thread::spawn(move || {
            let answer = if call {
                match harness.call(&request, &signal) {
                    Ok(presented) => {
                        leave_memory(&request, presented.raw.as_ref());
                        trace_call(&request, presented.raw.as_ref(), &presented.to_json());
                        obj! { "id" => id.as_str(), "presented" => presented.to_json() }
                    }
                    Err(failure) => obj! { "id" => id.as_str(), "error" => failure.message },
                }
            } else {
                match harness.execute(&request, &signal).and_then(|result| {
                    if runs_commands {
                        Ok(result)
                    } else {
                        signal.check().map(|()| result)
                    }
                }) {
                    Ok(result) => obj! { "id" => id.as_str(), "result" => result },
                    Err(failure) => obj! { "id" => id.as_str(), "error" => failure.message },
                }
            };
            in_flight
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .remove(&id);
            if runs_commands {
                let mut answered = answered
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                answered.push_back((id.clone(), signal.clone()));
                while answered.len() > 1_024 {
                    answered.pop_front();
                }
            }
            write(answer);
        }));
        workers.retain(|worker| !worker.is_finished());
    }
    // The agent closed the pipe: nothing can read results or answer.
    harness.asker.close();
    for signal in in_flight
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .values()
    {
        signal.abort();
    }
    for worker in workers {
        let _ = worker.join();
    }
}

/// An accepted finish_task may leave a memory for the project, which the
/// engine host saves to the account when the turn ends: one file per
/// session next to its journal (`completion-memory.ts`). A failure to write
/// it loses only the memory, never the finish.
fn leave_memory(call: &Json, raw: Option<&Json>) {
    if call.get("tool").and_then(Json::as_str) != Some("finish_task")
        || raw.and_then(|raw| raw.get("status")).and_then(Json::as_str) != Some("ok")
    {
        return;
    }
    let Some(memory) = raw
        .and_then(|raw| raw.get("data"))
        .and_then(|data| data.get("notification"))
        .and_then(|notification| notification.get("memory"))
    else {
        return;
    };
    let (Some(root), Some(session)) = (
        call.get("workspaceRoot").and_then(Json::as_str),
        call.get("toolContext")
            .and_then(|context| context.get("sessionId"))
            .and_then(Json::as_str),
    ) else {
        return;
    };
    let file = std::path::Path::new(root)
        .join(".blame")
        .join("harness")
        .join("light")
        .join(format!(
            "{}.memory.json",
            &crate::identity::sha256_hex(session.as_bytes())[..24]
        ));
    if let Some(directory) = file.parent() {
        let _ = std::fs::create_dir_all(directory);
    }
    let _ = std::fs::write(file, memory.stringify());
}

/// With BLAME_HARNESS_TRACE_FILE set (the benchmark runner), each call's raw
/// result is appended there: the engine keeps only what the model read, and
/// a benchmark's metrics and checks read the harness's own data.
fn trace_call(call: &Json, raw: Option<&Json>, presented: &Json) {
    let Some(file) = std::env::var_os("BLAME_HARNESS_TRACE_FILE").filter(|file| !file.is_empty())
    else {
        return;
    };
    let at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64);
    let line = obj! { "at" => at }
        .with_opt(
            "toolCallId",
            call.get("toolContext")
                .and_then(|context| context.get("toolCallId"))
                .filter(|id| !matches!(id, Json::Null))
                .cloned(),
        )
        .with("tool", call.get("tool").cloned().unwrap_or(Json::Null))
        .with_opt("input", call.get("input").cloned())
        .with_opt("raw", raw.cloned())
        .with("presented", presented.clone());
    use std::io::Write as _;
    if let Ok(mut out) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(file)
    {
        let _ = out.write_all(format!("{}\n", line.stringify()).as_bytes());
    }
}

fn truthy(value: &Json) -> bool {
    match value {
        Json::Null => false,
        Json::Bool(value) => *value,
        Json::Num(value) => *value != 0.0 && !value.is_nan(),
        Json::Str(value) => !value.is_empty(),
        _ => true,
    }
}
