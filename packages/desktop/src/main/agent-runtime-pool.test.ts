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

test("propagates telemetry configuration to new workers", async () => {
  const harness = poolHarness(1);
  const session = { endpoint: "https://telemetry.test", token: "token" };
  await harness.pool.configureTelemetry(session);

  await harness.pool.startSession("sessions.start", {});

  assert.deepEqual(harness.processes[0].calls[0], {
    input: session,
    method: "telemetry.configure",
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

type FakeCall = {
  input?: unknown;
  method: AgentRuntimeMethod;
};

class FakeAgentRuntimeProcess implements AgentRuntimeProcessLike {
  readonly calls: FakeCall[] = [];
  readonly id: number;
  readonly sessionIds = new Set<string>();
  alive = true;
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

function poolHarness(maximumWorkers: number) {
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

function nextTurn() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}
