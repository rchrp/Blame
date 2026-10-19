import type {
  AgentApprovalRequest,
  AgentEvent,
  ResolveApprovalInput,
} from "@blame/agent-runtime";
import { availableParallelism } from "node:os";
import type {
  AgentRuntimeProcessCallbacks,
  AgentRuntimeProcessLike,
} from "./agent-runtime-process-client.ts";
import type { AgentRuntimeMethod } from "./agent-runtime-process-protocol.ts";

type AgentRuntimeProcessFactory = (
  callbacks: AgentRuntimeProcessCallbacks,
) => AgentRuntimeProcessLike;

type AgentRuntimePoolOptions = {
  createProcess: AgentRuntimeProcessFactory;
  handleHostRequest: AgentRuntimeProcessCallbacks["handleHostRequest"];
  maximumWorkers?: number;
  onEvent(event: AgentEvent): void;
};

type AgentWorker = {
  activeRequests: number;
  client: AgentRuntimeProcessLike;
  sessionStates: Map<string, "active" | "terminal">;
};

type ApprovalRoute = {
  toolName: string;
  worker: AgentWorker;
};

type SessionResult = {
  sessionId: string;
};

const sessionRunMethods = new Set<AgentRuntimeMethod>([
  "sessions.send",
  "sessions.sendDevelopment",
]);

export class AgentRuntimePool {
  private readonly alwaysAllowedTools = new Set<string>();
  private readonly approvalRoutes = new Map<string, ApprovalRoute>();
  private readonly maximumWorkers: number;
  private readonly options: AgentRuntimePoolOptions;
  private readonly sessionRoutes = new Map<string, AgentWorker>();
  private readonly workers: AgentWorker[] = [];
  private stopping = false;
  private telemetrySession: unknown;

  constructor(options: AgentRuntimePoolOptions) {
    this.options = options;
    this.maximumWorkers = options.maximumWorkers ?? agentRuntimeWorkerCount();
  }

  run<Result>(method: AgentRuntimeMethod, input?: unknown) {
    return this.runOnWorker<Result>(this.selectWorker(), method, input);
  }

  async startSession(
    method: "sessions.start" | "sessions.startDevelopment",
    input: unknown,
  ) {
    const worker = this.selectStartWorker(input);
    const result = await this.runOnWorker<SessionResult>(worker, method, input);
    this.routeSession(worker, result.sessionId);
    if (worker.sessionStates.get(result.sessionId) !== "terminal") {
      worker.sessionStates.set(result.sessionId, "active");
    }
    return result;
  }

  runSession<Result>(
    method: AgentRuntimeMethod,
    sessionId: string,
    input?: unknown,
  ) {
    const worker = this.sessionWorker(sessionId);
    if (sessionRunMethods.has(method)) {
      worker.sessionStates.set(sessionId, "active");
    }
    return this.runOnWorker<Result>(worker, method, input);
  }

  // True while a worker is still executing this session. False after the
  // app restarted, the worker died, or the run ended.
  sessionLive(sessionId: string) {
    const worker = this.sessionRoutes.get(sessionId);
    return Boolean(
      worker?.client.alive && worker.sessionStates.get(sessionId) === "active",
    );
  }

  async abortSession(sessionId: string) {
    const worker = this.sessionWorker(sessionId);
    try {
      await this.runOnWorker(worker, "sessions.abort", sessionId);
    } finally {
      worker.sessionStates.set(sessionId, "terminal");
    }
  }

  async resolveApproval(input: ResolveApprovalInput) {
    const route = this.approvalRoutes.get(input.requestId);
    if (input.decision === "always" && route) {
      this.alwaysAllowedTools.add(route.toolName);
    }
    this.approvalRoutes.delete(input.requestId);
    if (route) {
      return this.runOnWorker<boolean>(
        route.worker,
        "approvals.resolve",
        input,
      );
    }
    const results = await Promise.all(
      this.liveWorkers().map((worker) =>
        this.runOnWorker<boolean>(worker, "approvals.resolve", input).catch(
          () => false,
        ),
      ),
    );
    return results.some(Boolean);
  }

  async listSessions() {
    const workers = this.liveWorkers();
    const selected = workers.length ? workers : [this.createWorker()];
    const lists = await Promise.all(
      selected.map((worker) =>
        this.runOnWorker<unknown[]>(worker, "sessions.list").catch(() => []),
      ),
    );
    return uniqueSessions(lists.flat());
  }

  async releaseWorkspace(worktree: string) {
    await Promise.allSettled(
      this.liveWorkers().map((worker) =>
        this.runOnWorker(worker, "sessions.releaseWorkspace", worktree),
      ),
    );
  }

  configureTelemetry(session: unknown) {
    this.telemetrySession = session;
    return this.broadcast("telemetry.configure", session);
  }

  disableTelemetry() {
    this.telemetrySession = null;
    return this.broadcast("telemetry.disable");
  }

  cancelSecurityAudit(auditId: string) {
    return this.broadcast("securityAudits.cancel", auditId);
  }

  finishSecurityAudit(auditId: string) {
    return this.broadcast("securityAudits.finish", auditId);
  }

  async shutdown() {
    this.stopping = true;
    await Promise.allSettled(
      this.liveWorkers().map((worker) => worker.client.shutdown()),
    );
    this.workers.length = 0;
    this.sessionRoutes.clear();
    this.approvalRoutes.clear();
  }

