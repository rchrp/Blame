//! Waiting for the first of two futures, without tokio's `select!` (which
//! would pull in the `macros` feature for fifteen lines).

use std::future::{Future, poll_fn};
use std::pin::pin;
use std::task::Poll;

pub(crate) enum Either<A, B> {
    Left(A),
    Right(B),
}

/// Polls `a` first, so when both are ready `a` wins; the loser is dropped.
pub(crate) async fn first<A: Future, B: Future>(a: A, b: B) -> Either<A::Output, B::Output> {
    let mut a = pin!(a);
    let mut b = pin!(b);
    poll_fn(|cx| {
        if let Poll::Ready(value) = a.as_mut().poll(cx) {
            return Poll::Ready(Either::Left(value));
        }
        if let Poll::Ready(value) = b.as_mut().poll(cx) {
            return Poll::Ready(Either::Right(value));
        }
        Poll::Pending
    })
    .await
}
