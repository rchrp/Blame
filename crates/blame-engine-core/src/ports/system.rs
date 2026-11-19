use std::time::Duration;

/// Time as the loop sees it. Tests drive it by hand, so retries, backoff and
/// inactivity timeouts are checked without waiting.
#[async_trait::async_trait]
pub trait Clock: Send + Sync {
    /// Milliseconds since the Unix epoch.
    fn now_ms(&self) -> u64;

    async fn sleep(&self, duration: Duration);
}

/// Where turn, request, tool-call and checkpoint ids come from. A fixed
/// source makes a recorded session replay to the same records.
pub trait IdSource: Send + Sync {
    /// A new id, unique within the engine, starting with `prefix`.
    fn next(&self, prefix: &str) -> String;
}
