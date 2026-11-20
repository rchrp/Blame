//! Logging to stderr. Stdout carries the protocol and nothing else, so a
//! stray line there would corrupt the client's stream; everything a human
//! may want to read goes to stderr, one line per event.
//!
//! The level comes from `BLAME_ENGINE_LOG` (`error`, `warn`, `info`,
//! `debug`), `info` by default. A logging framework would cost more than
//! these few lines do.

use std::io::Write;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    Error,
    Warn,
    Info,
    Debug,
}

impl Level {
    fn name(self) -> &'static str {
        match self {
            Self::Error => "ERROR",
            Self::Warn => "WARN",
            Self::Info => "INFO",
            Self::Debug => "DEBUG",
        }
    }
}

fn max_level() -> Level {
    static LEVEL: OnceLock<Level> = OnceLock::new();
    *LEVEL.get_or_init(|| match std::env::var("BLAME_ENGINE_LOG").as_deref() {
        Ok("error") => Level::Error,
        Ok("warn") => Level::Warn,
        Ok("debug") => Level::Debug,
        _ => Level::Info,
    })
}

pub fn enabled(level: Level) -> bool {
    level <= max_level()
}

pub fn write(level: Level, args: std::fmt::Arguments<'_>) {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    // One write per line, so lines from several tasks never interleave.
    let line = format!("{ms} {} blame-engine: {args}\n", level.name());
    let _ = std::io::stderr().lock().write_all(line.as_bytes());
}

macro_rules! log {
    ($level:ident, $($arg:tt)*) => {
        if $crate::log::enabled($crate::log::Level::$level) {
            $crate::log::write($crate::log::Level::$level, format_args!($($arg)*));
        }
    };
}

pub(crate) use log;
