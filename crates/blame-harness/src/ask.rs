//! Questions the harness asks its client while a call runs (`serve
//! --asks`): what only the app knows. The harness writes
//! `{"ask": {"id", "method", "params"}}` and the client answers with
//! `{"answer": {"id", "result"}}` (or `"error"`).
//!
//! - `commandCredentials` `{ sessionId, workspaceRoot }`: the credentials
//!   of the session's next command (`LightCommandCredentials`), or `null`
//!   to keep the harness's environment;
//! - `refreshPreviewDependencies` `{ sessionId, workspaceRoot }`: after a
//!   dependency operation changed files, the session's preview takes them;
//!   the answer is the `preview` field of the result, `null` for none.
//!
//! An unanswered question gives `None` after its wait: a command runs
//! without the credentials, a dependency change carries no preview state.

use crate::json::Json;
use crate::obj;
use std::collections::HashMap;
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

type Writer = Arc<dyn Fn(Json) + Send + Sync>;

#[derive(Clone, Default)]
pub struct Asker {
    inner: Arc<Mutex<Inner>>,
}

#[derive(Default)]
struct Inner {
    writer: Option<Writer>,
    pending: HashMap<String, Sender<Option<Json>>>,
    sequence: u64,
}

impl Asker {
    /// Questions go out through `writer` from now on.
    pub fn connect(&self, writer: Writer) {
        self.lock().writer = Some(writer);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Asks and waits up to `wait`; `None` without a client, on an error or
    /// after the wait.
    pub fn ask(&self, method: &str, params: Json, wait: Duration) -> Option<Json> {
        let (sender, receiver) = channel();
        let (writer, id) = {
            let mut inner = self.lock();
            let writer = inner.writer.clone()?;
            inner.sequence += 1;
            let id = format!("a{}", inner.sequence);
            inner.pending.insert(id.clone(), sender);
            (writer, id)
        };
        writer(
            obj! { "ask" => obj! { "id" => id.as_str(), "method" => method, "params" => params } },
        );
        let answer = receiver.recv_timeout(wait).ok().flatten();
        self.lock().pending.remove(&id);
        answer.filter(|answer| !matches!(answer, Json::Null))
    }

    /// An `answer` message from the client.
    pub fn answered(&self, answer: &Json) {
        let Some(id) = answer.get("id").and_then(Json::as_str) else {
            return;
        };
        let Some(sender) = self.lock().pending.remove(id) else {
            return;
        };
        let _ = sender.send(
            answer
                .get("error")
                .is_none()
                .then(|| answer.get("result").cloned().unwrap_or(Json::Null)),
        );
    }

    /// Every waiting question ends unanswered (the client went away).
    pub fn close(&self) {
        let mut inner = self.lock();
        inner.writer = None;
        inner.pending.clear();
    }
}
