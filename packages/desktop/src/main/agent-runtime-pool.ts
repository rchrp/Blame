import type { AgentEvent } from "@blame/agent-runtime";
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
  onEvent(event: AgentEvent): void;
};

/**
 * The agent runtime's process, for the one-shot work it still does (project
 * setup, commit messages, pull requests, audits). Conversations run on the
 * engine host (engine/engine-host-ipc.ts), so one process is enough: it
 * runs requests side by side, starts on first use and again after it died.
 */
export class AgentRuntimePool {
  private readonly options: AgentRuntimePoolOptions;
  private worker: AgentRuntimeProcessLike | undefined;
  private stopping = false;

  constructor(options: AgentRuntimePoolOptions) {
    this.options = options;
  }

  run<Result>(method: AgentRuntimeMethod, input?: unknown) {
    return this.process().request<Result>(method, input);
  }

  /**
   * The workspace is gone: the runtime lets go of what it holds there, and
   * the Claude Code processes of those sessions close.
   */
  async releaseWorkspace(worktree: string, sessionIds: string[] = []) {
    const worker = this.liveWorker();
    if (!worker) return;
    await worker
      .request("sessions.releaseWorkspace", worktree)
      .catch(() => undefined);
    if (sessionIds.length)
      await worker
        .request("claudeCode.closeSessions", sessionIds)
        .catch(() => undefined);
  }

  async shutdown() {
    this.stopping = true;
    const worker = this.liveWorker();
    this.worker = undefined;
    await worker?.shutdown().catch(() => undefined);
  }

  private liveWorker() {
    return this.worker?.alive ? this.worker : undefined;
  }

  private process() {
    const live = this.liveWorker();
    if (live) return live;
    if (this.stopping) throw new Error("Agent runtime is shutting down");
    const worker = this.options.createProcess({
      handleHostRequest: this.options.handleHostRequest,
      onEvent: (event) => this.options.onEvent(event),
      onExit: () => {
        if (this.worker === worker) this.worker = undefined;
      },
    });
    this.worker = worker;
    return worker;
  }
}