  private selectWorker() {
    const workers = this.liveWorkers();
    if (!workers.length) return this.createWorker();
    const selected = workers.reduce((least, worker) =>
      workerLoad(worker) < workerLoad(least) ? worker : least,
    );
    if (workers.length < this.maximumWorkers && workerLoad(selected) > 0) {
      return this.createWorker();
    }
    return selected;
  }

  private sessionWorker(sessionId: string) {
    const current = this.sessionRoutes.get(sessionId);
    if (current?.client.alive) return current;
    const selected = this.selectWorker();
    this.routeSession(selected, sessionId);
    return selected;
  }

  private selectStartWorker(input: unknown) {
    const sessionId = requestedSessionId(input);
    const current = sessionId ? this.sessionRoutes.get(sessionId) : undefined;
    return current?.client.alive ? current : this.selectWorker();
  }

  private createWorker() {
    if (this.stopping) throw new Error("Agent runtime is shutting down");
    const worker = {
      activeRequests: 0,
      sessionStates: new Map<string, "active" | "terminal">(),
    } as AgentWorker;
    worker.client = this.options.createProcess({
      handleHostRequest: this.options.handleHostRequest,
      onEvent: (event) => this.handleEvent(worker, event),
      onExit: (error) => this.handleExit(worker, error),
    });
    this.workers.push(worker);
    this.configureWorkerTelemetry(worker);
    return worker;
  }

  private async runOnWorker<Result>(
    worker: AgentWorker,
    method: AgentRuntimeMethod,
    input?: unknown,
  ) {
    worker.activeRequests += 1;
    try {
      return await worker.client.request<Result>(method, input);
    } finally {
      worker.activeRequests = Math.max(0, worker.activeRequests - 1);
    }
  }

  private handleEvent(worker: AgentWorker, event: AgentEvent) {
    if (event.sessionId) this.routeSession(worker, event.sessionId);
    if (terminalEvent(event) && event.sessionId) {
      worker.sessionStates.set(event.sessionId, "terminal");
    }
    const approval = approvalRequest(event);
    if (approval && this.alwaysAllowedTools.has(approval.toolName)) {
      void this.resolveAlwaysApproval(worker, approval);
      return;
    }
    if (approval) {
      this.approvalRoutes.set(approval.id, {
        toolName: approval.toolName,
        worker,
      });
    }
    this.options.onEvent(event);
  }

  private async resolveAlwaysApproval(
    worker: AgentWorker,
    approval: AgentApprovalRequest,
  ) {
    await this.runOnWorker(worker, "approvals.resolve", {
      decision: "always",
      requestId: approval.id,
    }).catch(() => undefined);
  }

  private handleExit(worker: AgentWorker, error: Error) {
    removeItem(this.workers, worker);
    removeWorkerRoutes(this.sessionRoutes, worker);
    removeWorkerApprovals(this.approvalRoutes, worker);
    if (this.stopping) return;
    for (const sessionId of activeSessionIds(worker)) {
      this.options.onEvent({
        payload: { message: error.message },
        sessionId,
        type: "error",
      });
    }
  }

  private routeSession(worker: AgentWorker, sessionId: string) {
    this.sessionRoutes.set(sessionId, worker);
  }

  private configureWorkerTelemetry(worker: AgentWorker) {
    if (this.telemetrySession === undefined) return;
    const method =
      this.telemetrySession === null
        ? "telemetry.disable"
        : "telemetry.configure";
    const input =
      this.telemetrySession === null ? undefined : this.telemetrySession;
    void worker.client.request(method, input).catch(() => undefined);
  }

  private broadcast(method: AgentRuntimeMethod, input?: unknown) {
    return Promise.allSettled(
      this.liveWorkers().map((worker) => worker.client.request(method, input)),
    );
  }

  private liveWorkers() {
    return this.workers.filter((worker) => worker.client.alive);
  }
}

export function agentRuntimeWorkerCount(parallelism = availableParallelism()) {
  return Math.max(1, Math.min(3, parallelism - 1));
}

function workerLoad(worker: AgentWorker) {
  return worker.activeRequests + activeSessionIds(worker).length;
}

function approvalRequest(event: AgentEvent) {
  if (event.type !== "approval") return undefined;
  const payload = event.payload as Partial<AgentApprovalRequest> | undefined;
  if (!payload?.id || !payload.toolName) return undefined;
  return payload as AgentApprovalRequest;
}

function uniqueSessions(sessions: unknown[]) {
  const seen = new Set<string>();
  return sessions.filter((session) => {
    const id = sessionId(session);
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function sessionId(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const id = (value as { sessionId?: unknown }).sessionId;
  return typeof id === "string" ? id : undefined;
}

function requestedSessionId(input: unknown) {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  const requested = record.resumeSessionId ?? record.sessionId;
  return typeof requested === "string" && requested.trim()
    ? requested.trim()
    : undefined;
}

function terminalEvent(event: AgentEvent) {
  return event.type === "done" || event.type === "error";
}

function activeSessionIds(worker: AgentWorker) {
  return [...worker.sessionStates]
    .filter(([, state]) => state === "active")
    .map(([sessionId]) => sessionId);
}

function removeItem<T>(items: T[], target: T) {
  const index = items.indexOf(target);
  if (index >= 0) items.splice(index, 1);
}

function removeWorkerRoutes(
  routes: Map<string, AgentWorker>,
  worker: AgentWorker,
) {
  for (const [sessionId, route] of routes) {
    if (route === worker) routes.delete(sessionId);
  }
}

function removeWorkerApprovals(
  routes: Map<string, ApprovalRoute>,
  worker: AgentWorker,
) {
  for (const [requestId, route] of routes) {
    if (route.worker === worker) routes.delete(requestId);
  }
}
