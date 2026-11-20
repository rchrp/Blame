import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent } from "@blame/agent-runtime";
import { AgentRuntimePool } from "./agent-runtime-pool.ts";
import type {
  AgentRuntimeProcessCallbacks,
  AgentRuntimeProcessLike,
} from "./agent-runtime-process-client.ts";
import type { AgentRuntimeMethod } from "./agent-runtime-process-protocol.ts";

test("runs one-shot work on one process, started on first use", async () => {
  const harness = poolHarness();
  assert.equal(harness.processes.length, 0);
  await Promise.all([
    harness.pool.run("promptOptimizer.generateTitle", {}),
    harness.pool.run("providers.list", {}),
  ]);
  assert.equal(harness.processes.length, 1);
  assert.deepEqual(
    harness.processes[0]!.calls.map(({ method }) => method),
    ["promptOptimizer.generateTitle", "providers.list"],
  );
});

test("starts the process again after it died", async () => {
  const harness = poolHarness();
  await harness.pool.run("providers.list", {});
  harness.processes[0]!.exit(new Error("worker failed"));
  await harness.pool.run("providers.list", {});
  assert.equal(harness.processes.length, 2);
});

test("forwards the runtime's events", async () => {
  const harness = poolHarness();
  await harness.pool.run("providers.list", {});
  const event: AgentEvent = { payload: {}, sessionId: "run", type: "done" };
  harness.processes[0]!.emit(event);
  assert.deepEqual(harness.events, [event]);
});

test("cancels audits and initializations only on a running process", async () => {
  const harness = poolHarness();
  assert.equal(await harness.pool.cancelInitialization("run-1"), false);
  assert.equal(harness.processes.length, 0);
  await harness.pool.run("providers.list", {});
  harness.processes[0]!.runningInitializations.add("run-1");
  assert.equal(await harness.pool.cancelInitialization("run-1"), true);
  assert.equal(await harness.pool.cancelInitialization("run-2"), false);
  await harness.pool.cancelSecurityAudit("audit-1");
  assert.deepEqual(harness.processes[0]!.calls.at(-1), {
    input: "audit-1",
    method: "securityAudits.cancel",
  });
});

test("closes the Claude Code processes of a released workspace's sessions", async () => {
  const harness = poolHarness();
  await harness.pool.run("providers.list", {});

  await harness.pool.releaseWorkspace("/worktree", ["session-a"]);

  assert.deepEqual(harness.processes[0]!.calls.slice(-2), [
    { input: "/worktree", method: "sessions.releaseWorkspace" },
    { input: ["session-a"], method: "claudeCode.closeSessions" },
  ]);
});

test("refuses new work once shut down", async () => {
  const harness = poolHarness();
  await harness.pool.run("providers.list", {});
  await harness.pool.shutdown();
  assert.equal(harness.processes[0]!.alive, false);
  assert.throws(() => harness.pool.run("providers.list", {}), /shutting down/);
});

type FakeCall = {
  input?: unknown;
  method: AgentRuntimeMethod;
};

class FakeAgentRuntimeProcess implements AgentRuntimeProcessLike {
  readonly calls: FakeCall[] = [];
  readonly runningInitializations = new Set<string>();
  alive = true;
  private readonly callbacks: AgentRuntimeProcessCallbacks;

  constructor(callbacks: AgentRuntimeProcessCallbacks) {
    this.callbacks = callbacks;
  }

  async request<Result>(method: AgentRuntimeMethod, input?: unknown) {
    this.calls.push({ input, method });
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

function poolHarness() {
  const events: AgentEvent[] = [];
  const processes: FakeAgentRuntimeProcess[] = [];
  const pool = new AgentRuntimePool({
    createProcess: (callbacks) => {
      const process = new FakeAgentRuntimeProcess(callbacks);
      processes.push(process);
      return process;
    },
    handleHostRequest: async () => undefined,
    onEvent: (event) => events.push(event),
  });
  return { events, pool, processes };
}
