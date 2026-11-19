import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent } from "@blame/agent-runtime";
import {
  AgentRuntimePool,
  agentRuntimeWorkerCount,
} from "./agent-runtime-pool.ts";
import type {
  AgentRuntimeProcessCallbacks,
  AgentRuntimeProcessLike,
} from "./agent-runtime-process-client.ts";
import type { AgentRuntimeMethod } from "./agent-runtime-process-protocol.ts";

test("reserves one core and bounds agent worker count", () => {
  assert.equal(agentRuntimeWorkerCount(1), 1);
  assert.equal(agentRuntimeWorkerCount(2), 1);
  assert.equal(agentRuntimeWorkerCount(4), 3);
  assert.equal(agentRuntimeWorkerCount(16), 3);
});

test("routes concurrent sessions to separate workers", async () => {
  const harness = poolHarness(2);
  const first = await harness.pool.startSession("sessions.start", {});
  const second = await harness.pool.startSession("sessions.start", {});

  await harness.pool.runSession("sessions.send", first.sessionId, {
    sessionId: first.sessionId,
  });

  assert.equal(harness.processes.length, 2);
  assert.equal(harness.processes[0].calls.at(-1)?.method, "sessions.send");
  assert.equal(harness.processes[1].sessionIds.has(second.sessionId), true);
});

test("reports a session live until it ends or is aborted", async () => {
  const harness = poolHarness(2);
  const first = await harness.pool.startSession("sessions.start", {});
  const second = await harness.pool.startSession("sessions.start", {});

  assert.equal(harness.pool.sessionLive(first.sessionId), true);
  assert.equal(harness.pool.sessionLive("unknown-session"), false);

  harness.processes[0].emit({ payload: {}, sessionId: first.sessionId, type: "done" });
  await harness.pool.abortSession(second.sessionId);

  assert.equal(harness.pool.sessionLive(first.sessionId), false);
  assert.equal(harness.pool.sessionLive(second.sessionId), false);
});

test("reuses an idle worker after a session completes", async () => {
  const harness = poolHarness(2);
  const first = await harness.pool.startSession("sessions.start", {});
  harness.processes[0].emit({
    payload: {},
    sessionId: first.sessionId,
    type: "done",
  });

  await harness.pool.startSession("sessions.start", {});

  assert.equal(harness.processes.length, 1);
});

test("routes resumed sessions back to their original worker", async () => {
  const harness = poolHarness(2);
  const first = await harness.pool.startSession("sessions.start", {});
  await harness.pool.startSession("sessions.start", {});

  const resumed = await harness.pool.startSession("sessions.startDevelopment", {
    resumeSessionId: first.sessionId,
  });

  assert.equal(resumed.sessionId, first.sessionId);
  assert.equal(harness.processes.length, 2);
  assert.equal(
    harness.processes[0].calls.at(-1)?.method,
    "sessions.startDevelopment",
  );
});

test("reuses a worker after a session error", async () => {
  const harness = poolHarness(2);
  const first = await harness.pool.startSession("sessions.start", {});
  harness.processes[0].emit({
    payload: {},
    sessionId: first.sessionId,
    type: "error",
  });

  await harness.pool.startSession("sessions.start", {});

  assert.equal(harness.processes.length, 1);
});

test("routes approvals and remembers always allowed tools", async () => {
  const harness = poolHarness(2);
  const first = await harness.pool.startSession("sessions.start", {});
  await harness.pool.startSession("sessions.start", {});
  harness.processes[0].emit(approvalEvent(first.sessionId, "approval-1"));

  const resolved = await harness.pool.resolveApproval({
    decision: "always",
    requestId: "approval-1",
  });
  harness.processes[1].emit(approvalEvent("session-2", "approval-2"));
  await nextTurn();

  assert.equal(resolved, true);
  assert.equal(
    harness.processes[0].calls.some(
      ({ input, method }) =>
        method === "approvals.resolve" && requestId(input) === "approval-1",
    ),
    true,
  );
  assert.equal(
    harness.processes[1].calls.some(
      ({ input, method }) =>
        method === "approvals.resolve" && requestId(input) === "approval-2",
    ),
    true,
  );
  assert.equal(
    harness.events.filter(({ type }) => type === "approval").length,
    1,
  );
});

