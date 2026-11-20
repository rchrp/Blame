//! `blame-harness serve`: the harness over JSON lines on stdin/stdout
//! (`server.rs`, the README). Without `serve`, one
//! request is read from stdin and its result printed once.

use blame_harness::failure::Signal;
use blame_harness::harness::Harness;
use blame_harness::json::Json;
use std::io::{self, BufReader, Read};
use std::process::ExitCode;
use std::sync::Arc;

fn main() -> ExitCode {
    // The commands the harness runs must not hold its own streams.
    blame_stdio::keep_from_children();
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    if arguments
        .iter()
        .any(|argument| argument == "--version" || argument == "-V")
    {
        println!("blame-harness {}", env!("CARGO_PKG_VERSION"));
        return ExitCode::SUCCESS;
    }
    // The compiler side process: `--compiler-command '["node", ".../rust-harness-compiler.js"]'`
    // or BLAME_HARNESS_COMPILER; without it the compiler tier is unavailable.
    let flag = arguments
        .iter()
        .position(|argument| argument == "--compiler-command")
        .and_then(|index| arguments.get(index + 1).cloned());
    let command = flag.or_else(|| std::env::var("BLAME_HARNESS_COMPILER").ok());
    let harness = Arc::new(Harness::new(blame_harness::compiler::configured(
        command.as_deref(),
    )));
    if arguments
        .iter()
        .any(|argument| argument == "serve" || argument == "--serve")
    {
        // `--asks`: the client answers the harness's questions (credentials
        // of a command, a preview's dependency refresh).
        let asks = arguments.iter().any(|argument| argument == "--asks");
        blame_harness::server::serve_with(BufReader::new(io::stdin()), io::stdout(), harness, asks);
        return ExitCode::SUCCESS;
    }
    let mut text = String::new();
    if let Err(error) = io::stdin().read_to_string(&mut text) {
        eprintln!("{error}");
        return ExitCode::FAILURE;
    }
    let outcome = Json::parse(&text)
        .map_err(|error| error.to_string())
        .and_then(|request| {
            harness
                .execute(&request, &Signal::default())
                .map_err(|failure| failure.message)
        });
    match outcome {
        Ok(result) => {
            println!("{}", result.stringify());
            ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}
