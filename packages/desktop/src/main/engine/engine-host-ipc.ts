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
  isEngineHostMessage,
  type EngineHostMessage,
  type EngineHostMethod,
} from "@blame/agent-runtime/engine-protocol";
import { EngineHostRouter } from "./engine-host-router.ts";

export type EngineHostRegistration = {
  modulePath: string;
  /** Undefined when no engine binary was found: every call then says so. */
  binary: string | undefined;
  dataDir: string;
  clientVersion: string;
  isAppWindow(sender: WebContents): boolean;
  renderWebPage(
    url: string,
    signal: AbortSignal,
  ): Promise<{ url: string; html: string }>;
  /** Opens a sign-in page in the person's browser. */
  openExternal(url: string): Promise<void>;
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
    if (!this.registration.binary)
      throw new Error(
        "Blame's agent engine is not available: build it with `cargo build -p blame-engine`, or set BLAME_ENGINE_BIN.",
      );
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
    const child = utilityProcess.fork(modulePath, [], {
      env: {
        ...process.env,
        BLAME_ENGINE_HOST_CONFIG: JSON.stringify({
          binary,
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
    if (message.kind === "event") return this.router.route(message.event);
    if (message.kind === "response") {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending?.reject(new Error(message.error.message));
      else pending?.resolve(message.result);
      return;
    }
    if (message.kind === "desktop-request")
      void this.serveDesktop(child, message);
  }

  private async serveDesktop(
    child: UtilityProcess,
    message: Extract<EngineHostMessage, { kind: "desktop-request" }>,
  ) {
    const controller = new AbortController();
    this.desktopRequests.set(message.id, controller);
    try {
      const { url } = message.input as { url: string };
      const result =
        message.method === "openExternal"
          ? await this.registration
              .openExternal(String(url ?? ""))
              .then(() => null)
          : await this.registration.renderWebPage(
              String(url ?? ""),
              controller.signal,
            );
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
  ipcMain.handle("engine:call", (event, method: unknown, input: unknown) => {
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
    return engine.call(method as EngineHostMethod, input);
  });
}

export async function shutdownEngineHost() {
  await host?.shutdown();
}
