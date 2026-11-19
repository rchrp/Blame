//! Waiting on two things at once without a futures utility crate.

use std::future::{Future, poll_fn};
use std::pin::pin;
use std::task::Poll;

pub(crate) enum Either<A, B> {
    Left(A),
    Right(B),
}

/// Resolves with whichever future finishes first, polling `left` first so a
/// result that is already there always wins over a timer that is also due.
pub(crate) async fn race<A: Future, B: Future>(left: A, right: B) -> Either<A::Output, B::Output> {
    let mut left = pin!(left);
    let mut right = pin!(right);
    poll_fn(|cx| {
        if let Poll::Ready(value) = left.as_mut().poll(cx) {
            return Poll::Ready(Either::Left(value));
        }
        if let Poll::Ready(value) = right.as_mut().poll(cx) {
            return Poll::Ready(Either::Right(value));
        }
        Poll::Pending
    })
    .await
}

pub(crate) type BoxFuture<'a, T> = std::pin::Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Runs `futures` with at most `limit` in progress at once, in order, and
/// stops at the first error.
pub(crate) async fn join_limited<'a, E>(
    futures: Vec<BoxFuture<'a, Result<(), E>>>,
    limit: usize,
) -> Result<(), E> {
    let mut queue: std::collections::VecDeque<_> = futures.into();
    let mut running: Vec<BoxFuture<'a, Result<(), E>>> = Vec::new();
    let limit = limit.max(1);
    poll_fn(|cx| {
        loop {
            while running.len() < limit
                && let Some(next) = queue.pop_front()
            {
                running.push(next);
            }
            let mut finished_one = false;
            let mut index = 0;
            while index < running.len() {
                match running[index].as_mut().poll(cx) {
                    Poll::Ready(Err(error)) => return Poll::Ready(Err(error)),
                    Poll::Ready(Ok(())) => {
                        drop(running.remove(index));
                        finished_one = true;
                    }
                    Poll::Pending => index += 1,
                }
            }
            if running.is_empty() && queue.is_empty() {
                return Poll::Ready(Ok(()));
            }
            if !finished_one || queue.is_empty() {
                return Poll::Pending;
            }
        }
    })
    .await
}
