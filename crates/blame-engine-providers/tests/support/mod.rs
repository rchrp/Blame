//! What the wire tests share: a local HTTP server that records each request
//! and answers with a scripted reply, and builders for model requests.

#![allow(dead_code)]

use async_trait::async_trait;
use blame_engine_core::ports::{
    BlobSource, CachePlan, ModelEvent, ModelMessage, ModelProvider, ModelRequest, ProviderError,
    StoreError,
};
use blame_engine_protocol::rpc::Credential;
use blame_engine_protocol::{
    AssistantBlock, ModelRef, ReasoningEffort, ToolEffect, ToolSpec, UserBlock,
};
use futures_util::StreamExt;
use serde_json::{Value, json};
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
        self.requests.lock().expect("lock").clone()
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
    recorded.lock().expect("lock").push(Recorded {
        method,
        target,
        headers,
        body,
    });
    let reply = replies.lock().expect("lock").pop_front();
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
    }
}

/// Blobs held in memory, by hash.
#[derive(Default)]
pub struct Blobs(pub HashMap<String, Vec<u8>>);

#[async_trait]
impl BlobSource for Blobs {
    async fn blob(&self, sha256: &str) -> Result<Option<Vec<u8>>, StoreError> {
        Ok(self.0.get(sha256).cloned())
    }
}

pub fn model(provider: &str, model: &str) -> ModelRef {
    ModelRef {
        provider: provider.to_owned(),
        model: model.to_owned(),
    }
}

pub fn tool(name: &str) -> ToolSpec {
    ToolSpec {
        name: name.to_owned(),
        description: format!("The {name} tool."),
        input_schema: json!({
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"],
        }),
        effect: ToolEffect::ReadOnly,
        ends_turn: false,
        needs_approval: false,
    }
}

pub fn user(text: &str) -> ModelMessage {
    ModelMessage::User(vec![UserBlock::Text {
        text: text.to_owned(),
    }])
}

pub fn request(model: ModelRef, messages: Vec<ModelMessage>) -> ModelRequest {
    ModelRequest {
        model,
        system: "You are a test.".to_owned(),
        messages,
        tools: vec![tool("get_weather"), tool("read_file")],
        reasoning: Some(ReasoningEffort::High),
        max_output_tokens: Some(1000),
        cache: CachePlan {
            key: "session-1".to_owned(),
            breakpoints: vec![0],
            long_lived_prefix: true,
        },
        blobs: Arc::new(Blobs::default()),
    }
}

pub fn api_key(key: &str, base_url: &str) -> Credential {
    Credential::ApiKey {
        key: key.to_owned(),
        base_url: Some(base_url.to_owned()),
    }
}

/// Every event of a reply, and the error that ended it if one did.
pub async fn run(
    provider: &dyn ModelProvider,
    request: ModelRequest,
) -> (Vec<ModelEvent>, Option<ProviderError>) {
    let mut stream = match provider.stream(request).await {
        Ok(stream) => stream,
        Err(error) => return (Vec::new(), Some(error)),
    };
    let mut events = Vec::new();
    while let Some(item) = stream.next().await {
        match item {
            Ok(event) => events.push(event),
            Err(error) => {
                assert!(stream.next().await.is_none(), "an error ends the stream");
                return (events, Some(error));
            }
        }
    }
    (events, None)
}

/// The blocks a reply finished with, in order.
pub fn finished_blocks(events: &[ModelEvent]) -> Vec<AssistantBlock> {
    events
        .iter()
        .filter_map(|event| match event {
            ModelEvent::BlockFinished { block, .. } => Some(block.clone()),
            _ => None,
        })
        .collect()
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
