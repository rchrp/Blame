//! Where protocol messages come from and go to. The rest of the engine sees
//! a stream of text messages in and a sink of text messages out, one JSON-RPC
//! message each, so the stdio transport used today and a WebSocket one later
//! (one text frame per message) are interchangeable.

use async_trait::async_trait;
use std::io;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter, Stdin, Stdout};

/// Incoming messages. `None` once the peer is gone for good.
#[async_trait]
pub trait Inbound: Send {
    async fn next(&mut self) -> Option<io::Result<String>>;
}

/// Outgoing messages, written in the order they are given.
#[async_trait]
pub trait Outbound: Send {
    /// Queues one message. `flush` says whether more are coming right away,
    /// so a transport can batch them.
    async fn send(&mut self, message: &str, flush: bool) -> io::Result<()>;

    async fn flush(&mut self) -> io::Result<()>;
}

/// The engine's own stdin and stdout: what the desktop app uses, directly or
/// through `limactl shell` / `wsl.exe`.
pub fn stdio() -> (StdinLines, StdoutLines) {
    (
        StdinLines {
            reader: BufReader::with_capacity(64 << 10, tokio::io::stdin()),
            line: String::new(),
        },
        StdoutLines {
            writer: BufWriter::with_capacity(64 << 10, tokio::io::stdout()),
        },
    )
}

pub struct StdinLines {
    reader: BufReader<Stdin>,
    line: String,
}

#[async_trait]
impl Inbound for StdinLines {
    async fn next(&mut self) -> Option<io::Result<String>> {
        loop {
            self.line.clear();
            match self.reader.read_line(&mut self.line).await {
                Ok(0) => return None,
                Ok(_) => {
                    let message = self.line.trim();
                    // Blank lines (a stray `\r\n` from a Windows pipe) are
                    // not messages.
                    if !message.is_empty() {
                        return Some(Ok(message.to_owned()));
                    }
                }
                Err(error) => return Some(Err(error)),
            }
        }
    }
}

pub struct StdoutLines {
    writer: BufWriter<Stdout>,
}

#[async_trait]
impl Outbound for StdoutLines {
    async fn send(&mut self, message: &str, flush: bool) -> io::Result<()> {
        // serde_json never writes a raw newline inside a message.
        self.writer.write_all(message.as_bytes()).await?;
        self.writer.write_all(b"\n").await?;
        if flush {
            self.writer.flush().await?;
        }
        Ok(())
    }

    async fn flush(&mut self) -> io::Result<()> {
        self.writer.flush().await
    }
}
