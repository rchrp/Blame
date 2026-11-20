//! The engine binary: wires the store, the providers, the checkpointer and
//! the tool hosts to the core loop, and serves the client protocol.
//!
//! ```text
//! blame-engine serve --data-dir DIR [--harness-command CMD]
//!                    [--idle-timeout SECONDS] [--durability full|os-crash|relaxed]
//!                    [--task-retention SECONDS]
//! blame-engine auth chatgpt login [--device] [--auth-base URL]
//! blame-engine auth chatgpt refresh [--auth-base URL]   (refresh token on stdin)
//! blame-engine catalog
//! blame-engine --version
//! ```

mod auth;
mod connection;
mod engine;
mod log;
mod ports;
mod server;
mod tools;
mod transport;

use crate::engine::Settings;
use crate::log::log;
use crate::tools::{Harness, HarnessCommand};
use blame_engine_store::Durability;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

const USAGE: &str = "usage:
  blame-engine serve --data-dir DIR [--harness-command CMD] [--idle-timeout SECONDS]
                     [--durability full|os-crash|relaxed] [--task-retention SECONDS]
  blame-engine auth chatgpt login [--device] [--auth-base URL]
  blame-engine auth chatgpt refresh [--auth-base URL]    (refresh token on stdin)
  blame-engine catalog
  blame-engine --version";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let words: Vec<&str> = args.iter().map(String::as_str).collect();
    let result = match words.as_slice() {
        ["--version" | "-V" | "version"] => {
            println!(
                "blame-engine {} (protocol {})",
                env!("CARGO_PKG_VERSION"),
                blame_engine_protocol::PROTOCOL_VERSION
            );
            Ok(())
        }
        ["--help" | "-h" | "help"] => {
            println!("{USAGE}");
            Ok(())
        }
        ["serve", rest @ ..] => parse_serve(rest).and_then(serve),
        ["catalog"] => print_json(&blame_engine_providers::catalog::providers()),
        ["auth", "chatgpt", "login", rest @ ..] => {
            auth::Login::parse(rest).and_then(|login| runtime()?.block_on(login.run()))
        }
        ["auth", "chatgpt", "refresh", rest @ ..] => {
            auth::Refresh::parse(rest).and_then(|refresh| runtime()?.block_on(refresh.run()))
        }
        _ => Err(format!("unknown command\n{USAGE}")),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("blame-engine: {message}");
            ExitCode::FAILURE
        }
    }
}

fn print_json<T: serde::Serialize>(value: &T) -> Result<(), String> {
    let text = serde_json::to_string(value).map_err(|error| error.to_string())?;
    println!("{text}");
    Ok(())
}

/// One thread for everything async: sessions mostly wait (on the model, on
/// tools, on the store's own threads), and git and SQLite never run on it.
fn runtime() -> Result<tokio::runtime::Runtime, String> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("cannot start the runtime: {error}"))
}

/// The value of `--name VALUE` or `--name=VALUE`.
pub fn options<'a>(
    args: &[&'a str],
    known: &[&str],
    flags: &[&str],
) -> Result<Vec<(String, Option<&'a str>)>, String> {
    let mut parsed = Vec::new();
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        let (name, inline) = match arg.split_once('=') {
            Some((name, value)) => (name, Some(value)),
            None => (*arg, None),
        };
        if flags.contains(&name) {
            parsed.push((name.to_owned(), None));
        } else if known.contains(&name) {
            let value = match inline {
                Some(value) => value,
                None => rest
                    .next()
                    .copied()
                    .ok_or_else(|| format!("{name} needs a value"))?,
            };
            parsed.push((name.to_owned(), Some(value)));
        } else {
            return Err(format!("unknown option {arg}\n{USAGE}"));
        }
    }
    Ok(parsed)
}

fn parse_serve(args: &[&str]) -> Result<Settings, String> {
    let mut data_dir = None;
    let mut harness = None;
    let mut idle_after = Duration::from_secs(10 * 60);
    let mut durability = Durability::Full;
    let mut task_retention = engine::TASK_RETENTION;
    for (name, value) in options(
        args,
        &[
            "--data-dir",
            "--harness-command",
            "--idle-timeout",
            "--durability",
            "--task-retention",
        ],
        &[],
    )? {
        let value = value.unwrap_or_default();
        match name.as_str() {
            "--data-dir" => data_dir = Some(PathBuf::from(value)),
            "--harness-command" => harness = Some(HarnessCommand::parse(value)?),
            "--idle-timeout" => {
                idle_after = Duration::from_secs(
                    value
                        .parse()
                        .map_err(|_| format!("--idle-timeout takes seconds, not {value}"))?,
                );
            }
            "--task-retention" => {
                task_retention = Duration::from_secs(
                    value
                        .parse()
                        .map_err(|_| format!("--task-retention takes seconds, not {value}"))?,
                );
            }
            "--durability" => {
                durability = match value {
                    "full" => Durability::Full,
                    "os-crash" => Durability::OsCrash,
                    "relaxed" => Durability::Relaxed,
                    other => return Err(format!("unknown durability {other}")),
                };
            }
            _ => unreachable!("only known options are returned"),
        }
    }
    Ok(Settings {
        data_dir: data_dir.ok_or("serve needs --data-dir")?,
        durability,
        idle_after,
        harness: harness.map(|command| Arc::new(Harness::new(command))),
        task_retention,
    })
}

fn serve(settings: Settings) -> Result<(), String> {
    log!(
        Info,
        "serving {} (data in {})",
        env!("CARGO_PKG_VERSION"),
        settings.data_dir.display()
    );
    let runtime = runtime()?;
    runtime.block_on(async {
        let (inbound, outbound) = transport::stdio();
        server::serve(settings, Box::new(inbound), Box::new(outbound)).await;
    });
    // What is left are parked tasks holding nothing that is not already on
    // disk, and tokio's thread blocked reading stdin, which only the
    // client can end: do not wait for it.
    runtime.shutdown_background();
    Ok(())
}