test("reports worker failure and restarts lazily", async () => {
  const harness = poolHarness(1);
  const session = await harness.pool.startSession("sessions.start", {});

  harness.processes[0].exit(new Error("worker failed"));
  await harness.pool.startSession("sessions.start", {});

  assert.equal(harness.processes.length, 2);
  assert.deepEqual(harness.events.at(-1), {
    payload: { message: "worker failed" },
    sessionId: session.sessionId,
    type: "error",
  });
});

test("cancels a security audit on every active worker", async () => {
  const harness = poolHarness(2);
  await harness.pool.startSession("sessions.start", {});
  await harness.pool.startSession("sessions.start", {});

  await harness.pool.cancelSecurityAudit("audit-1");

  assert.equal(harness.processes.length, 2);
  for (const process of harness.processes) {
    assert.deepEqual(process.calls.at(-1), {
      input: "audit-1",
      method: "securityAudits.cancel",
    });
  }
});

test("reports whether the worker running an initialization cancelled it", async () => {
  const harness = poolHarness(2);
  await harness.pool.startSession("sessions.start", {});
  await harness.pool.startSession("sessions.start", {});
  harness.processes[1].runningInitializations.add("run-1");

  assert.equal(await harness.pool.cancelInitialization("run-1"), true);
  assert.equal(await harness.pool.cancelInitialization("run-2"), false);
  for (const process of harness.processes) {
    assert.deepEqual(process.calls.at(-1), {
      input: "run-2",
      method: "initializations.cancel",
    });
  }
});

test("sends one-off requests to an existing worker", async () => {
  const harness = poolHarness(2);
  await harness.pool.startSession("sessions.start", {});

  await harness.pool.run("promptOptimizer.generateTitle", {});

  assert.equal(harness.processes.length, 1);
  assert.equal(
    harness.processes[0].calls.at(-1)?.method,
    "promptOptimizer.generateTitle",
  );
});

test("reports a resumed session live while it runs again", async () => {
  const harness = poolHarness(1);
  const session = await harness.pool.startSession("sessions.start", {});
  harness.processes[0].emit({ payload: {}, sessionId: session.sessionId, type: "done" });

  await harness.pool.startSession("sessions.startDevelopment", {
    resumeSessionId: session.sessionId,
  });

  assert.equal(harness.pool.sessionLive(session.sessionId), true);
});

test("retires an idle extra worker and keeps the last one", async (context) => {
  context.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const harness = poolHarness(3, 60_000);
  const sessions = [
    await harness.pool.startSession("sessions.start", {}),
    await harness.pool.startSession("sessions.start", {}),
    await harness.pool.startSession("sessions.start", {}),
  ];
  harness.processes.forEach((process, index) =>
    process.emit({ payload: {}, sessionId: sessions[index]!.sessionId, type: "done" }),
  );

  await advance(context, 30_000);
  assert.equal(harness.processes.filter((process) => process.alive).length, 3);
  await advance(context, 60_000);

  assert.equal(harness.processes.filter((process) => process.alive).length, 1);
  await harness.pool.run("providers.list", {});
  assert.equal(harness.processes.length, 3);
});

test("keeps an idle worker that still holds Claude Code processes", async (context) => {
  context.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const harness = poolHarness(2, 60_000);
  const first = await harness.pool.startSession("sessions.start", {});
  const second = await harness.pool.startSession("sessions.start", {});
  harness.processes[0].emit({ payload: {}, sessionId: first.sessionId, type: "done" });
  harness.processes[0].idle = false;

  await advance(context, 120_000);

  assert.equal(harness.processes[0].alive, true);
  assert.deepEqual(
    harness.processes[0].calls.find(({ method }) => method === "runtime.idle")
      ?.input,
    { busyElsewhere: true },
  );
  assert.equal(harness.pool.sessionLive(second.sessionId), true);
});

