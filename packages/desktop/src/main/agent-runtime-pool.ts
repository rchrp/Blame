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
  /** How long a worker beyond the first stays without work before it retires. */
  idleWorkerMs?: number;
};

type AgentWorker = {
  activeRequests: number;
  activeSessions: Set<string>;
  client: AgentRuntimeProcessLike;
  /** Sessions that ended while a start on this worker had not answered yet. */
  endedDuringStart: Set<string>;
  lastWorkAt: number;
  pendingStarts: number;
  retiring: boolean;
};

type ApprovalRoute = {
  sessionId?: string;
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

// A worker holds ~220 MB once its runtime is loaded (measured 2026-11-19 on
// macOS, Electron utility process) and takes ~2 s to load it again. Extra
// workers exist for concurrent sessions: one with nothing to do for this
// long goes away, the last one stays.
const idleWorkerMs = 5 * 60_000;

export class AgentRuntimePool {
  private readonly alwaysAllowedTools = new Set<string>();
  private readonly approvalRoutes = new Map<string, ApprovalRoute>();
  private readonly maximumWorkers: number;
  private readonly idleWorkerMs: number;
  private readonly options: AgentRuntimePoolOptions;
  private readonly sessionRoutes = new Map<string, AgentWorker>();
  private readonly workers: AgentWorker[] = [];
  private retireTimer?: NodeJS.Timeout;
  private stopping = false;

  constructor(options: AgentRuntimePoolOptions) {
    this.options = options;
    this.maximumWorkers = options.maximumWorkers ?? agentRuntimeWorkerCount();
    this.idleWorkerMs = options.idleWorkerMs ?? idleWorkerMs;
  }

  /** One-off requests share the workers that exist: they never add one. */
  run<Result>(method: AgentRuntimeMethod, input?: unknown) {
    const workers = this.availableWorkers();
    const worker = workers.length ? leastLoaded(workers) : this.createWorker();
    return this.runOnWorker<Result>(worker, method, input);
  }

  async startSession(
    method: "sessions.start" | "sessions.startDevelopment",
    input: unknown,
  ) {
    const worker = this.selectStartWorker(input);
    worker.pendingStarts += 1;
    try {
      const result = await this.runOnWorker<SessionResult>(
        worker,
        method,
        input,
      );
      this.routeSession(worker, result.sessionId);
      if (!worker.endedDuringStart.has(result.sessionId)) {
        worker.activeSessions.add(result.sessionId);
      }
      return result;
    } finally {
      worker.pendingStarts -= 1;
      if (!worker.pendingStarts) worker.endedDuringStart.clear();
    }
  }

  runSession<Result>(
    method: AgentRuntimeMethod,
    sessionId: string,
    input?: unknown,
  ) {
    const worker = this.sessionWorker(sessionId);
    if (sessionRunMethods.has(method)) worker.activeSessions.add(sessionId);
    return this.runOnWorker<Result>(worker, method, input);
  }

  // True while a worker is still executing this session. False after the
  // app restarted, the worker died, or the run ended.
  sessionLive(sessionId: string) {
    const worker = this.sessionRoutes.get(sessionId);
    return Boolean(
      worker?.client.alive && worker.activeSessions.has(sessionId),
    );
  }

  async abortSession(sessionId: string) {
    const worker = this.sessionWorker(sessionId);
    try {
      await this.runOnWorker(worker, "sessions.abort", sessionId);
    } finally {
      this.endSession(worker, sessionId);
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

  /**
   * The workspace is gone: every worker lets go of its sessions there, and
   * the Claude Code processes of those sessions close.
   */
  async releaseWorkspace(worktree: string, sessionIds: string[] = []) {
    const workers = this.liveWorkers();
    await Promise.allSettled(
      workers.map((worker) =>
        this.runOnWorker(worker, "sessions.releaseWorkspace", worktree),
      ),
    );
    // The Claude Code bridge is shared: any worker reaches every lane.
    const [worker] = this.liveWorkers();
    if (worker && sessionIds.length) {
      await this.runOnWorker(
        worker,
        "claudeCode.closeSessions",
        sessionIds,
      ).catch(() => undefined);
    }
  }

  cancelSecurityAudit(auditId: string) {
    return this.broadcast("securityAudits.cancel", auditId);
  }

  finishSecurityAudit(auditId: string) {
    return this.broadcast("securityAudits.finish", auditId);
  }

  /** True when a worker was running this initialization and cancelled it. */
  async cancelInitialization(progressId: string) {
    const results = await this.broadcast("initializations.cancel", progressId);
    return results.some(
      (result) => result.status === "fulfilled" && result.value === true,
    );
  }

  async shutdown() {
    this.stopping = true;
    this.stopRetireTimer();
    await Promise.allSettled(
      this.liveWorkers().map((worker) => worker.client.shutdown()),
    );
    this.workers.length = 0;
    this.sessionRoutes.clear();
    this.approvalRoutes.clear();
  }

  private selectWorker() {
    const workers = this.availableWorkers();
    if (!workers.length) return this.createWorker();
    const selected = leastLoaded(workers);
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
      activeSessions: new Set<string>(),
      endedDuringStart: new Set<string>(),
      lastWorkAt: Date.now(),
      pendingStarts: 0,
      retiring: false,
    } as AgentWorker;
    worker.client = this.options.createProcess({
      handleHostRequest: this.options.handleHostRequest,
      onEvent: (event) => this.handleEvent(worker, event),
      onExit: (error) => this.handleExit(worker, error),
    });
    this.workers.push(worker);
    if (this.workers.length > 1) this.startRetireTimer();
    return worker;
  }

  private async runOnWorker<Result>(
    worker: AgentWorker,
    method: AgentRuntimeMethod,
    input?: unknown,
  ) {
    worker.activeRequests += 1;
    worker.lastWorkAt = Date.now();
    try {
      return await worker.client.request<Result>(method, input);
    } finally {
      worker.activeRequests = Math.max(0, worker.activeRequests - 1);
      worker.lastWorkAt = Date.now();
    }
  }

  private handleEvent(worker: AgentWorker, event: AgentEvent) {
    worker.lastWorkAt = Date.now();
    if (event.sessionId) this.routeSession(worker, event.sessionId);
    if (terminalEvent(event) && event.sessionId) {
      this.endSession(worker, event.sessionId);
    }
    const approval = approvalRequest(event);
    if (approval && this.alwaysAllowedTools.has(approval.toolName)) {
      void this.resolveAlwaysApproval(worker, approval);
      return;
    }
    if (approval) {
      this.approvalRoutes.set(approval.id, {
        sessionId: event.sessionId,
        toolName: approval.toolName,
        worker,
      });
    }
    this.options.onEvent(event);
  }

  // A finished session keeps its route, so a resume finds its worker, but
  // no state: nothing waits on its approvals any more.
  private endSession(worker: AgentWorker, sessionId: string) {
    worker.activeSessions.delete(sessionId);
    if (worker.pendingStarts) worker.endedDuringStart.add(sessionId);
    for (const [requestId, route] of this.approvalRoutes) {
      if (route.sessionId === sessionId) this.approvalRoutes.delete(requestId);
    }
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
    this.forgetWorker(worker);
    if (this.stopping) return;
    for (const sessionId of worker.activeSessions) {
      this.options.onEvent({
        payload: { message: error.message },
        sessionId,
        type: "error",
      });
    }
  }

  private forgetWorker(worker: AgentWorker) {
    removeItem(this.workers, worker);
    removeWorkerRoutes(this.sessionRoutes, worker);
    removeWorkerApprovals(this.approvalRoutes, worker);
    if (this.liveWorkers().length <= 1) this.stopRetireTimer();
  }

  private startRetireTimer() {
    if (this.retireTimer) return;
    const period = Math.max(1_000, Math.min(60_000, this.idleWorkerMs / 5));
    this.retireTimer = setInterval(() => void this.retireIdleWorkers(), period);
    this.retireTimer.unref?.();
  }

  private stopRetireTimer() {
    if (this.retireTimer) clearInterval(this.retireTimer);
    this.retireTimer = undefined;
  }

  private async retireIdleWorkers() {
    const now = Date.now();
    for (const worker of this.availableWorkers()) {
      if (this.availableWorkers().length <= 1) return;
      if (!this.retirable(worker, now)) continue;
      await this.retire(worker);
    }
  }

  private retirable(worker: AgentWorker, now: number) {
    return (
      workerLoad(worker) === 0 &&
      !worker.pendingStarts &&
      now - worker.lastWorkAt >= this.idleWorkerMs &&
      ![...this.approvalRoutes.values()].some(
        (route) => route.worker === worker,
      )
    );
  }

  // The worker says whether it still holds something a session needs (the
  // shared Claude Code bridge while sessions run elsewhere or lanes are
  // open). Work that arrives meanwhile cancels the retirement.
  private async retire(worker: AgentWorker) {
    worker.retiring = true;
    const startedAt = worker.lastWorkAt;
    const busyElsewhere = this.workers.some(
      (other) =>
        other !== worker && (workerLoad(other) > 0 || other.pendingStarts > 0),
    );
    const idle = await worker.client
      .request<boolean>("runtime.idle", { busyElsewhere })
      .catch(() => false);
    worker.retiring = false;
    if (!idle) {
      worker.lastWorkAt = Date.now();
      return;
    }
    if (
      worker.lastWorkAt !== startedAt ||
      workerLoad(worker) > 0 ||
      !worker.client.alive ||
      this.availableWorkers().length <= 1
    )
      return;
    this.forgetWorker(worker);
    await worker.client.shutdown().catch(() => undefined);
  }

  private routeSession(worker: AgentWorker, sessionId: string) {
    this.sessionRoutes.set(sessionId, worker);
  }

  private broadcast(method: AgentRuntimeMethod, input?: unknown) {
    return Promise.allSettled(
      this.liveWorkers().map((worker) => worker.client.request(method, input)),
    );
  }

  private liveWorkers() {
    return this.workers.filter((worker) => worker.client.alive);
  }

  /** Live workers new work may go to: not the one being retired. */
  private availableWorkers() {
    return this.liveWorkers().filter((worker) => !worker.retiring);
  }
}

export function agentRuntimeWorkerCount(parallelism = availableParallelism()) {
  return Math.max(1, Math.min(3, parallelism - 1));
}

function workerLoad(worker: AgentWorker) {
  return worker.activeRequests + worker.activeSessions.size;
}

function leastLoaded(workers: AgentWorker[]) {
  return workers.reduce((least, worker) =>
    workerLoad(worker) < workerLoad(least) ? worker : least,
  );
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
