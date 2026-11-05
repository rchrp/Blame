export const sessionStartTimeoutMs = 3 * 60_000;

// A session start the agent runtime never answers would leave its story or
// chat waiting forever, and the backlog would never try it again. Give up
// after a while, and stop the session if it does start after all, since
// nothing follows it any more.
export function withSessionStartDeadline<Session extends { sessionId: string }>(
  start: Promise<Session>,
  abort: (sessionId: string) => Promise<unknown>,
  timeoutMs = sessionStartTimeoutMs,
): Promise<Session> {
  let timer: NodeJS.Timeout | undefined;
  let gaveUp = false;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      gaveUp = true;
      reject(
        new Error(
          `The agent runtime did not answer within ${duration(timeoutMs)} while starting the session. If this keeps happening, restart Blame.`,
        ),
      );
    }, timeoutMs);
  });
  start.then(
    (session) => {
      if (gaveUp) void abort(session.sessionId).catch(() => undefined);
    },
    () => undefined,
  );
  return Promise.race([start, deadline]).finally(() => clearTimeout(timer));
}

function duration(ms: number) {
  return ms >= 60_000
    ? `${Math.round(ms / 60_000)} minutes`
    : `${Math.round(ms / 1_000)} seconds`;
}
