//! `blame-harness serve`: the harness over JSON lines on stdin/stdout, the
//! protocol of `semantic-harness-runner.ts --serve`. Without `serve`, one
//! request is read from stdin and its result printed once.

use blame_harness::failure::Signal;
use blame_harness::harness::Harness;
use blame_harness::json::Json;
use std::io::{self, BufReader, Read};
use std::process::ExitCode;
use std::sync::Arc;

fn main() -> ExitCode {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    if arguments
        .iter()
        .any(|argument| argument == "--version" || argument == "-V")
    {
        println!("blame-harness {}", env!("CARGO_PKG_VERSION"));
        return ExitCode::SUCCESS;
    }
    let harness = Arc::new(Harness::default());
    if arguments
        .iter()
        .any(|argument| argument == "serve" || argument == "--serve")
    {
        blame_harness::server::serve(BufReader::new(io::stdin()), io::stdout(), harness);
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
