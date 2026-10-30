import assert from "node:assert/strict";
import test from "node:test";

import type { CoreSessionEvent } from "@cline/sdk";
import type { InitializationCorrection } from "./cline-initialization.js";
import {
  initializationResponseLimitMs,
  runInitializationSessions,
} from "./initialization-runs.js";
import { InitializationSession } from "./initialization-session.js";

/** A stand-in for the agent SDK: each session runs `script` until stopped. */
function fakeCline(
  script: (session: {
    id: string;
    run: number;
    tool: (name: string) => void;
    stopped: Promise<void>;
  }) => Promise<void>,
) {
  const listeners = new Map<string, (event: CoreSessionEvent) => void>();
  const stops = new Map<string, () => void>();
  const corrections: (InitializationCorrection | undefined)[] = [];
  const stoppedSessions: string[] = [];
  const cline = {
    subscribe: async (
      listener: (event: CoreSessionEvent) => void,
      { sessionId }: { sessionId: string },
    ) => {
      listeners.set(sessionId, listener);
      return () => listeners.delete(sessionId);
    },
    stop: async (sessionId: string) => {
      stoppedSessions.push(sessionId);
      stops.get(sessionId)?.();
    },
    abort: async () => {},
  };
  const start = async (
    sessionId: string,
    correction: InitializationCorrection | undefined,
  ) => {
    corrections.push(correction);
    const stopped = new Promise<void>((resolve) => stops.set(sessionId, resolve));
    const tool = (toolName: string) =>
      listeners.get(sessionId)?.({
        type: "hook",
        payload: { hookEventName: "tool_call", toolName },
      } as unknown as CoreSessionEvent);
    await script({ id: sessionId, run: corrections.length, tool, stopped });
    return { sessionId, result: { text: "" } };
  };
  return { cline, start, corrections, stoppedSessions };
}

function progress() {
  const steps: string[] = [];
  return {
    steps,
    tool: (name: string) => steps.push(`tool:${name}`),
    restarting: () => steps.push("restarting"),
  };
}

const accepting = () =>
  new InitializationSession((input) => input as { ok: boolean });

test("stops an answer that never ends and starts the analysis again", async () => {
  const session = accepting();
  const fake = fakeCline(async ({ run, tool, stopped }) => {
    tool("read_files");
    if (run === 1) return stopped; // The model loops until Blame stops it.
    tool("submit_project_initialization");
    session.submit({ ok: true });
  });
  const steps = progress();

  const done = await runInitializationSessions({
    cline: fake.cline,
    session,
    progress: steps,
    responseLimitMs: 30,
    start: fake.start,
  });

  assert.deepEqual(done.result, { ok: true });
  assert.equal(fake.stoppedSessions.length, 1);
  assert.notEqual(fake.stoppedSessions[0], done.sessionId);
  assert.equal(fake.corrections[0], undefined);
  assert.match(fake.corrections[1]!.validationError, /never ended/);
  assert.deepEqual(steps.steps, [
    "tool:read_files",
    "restarting",
    "tool:read_files",
    "tool:submit_project_initialization",
  ]);
});

test("gives each answer its own time, so a long analysis is not cut", async () => {
  const session = accepting();
  const pause = () => new Promise((resolve) => setTimeout(resolve, 20));
  const fake = fakeCline(async ({ tool }) => {
    for (const name of ["read_files", "search_codebase", "read_files"]) {
      await pause();
      tool(name);
    }
    await pause();
    session.submit({ ok: true });
  });

  const done = await runInitializationSessions({
    cline: fake.cline,
    session,
    progress: progress(),
    responseLimitMs: 50,
    start: fake.start,
  });

  assert.deepEqual(done.result, { ok: true });
  assert.deepEqual(fake.stoppedSessions, []);
});

test("says the model never finished when the second answer loops too", async () => {
  const fake = fakeCline(async ({ stopped }) => stopped);
  await assert.rejects(
    runInitializationSessions({
      cline: fake.cline,
      session: accepting(),
      progress: progress(),
      responseLimitMs: 20,
      start: fake.start,
    }),
    /ran for over 0 minutes without ending\. Run the analysis again, or choose another model\./,
  );
  assert.equal(fake.stoppedSessions.length, 2);
});

test("an aborted start that throws still counts as a stopped answer", async () => {
  const session = accepting();
  const fake = fakeCline(async ({ run, stopped }) => {
    if (run === 1) {
      await stopped;
      throw new Error("aborted");
    }
    session.submit({ ok: true });
  });
  const done = await runInitializationSessions({
    cline: fake.cline,
    session,
    progress: progress(),
    responseLimitMs: 20,
    start: fake.start,
  });
  assert.deepEqual(done.result, { ok: true });
});

test("keeps the previous rejection when a session ends without a result", async () => {
  const session = new InitializationSession((input) => {
    if (!(input as { ok: boolean }).ok) throw new Error("must start the API");
    return input;
  });
  const fake = fakeCline(async ({ run }) => {
    if (run === 1) {
      assert.throws(() => session.submit({ ok: false }));
      return;
    }
    session.submit({ ok: true });
  });
  await runInitializationSessions({
    cline: fake.cline,
    session,
    progress: progress(),
    responseLimitMs: 1_000,
    start: fake.start,
  });
  assert.match(fake.corrections[1]!.validationError, /must start the API/);
  assert.equal(fake.corrections[1]!.previousResult, '{"ok":false}');
});

test("gives high reasoning efforts more time per answer", () => {
  assert.equal(initializationResponseLimitMs(), 240_000);
  assert.equal(initializationResponseLimitMs("medium"), 240_000);
  assert.equal(initializationResponseLimitMs("xhigh"), 600_000);
});
