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
  /** Cancels the run: its current session stops and no other one starts. */
  signal?: AbortSignal;
  start: (
    sessionId: string,
    correction: InitializationCorrection | undefined,
  ) => Promise<RuntimeClineResult>;
};

/** The person cancelled the analysis: no session of it runs any more. */
export class InitializationCancelledError extends Error {
  constructor() {
    super("Project initialization cancelled");
    this.name = "InitializationCancelledError";
  }
}

/**
 * The initialization runs of a runtime by their progress id, the id the app
 * chose for the run: the app cancels the run it started with it.
 */
export class InitializationCancellations {
  private readonly runs = new Map<string, AbortController>();

  /** Follows a run until `release`. A run without a progress id cannot be cancelled. */
  track(progressId: string | undefined) {
    const controller = new AbortController();
    if (progressId) this.runs.set(progressId, controller);
    return {
      signal: controller.signal,
      release: () => {
        if (progressId && this.runs.get(progressId) === controller)
          this.runs.delete(progressId);
      },
    };
  }

  /** False when no run with this id is in progress, or it already ended. */
  cancel(progressId: string) {
    const controller = this.runs.get(progressId);
    if (!controller) return false;
    controller.abort();
    return true;
  }
}

/**
 * Runs the initialization agent until Blame accepts its setup or it reports
 * what blocks it. A second session starts only when the first ended without
 * an outcome, including a response stopped for running past its limit. A
 * cancelled run stops its session and starts none.
 */
export async function runInitializationSessions<T>(
  runs: InitializationRuns<T>,
): Promise<{ result: T; sessionId: string }> {
  let correction = runs.correction;
  let timedOut = false;
  for (let run = 1; run <= 2; run += 1) {
    throwIfCancelled(runs.signal);
    const sessionId = `${Date.now()}_${randomUUID().replaceAll("-", "").slice(0, 5)}`;
    const ran = await followSession(runs, sessionId, correction);
    throwIfCancelled(runs.signal);
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
      stopSession(
        runs.cline,
        sessionId,
        "The model response ran past its time limit",
      );
    }, runs.responseLimitMs);
  };
  const cancel = () =>
    stopSession(runs.cline, sessionId, "The analysis was cancelled");
  const unsubscribe = await runs.cline.subscribe(
    (event: CoreSessionEvent) => {
      const activity = clineSessionToolEvent(event);
      if (!activity) return;
      limit();
      if (activity.phase === "started") runs.progress.tool(activity.toolName);
    },
    { sessionId },
  );
  runs.signal?.addEventListener("abort", cancel, { once: true });
  limit();
  try {
    throwIfCancelled(runs.signal);
    const result = await runs.start(sessionId, correction);
    return { result, timedOut };
  } catch (error) {
    if (runs.signal?.aborted) throw new InitializationCancelledError();
    if (timedOut) return { result: undefined, timedOut };
    throw error;
  } finally {
    clearTimeout(timer);
    runs.signal?.removeEventListener("abort", cancel);
    unsubscribe();
  }
}

function stopSession(
  cline: InitializationRuns<unknown>["cline"],
  sessionId: string,
  reason: string,
) {
  void Promise.allSettled([
    cline.stop(sessionId),
    cline.abort(sessionId, reason),
  ]);
}

function throwIfCancelled(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw new InitializationCancelledError();
}

function minutes(milliseconds: number) {
  return Math.round(milliseconds / 60_000);
}
