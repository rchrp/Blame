//! A thread that owns one piece of blocking state (a SQLite connection) and
//! runs closures on it, one at a time, in the order they were sent.
//!
//! Why threads and not `spawn_blocking`: this crate needs no tokio runtime
//! feature, an idle store costs three parked threads, and each connection
//! stays on one thread for its whole life, which is what SQLite is fastest
//! at.

use blame_engine_core::ports::StoreError;
use std::sync::mpsc;
use std::thread::{self, JoinHandle};
use tokio::sync::oneshot;

type Job<S> = Box<dyn FnOnce(&mut S) + Send>;

pub(crate) struct Worker<S: Send + 'static> {
    jobs: Option<mpsc::Sender<Job<S>>>,
    thread: Option<JoinHandle<()>>,
}

impl<S: Send + 'static> Worker<S> {
    pub(crate) fn spawn(name: &str, mut state: S) -> Result<Self, StoreError> {
        let (jobs, queue) = mpsc::channel::<Job<S>>();
        let thread = thread::Builder::new()
            .name(name.to_owned())
            .stack_size(1 << 20)
            .spawn(move || {
                // Ends when the store is dropped and the queue is drained.
                while let Ok(job) = queue.recv() {
                    job(&mut state);
                }
            })
            .map_err(|e| StoreError::Io(format!("cannot start thread {name}: {e}")))?;
        Ok(Self {
            jobs: Some(jobs),
            thread: Some(thread),
        })
    }

    /// Runs `job` on the worker's thread and returns its result. If the
    /// caller drops this future the job still runs to its end: a started
    /// transaction is never abandoned half way.
    pub(crate) async fn run<T, F>(&self, job: F) -> Result<T, StoreError>
    where
        T: Send + 'static,
        F: FnOnce(&mut S) -> Result<T, StoreError> + Send + 'static,
    {
        let (reply, answer) = oneshot::channel();
        let stopped = || StoreError::Io("the storage thread has stopped".into());
        self.jobs
            .as_ref()
            .ok_or_else(stopped)?
            .send(Box::new(move |state| {
                let _ = reply.send(job(state));
            }))
            .map_err(|_| stopped())?;
        answer.await.map_err(|_| stopped())?
    }
}

impl<S: Send + 'static> Drop for Worker<S> {
    fn drop(&mut self) {
        // Close the queue, then wait: the connection is closed (and its lock
        // on the file released) before the store is gone, which a test or an
        // engine restarting in place relies on.
        self.jobs.take();
        if let Some(handle) = self.thread.take()
            && handle.thread().id() != thread::current().id()
        {
            let _ = handle.join();
        }
    }
}
