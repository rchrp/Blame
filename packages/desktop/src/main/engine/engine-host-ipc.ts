// The main process side of the engine host (docs/engine-in-the-app.md): it
// forks the utility process, starts it again when it dies, relays the
// windows' calls and routes its events back. It loads only the host's
// protocol module, so the main process stays light.

import {
  ipcMain,
  utilityProcess,
  type UtilityProcess,
  type WebContents,
} from "electron";
import {
  engineHostMethods,
  type EngineHostEvent,
  type EngineHostInput,
  type EngineHostResult,
  isEngineHostMessage,
  type EngineHostMessage,
  type EngineHostMethod,
} from "@blame/agent-runtime/engine-protocol";
import type { BinaryLookup } from "./engine-binary.ts";
import type { EngineDesktopHandlers } from "./engine-desktop-services.ts";
import { EngineHostRouter } from "./engine-host-router.ts";

export type EngineHostRegistration = {
  modulePath: string;
  /** When no engine binary was found, every call says why. */
  binary: BinaryLookup;
  dataDir: string;
  clientVersion: string;
  isAppWindow(sender: WebContents): boolean;
  /** What the host and its agents' commands run with (PATH and Blame's folders). */
  environment: NodeJS.ProcessEnv;
  /** The services the agents' tools use (engine-desktop-services.ts). */
  desktop: EngineDesktopHandlers;
  /**
   * What the desktop prepares before a window's call reaches the host (a
   * story's development server, its GitHub access); `api` is the
   * connection the windows gave the host.
   */
  beforeCall?(
    method: EngineHostMethod,
    input: unknown,
    api: EngineHostInput<"connect">["api"] | undefined,
  ): Promise<void>;
  /** A session's turn started or its turns all ended. */
  onActivity?(event: Extract<EngineHostEvent, { type: "activity" }>): void;
  /** Adds what only main knows to a window's call (the git flows'), then makes it. */
  prepareCall?(
    method: EngineHostMethod,
    input: unknown,
    call: (input: unknown) => Promise<unknown>,
  ): Promise<unknown>;
};

const readyTimeoutMs = 15_000;
const shutdownTimeoutMs = 10_000;
const maxRestartDelayMs = 30_000;

type Pending = { resolve(value: unknown): void; reject(error: Error): void };

class EngineHostProcess {
  private child: UtilityProcess | undefined;
  private ready: Promise<UtilityProcess> | undefined;
  private readonly pending = new Map<number, Pending>();
  private readonly desktopRequests = new Map<number, AbortController>();
  private nextId = 1;
  private failures = 0;
  private stopping = false;
  private readonly registration: EngineHostRegistration;
  readonly router = new EngineHostRouter();

  constructor(registration: EngineHostRegistration) {
    this.registration = registration;
  }

