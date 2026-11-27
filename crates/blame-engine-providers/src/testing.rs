//! A local HTTP server that stands in for a model provider: it records each
//! request and answers with scripted replies, in order. Shared by this
//! crate's wire tests and by the binary's end-to-end tests, which point a
//! real engine process at it.

use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// One request as the server received it.
#[derive(Clone, Debug)]
pub struct Recorded {
    pub method: String,
    /// Path and query.
    pub target: String,
    pub headers: HashMap<String, String>,
    pub body: Value,
}

impl Recorded {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).map(String::as_str)
    }
}

pub enum Body {
    /// The whole body, then the connection closes cleanly.
    Whole(String),
    /// The first bytes of a chunked body, then the connection drops before
    /// the body ends, as when a network path dies mid-reply.
    Cut(String),
    /// The first bytes, then nothing while the connection stays open.
    Stall(String),
    /// A chunked body sent piece by piece, each after its wait, then ended
    /// cleanly: a reply that takes its time.
    Paced(Vec<(Duration, String)>),
}

pub struct Reply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Body,
}

impl Reply {
    pub fn sse(body: &str) -> Self {
        Self {
            status: 200,
            headers: vec![("content-type".into(), "text/event-stream".into())],
            body: Body::Whole(body.to_owned()),
        }
    }

    pub fn json(status: u16, body: Value) -> Self {
        Self {
            status,
            headers: vec![("content-type".into(), "application/json".into())],
            body: Body::Whole(body.to_string()),
        }
    }

    pub fn with_header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }
}

pub struct Mock {
    pub base: String,
    requests: Arc<Mutex<Vec<Recorded>>>,
}

impl Mock {
    /// Answers the requests it receives with `replies`, in order.
    pub async fn start(replies: Vec<Reply>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let base = format!("http://{}", listener.local_addr().expect("address"));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let replies = Arc::new(Mutex::new(VecDeque::from(replies)));
        let recorded = Arc::clone(&requests);
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                let recorded = Arc::clone(&recorded);
                let replies = Arc::clone(&replies);
                tokio::spawn(async move { serve(stream, recorded, replies).await });
            }
        });
        Self { base, requests }
    }

    pub fn requests(&self) -> Vec<Recorded> {
        self.requests
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    pub fn only_request(&self) -> Recorded {
        let requests = self.requests();
        assert_eq!(requests.len(), 1, "one request expected: {requests:#?}");
        requests.into_iter().next().expect("one request")
    }
}

async fn serve(
    mut stream: TcpStream,
    recorded: Arc<Mutex<Vec<Recorded>>>,
    replies: Arc<Mutex<VecDeque<Reply>>>,
) {
    let mut data = Vec::new();
    let mut chunk = [0u8; 8192];
    let head_end = loop {
        if let Some(at) = data.windows(4).position(|window| window == b"\r\n\r\n") {
            break at + 4;
        }
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(read) => data.extend_from_slice(&chunk[..read]),
        }
    };
    let head = String::from_utf8_lossy(&data[..head_end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut request_line = lines.next().unwrap_or_default().split_whitespace();
    let method = request_line.next().unwrap_or_default().to_owned();
    let target = request_line.next().unwrap_or_default().to_owned();
    let headers: HashMap<String, String> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_owned()))
        .collect();
    let length: usize = headers
        .get("content-length")
        .and_then(|length| length.parse().ok())
        .unwrap_or(0);
    while data.len() < head_end + length {
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(read) => data.extend_from_slice(&chunk[..read]),
        }
    }
    let raw = &data[head_end..head_end + length];
    let body = serde_json::from_slice(raw)
        .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(raw).into_owned()));
    recorded
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .push(Recorded {
            method,
            target,
            headers,
            body,
        });
    let reply = replies
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .pop_front();
    let Some(reply) = reply else {
        let _ = stream
            .write_all(b"HTTP/1.1 500 Internal Server Error\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
            .await;
        return;
    };
    let mut head = format!(
        "HTTP/1.1 {} Scripted\r\nconnection: close\r\n",
        reply.status
    );
    for (name, value) in &reply.headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    match reply.body {
        Body::Whole(body) => {
            head.push_str(&format!("content-length: {}\r\n\r\n", body.len()));
            let _ = stream.write_all(head.as_bytes()).await;
            let _ = stream.write_all(body.as_bytes()).await;
            let _ = stream.shutdown().await;
        }
        Body::Cut(first) => {
            head.push_str("transfer-encoding: chunked\r\n\r\n");
            let _ = stream.write_all(head.as_bytes()).await;
            let chunk = format!("{:x}\r\n{first}\r\n", first.len());
            let _ = stream.write_all(chunk.as_bytes()).await;
            let _ = stream.flush().await;
            tokio::time::sleep(Duration::from_millis(50)).await;
            // Dropped without the final chunk: the body never ends.
        }
        Body::Stall(first) => {
            head.push_str("transfer-encoding: chunked\r\n\r\n");
            let _ = stream.write_all(head.as_bytes()).await;
            let chunk = format!("{:x}\r\n{first}\r\n", first.len());
            let _ = stream.write_all(chunk.as_bytes()).await;
            let _ = stream.flush().await;
            tokio::time::sleep(Duration::from_secs(30)).await;
        }
        Body::Paced(pieces) => {
            head.push_str("transfer-encoding: chunked\r\n\r\n");
            let _ = stream.write_all(head.as_bytes()).await;
            for (wait, piece) in pieces {
                tokio::time::sleep(wait).await;
                let chunk = format!("{:x}\r\n{piece}\r\n", piece.len());
                let _ = stream.write_all(chunk.as_bytes()).await;
                let _ = stream.flush().await;
            }
            let _ = stream.write_all(b"0\r\n\r\n").await;
            let _ = stream.shutdown().await;
        }
    }
}

/// An SSE body of `event:`/`data:` pairs.
pub fn sse(events: &[(&str, Value)]) -> String {
    events
        .iter()
        .map(|(name, data)| format!("event: {name}\ndata: {data}\n\n"))
        .collect()
}

/// An SSE body of bare `data:` lines, as Gemini and Chat Completions send.
pub fn data_lines(events: &[Value]) -> String {
    events
        .iter()
        .map(|data| format!("data: {data}\n\n"))
        .collect()
}
