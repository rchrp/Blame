//! The JSON-lines protocol of `semantic-harness-runner.ts --serve`.
//!
//! The harness writes `{"ready":true,"protocol":1}`, then answers each
//! message by its `id`:
//! - `request`: a workspace operation, answered with its raw `result`;
//! - `call`: a model's tool call, validated and presented as the in-process
//!   tools present it, answered with `presented`;
//! - `describe`: the model-facing tools, answered with `tools`;
//! - `cancel`: aborts the request or call with that id.
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
    let in_flight: Arc<Mutex<HashMap<String, Signal>>> = Arc::new(Mutex::new(HashMap::new()));
    let mut workers = Vec::new();
    for line in input.lines() {
        let Ok(line) = line else { break };
        let Ok(message) = Json::parse(&line) else {
            continue;
        };
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
            continue;
        }
        if let Some(request) = message.get("describe").filter(|value| truthy(value)) {
            write(obj! { "id" => id.as_str(), "tools" => describe(request) });
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
        workers.push(thread::spawn(move || {
            let answer = if call {
                match harness.call(&request, &signal) {
                    Ok(presented) => {
                        obj! { "id" => id.as_str(), "presented" => presented.to_json() }
                    }
                    Err(failure) => obj! { "id" => id.as_str(), "error" => failure.message },
                }
            } else {
                match harness
                    .execute(&request, &signal)
                    .and_then(|result| signal.check().map(|()| result))
                {
                    Ok(result) => obj! { "id" => id.as_str(), "result" => result },
                    Err(failure) => obj! { "id" => id.as_str(), "error" => failure.message },
                }
            };
            in_flight
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .remove(&id);
            write(answer);
        }));
        workers.retain(|worker| !worker.is_finished());
    }
    // The agent closed the pipe: nothing can read results any more.
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

fn truthy(value: &Json) -> bool {
    match value {
        Json::Null => false,
        Json::Bool(value) => *value,
        Json::Num(value) => *value != 0.0 && !value.is_nan(),
        Json::Str(value) => !value.is_empty(),
        _ => true,
    }
}