test("an ended session's approvals no longer keep its worker", async (context) => {
  context.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const harness = poolHarness(2, 60_000);
  await harness.pool.startSession("sessions.start", {});
  const second = await harness.pool.startSession("sessions.start", {});
  harness.processes[1].emit(approvalEvent(second.sessionId, "approval-1"));
  harness.processes[1].emit({ payload: {}, sessionId: second.sessionId, type: "done" });

  await advance(context, 120_000);

  assert.equal(harness.processes[1].alive, false);
  assert.equal(harness.processes[0].alive, true);
});

test("closes the Claude Code processes of a released workspace's sessions", async () => {
  const harness = poolHarness(2);
  await harness.pool.startSession("sessions.start", {});

  await harness.pool.releaseWorkspace("/worktree", ["session-a"]);

  assert.deepEqual(harness.processes[0].calls.slice(-2), [
    { input: "/worktree", method: "sessions.releaseWorkspace" },
    { input: ["session-a"], method: "claudeCode.closeSessions" },
  ]);
});

type FakeCall = {
  input?: unknown;
  method: AgentRuntimeMethod;
};

class FakeAgentRuntimeProcess implements AgentRuntimeProcessLike {
  readonly calls: FakeCall[] = [];
  readonly id: number;
  readonly runningInitializations = new Set<string>();
  readonly sessionIds = new Set<string>();
  alive = true;
  idle = true;
  private readonly callbacks: AgentRuntimeProcessCallbacks;
  private nextSession = 1;

  constructor(id: number, callbacks: AgentRuntimeProcessCallbacks) {
    this.id = id;
    this.callbacks = callbacks;
  }

  async request<Result>(method: AgentRuntimeMethod, input?: unknown) {
    this.calls.push({ input, method });
    if (method === "sessions.start" || method === "sessions.startDevelopment") {
      const requestedSessionId = sessionInputId(input);
      if (requestedSessionId && this.sessionIds.has(requestedSessionId)) {
        return { sessionId: requestedSessionId } as Result;
      }
      const sessionId = `worker-${this.id}-session-${this.nextSession++}`;
      this.sessionIds.add(sessionId);
      return { sessionId } as Result;
    }
    if (method === "sessions.list") {
      return [...this.sessionIds].map((sessionId) => ({ sessionId })) as Result;
    }
    if (method === "approvals.resolve") return true as Result;
    if (method === "runtime.idle") return this.idle as Result;
    if (method === "initializations.cancel") {
      return this.runningInitializations.has(input as string) as Result;
    }
    return undefined as Result;
  }

  emit(event: AgentEvent) {
    this.callbacks.onEvent(event);
  }

  exit(error: Error) {
    this.alive = false;
    this.callbacks.onExit(error);
  }

  async shutdown() {
    this.alive = false;
  }
}

function poolHarness(maximumWorkers: number, idleWorkerMs?: number) {
  const events: AgentEvent[] = [];
  const processes: FakeAgentRuntimeProcess[] = [];
  const pool = new AgentRuntimePool({
    createProcess: (callbacks) => {
      const process = new FakeAgentRuntimeProcess(
        processes.length + 1,
        callbacks,
      );
      processes.push(process);
      return process;
    },
    handleHostRequest: async () => undefined,
    idleWorkerMs,
    maximumWorkers,
    onEvent: (event) => events.push(event),
  });
  return { events, pool, processes };
}

function approvalEvent(sessionId: string, id: string): AgentEvent {
  return {
    payload: {
      id,
      sessionId,
      toolName: "editor",
    },
    sessionId,
    type: "approval",
  };
}

function requestId(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  return (value as { requestId?: unknown }).requestId;
}

function sessionInputId(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  return input.resumeSessionId ?? input.sessionId;
}

/** Moves the mocked clock a minute at a time, letting retirements settle. */
async function advance(context: { mock: { timers: { tick(ms: number): void } } }, ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 12_000) {
    context.mock.timers.tick(12_000);
    for (let turn = 0; turn < 5; turn += 1) await nextTurn();
  }
}

function nextTurn() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}
