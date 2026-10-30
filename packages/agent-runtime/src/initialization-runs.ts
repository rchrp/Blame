import { randomUUID } from "node:crypto";
import type { ClineCore, CoreSessionEvent } from "@cline/sdk";
import {
  initializationCorrection,
  type InitializationCorrection,
  type RuntimeClineResult,
} from "./cline-initialization.js";
import { clineSessionToolEvent } from "./cline-runtime-events.js";
import type { InitializationProgressReporter } from "./initialization-progress.js";
import {
  InitializationBlockedError,
  type InitializationSession,
} from "./initialization-session.js";

// Initialization responses take under a minute. A model that loops inside
// its submission streams until the provider's output limit, about 12 minutes,
// and the ChatGPT backend accepts no lower limit.
export function initializationResponseLimitMs(reasoningEffort?: string) {
  return reasoningEffort === "xhigh" || reasoningEffort === "max"
    ? 10 * 60_000
    : 4 * 60_000;
}

type InitializationRuns<T> = {
  cline: Pick<ClineCore, "subscribe" | "stop" | "abort">;
  session: InitializationSession<T>;
  progress: Pick<InitializationProgressReporter, "tool" | "restarting">;
  correction?: InitializationCorrection;
  responseLimitMs: number;
  start: (
    sessionId: string,
    correction: InitializationCorrection | undefined,
  ) => Promise<RuntimeClineResult>;
};

/**
 * Runs the initialization agent until Blame accepts its setup or it reports
 * what blocks it. A second session starts only when the first ended without
 * an outcome, including a response stopped for running past its limit.
 */
export async function runInitializationSessions<T>(
  runs: InitializationRuns<T>,
): Promise<{ result: T; sessionId: string }> {
  let correction = runs.correction;
  let timedOut = false;
  for (let run = 1; run <= 2; run += 1) {
    const sessionId = `${Date.now()}_${randomUUID().replaceAll("-", "").slice(0, 5)}`;
    const ran = await followSession(runs, sessionId, correction);
    const outcome = runs.session.outcome();
    if (outcome.type === "accepted") return { result: outcome.result, sessionId };
    if (outcome.type === "blocked")
      throw new InitializationBlockedError(outcome.blocked);
    if (outcome.type === "stopped") throw outcome.error;
    timedOut = ran.timedOut;
    if (timedOut) runs.progress.restarting();
    correction = initializationCorrection(
      outcome.lastRejection?.input ?? ran.result?.result?.text ?? "",
      timedOut
        ? `Your previous response was stopped after ${minutes(runs.responseLimitMs)} minutes because it never ended, most likely repeating text inside the submission. Submit a compact result in which every string, object and array is closed.`
        : (outcome.lastRejection?.error ??
            "The session ended without calling submit_project_initialization."),
    );
  }
  throw new Error(
    timedOut
      ? `The model's answer ran for over ${minutes(runs.responseLimitMs)} minutes without ending. Run the analysis again, or choose another model.`
      : "Project initialization agent did not submit a result",
  );
}

// Every tool call ends a model response, so the limit restarts on each one.
async function followSession<T>(
  runs: InitializationRuns<T>,
  sessionId: string,
  correction: InitializationCorrection | undefined,
) {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      void Promise.allSettled([
        runs.cline.stop(sessionId),
        runs.cline.abort(sessionId, "The model response ran past its time limit"),
      ]);
    }, runs.responseLimitMs);
  };
  const unsubscribe = await runs.cline.subscribe(
    (event: CoreSessionEvent) => {
      const activity = clineSessionToolEvent(event);
      if (!activity) return;
      limit();
      if (activity.phase === "started") runs.progress.tool(activity.toolName);
    },
    { sessionId },
  );
  limit();
  try {
    const result = await runs.start(sessionId, correction);
    return { result, timedOut };
  } catch (error) {
    if (timedOut) return { result: undefined, timedOut };
    throw error;
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
}

function minutes(milliseconds: number) {
  return Math.round(milliseconds / 60_000);
}