  async call(method: EngineHostMethod, input: unknown): Promise<unknown> {
    const child = await this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.postMessage({
        kind: "request",
        id,
        method,
        input,
      } satisfies EngineHostMessage);
    });
  }

  /** Ends running turns as interrupted and stops the engine: agents stop with the app. */
  async shutdown() {
    this.stopping = true;
    const child = this.child;
    if (!child) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    const id = this.nextId++;
    child.postMessage({
      kind: "request",
      id,
      method: "shutdown",
      input: undefined,
    } satisfies EngineHostMessage);
    const timer = setTimeout(() => child.kill(), shutdownTimeoutMs);
    await exited;
    clearTimeout(timer);
  }

  private start(): Promise<UtilityProcess> {
    if (this.stopping) return Promise.reject(new Error("Blame is quitting."));
    this.ready ??= this.fork();
    return this.ready;
  }

  private fork(): Promise<UtilityProcess> {
    const { binary, dataDir, clientVersion, modulePath } = this.registration;
    // Every call fails with the reason; nothing is started.
    if ("missing" in binary) return Promise.reject(new Error(binary.missing));
    const child = utilityProcess.fork(modulePath, [], {
      env: {
        ...this.registration.environment,
        BLAME_ENGINE_HOST_CONFIG: JSON.stringify({
          binary: binary.path,
          dataDir,
          clientVersion,
        }),
      },
      serviceName: "Blame Engine Host",
      stdio: "inherit",
    });
    this.child = child;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("The engine host did not start."));
        child.kill();
      }, readyTimeoutMs);
      child.on("message", (message: unknown) => {
        if (!isEngineHostMessage(message)) return;
        if (message.kind === "ready") {
          clearTimeout(timer);
          this.failures = 0;
          resolve(child);
          return;
        }
        this.onMessage(child, message);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`The engine host exited (${code}).`));
        this.onExit(child, code);
      });
    });
  }

  private onMessage(child: UtilityProcess, message: EngineHostMessage) {
    if (message.kind === "event") {
      if (message.event.type === "activity")
        this.registration.onActivity?.(message.event);
      return this.router.route(message.event);
    }
    if (message.kind === "response") {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending?.reject(new Error(message.error.message));
      else pending?.resolve(message.result);
      return;
    }
    if (message.kind === "desktop-request")
      void this.serveDesktop(child, message);
    if (message.kind === "desktop-cancel")
      this.desktopRequests.get(message.id)?.abort();
  }

  private async serveDesktop(
    child: UtilityProcess,
    message: Extract<EngineHostMessage, { kind: "desktop-request" }>,
  ) {
    const controller = new AbortController();
    this.desktopRequests.set(message.id, controller);
    try {
      const service = this.registration.desktop[message.method] as
        ((input: unknown, signal: AbortSignal) => Promise<unknown>) | undefined;
      if (!service)
        throw new Error(`Unknown desktop service ${String(message.method)}`);
      const result = await service(message.input, controller.signal);
      child.postMessage({
        kind: "desktop-response",
        id: message.id,
        result,
      } satisfies EngineHostMessage);
    } catch (error) {
      child.postMessage({
        kind: "desktop-response",
        id: message.id,
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      } satisfies EngineHostMessage);
    } finally {
      this.desktopRequests.delete(message.id);
    }
  }

  private onExit(child: UtilityProcess, code: number) {
    if (this.child !== child) return;
    this.child = undefined;
    this.ready = undefined;
    for (const controller of this.desktopRequests.values()) controller.abort();
    this.desktopRequests.clear();
    for (const pending of this.pending.values())
      pending.reject(
        new Error(`The engine host stopped (${code}); try again.`),
      );
    this.pending.clear();
    // Its turns ended with it.
    this.router.hostStopped();
    if (this.stopping) return;
    // Started again at once if a window follows a session, after a pause
    // that grows with each crash in a row so a crash loop cannot spin.
    const replay = this.router.replay();
    if (!replay.length) return;
    const delay = Math.min(maxRestartDelayMs, 500 * 2 ** this.failures++);
    setTimeout(() => {
      for (const { method, input } of replay)
        void this.call(method, input).catch(() => undefined);
    }, delay).unref();
  }
}

let host: EngineHostProcess | undefined;

export function registerEngineIpcHandlers(
  registration: EngineHostRegistration,
) {
  if (host) return;
  const engine = new EngineHostProcess(registration);
  host = engine;
  const known = new Set<number>();
  ipcMain.handle("engine:call", async (event, method: unknown, input: unknown) => {
    if (!registration.isAppWindow(event.sender))
      throw new Error("Untrusted engine request");
    if (!engineHostMethods.includes(method as EngineHostMethod))
      throw new Error(`Unknown engine call ${String(method)}`);
    const viewer = event.sender;
    if (
      !engine.router.observe(viewer, method as EngineHostMethod, input as never)
    )
      throw new Error(`${String(method)} cannot be called from a window`);
    if (!known.has(viewer.id)) {
      known.add(viewer.id);
      viewer.once("destroyed", () => {
        known.delete(viewer.id);
        for (const subscription of engine.router.forget(viewer.id))
          void engine.call("unfollow", { subscription }).catch(() => undefined);
      });
    }
    await registration.beforeCall?.(
      method as EngineHostMethod,
      input,
      engine.router.api(),
    );
    const call = (prepared: unknown) =>
      engine.call(method as EngineHostMethod, prepared);
    return registration.prepareCall
      ? registration.prepareCall(method as EngineHostMethod, input, call)
      : call(input);
  });
}

/** A call of the main process itself (an MCP sign-in, a Direct story's files). */
export function callEngineHost<M extends EngineHostMethod>(
  method: M,
  input: EngineHostInput<M>,
): Promise<EngineHostResult<M>> {
  if (!host) return Promise.reject(new Error("The engine host is not set up."));
  return host.call(method, input) as Promise<EngineHostResult<M>>;
}

/** Folders an engine turn is writing in right now. */
export function engineActiveWorkspaces(): string[] {
  return host?.router.activeWorkspaces() ?? [];
}

export async function shutdownEngineHost() {
  await host?.shutdown();
}
