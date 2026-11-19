import { AsyncLocalStorage } from "node:async_hooks";
import type { RuntimePowerEvent, RuntimeProgress } from "@blame/app";
import log from "electron-log";

// When the Blame Runtime VM runs. The VM keeps every page of memory it
// touched until it stops (Lima never drives the vz balloon, which has no
// free page reporting), so it starts when something needs it and stops once
// nothing has used it for a while.
//
// Every command reaches the VM through the runtime agent, which calls
// `ensureRuntimeRunning` before each request: the one place that starts the
// VM. Work that only looks at the VM (sweeps, recovery polls, reads from a
// hidden window) runs inside `runtimeBackground`: it never starts the VM,
// fails at once while it is stopped, and is not use.

/**
 * How long the VM stays up once nothing uses it. Previews hibernate after
 * 5 minutes without use, so by then they hold almost nothing inside the VM;
 * the VM itself still holds what it touched (1 to 4 GB). Stopping it costs
 * the next use a boot of about 20 seconds and each hibernated preview a
 * restart instead of a resume.
 */
export const runtimeIdleStopMs = 10 * 60_000;
const idleCheckIntervalMs = 60_000;

export type { RuntimePowerEvent };
type RuntimePowerState = RuntimePowerEvent["state"];

/** What the runtime reports before a start: running, startable, or not installed. */
export type RuntimeAvailability = "running" | "stopped" | "unavailable";

export type RuntimePowerControls = {
  availability(): Promise<RuntimeAvailability>;
  // Boots the VM (and brings an outdated one up to date); throws on failure.
  start(onProgress: (progress: RuntimeProgress) => void): Promise<void>;
  stop(): Promise<void>;
  notify(event: RuntimePowerEvent): void;
  now?(): number;
};

export class RuntimeStoppedError extends Error {
  constructor() {
    super("Blame Runtime is stopped.");
    this.name = "RuntimeStoppedError";
  }
}

const background = new AsyncLocalStorage<true>();

/** Runs work that must neither start the VM nor count as its use. */
export function runtimeBackground<T>(work: () => T): T {
  return background.run(true, work);
}

/**
 * For a long-lived connection whose callbacks serve every caller: it must
 * not inherit the mode of the request that happened to open it.
 */
export function outsideRuntimeBackground<T>(work: () => T): T {
  return background.exit(work);
}

export class RuntimePower {
  private state: RuntimePowerState | "unknown" = "unknown";
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private probing?: Promise<void>;
  private holds = 0;
  private operations = 0;
  private lastUse: number;
  private readonly controls: RuntimePowerControls;
  private readonly busyChecks: ReadonlySet<() => boolean>;
  private readonly runningListeners: ReadonlySet<() => void>;

  constructor(
    controls: RuntimePowerControls,
    busyChecks: ReadonlySet<() => boolean> = new Set(),
    runningListeners: ReadonlySet<() => void> = new Set(),
  ) {
    this.controls = controls;
    this.busyChecks = busyChecks;
    this.runningListeners = runningListeners;
    this.lastUse = this.now();
  }

  current() {
    return this.state;
  }

  async ensureRunning(): Promise<void> {
    if (this.running()) return;
    if (this.stopping) await this.stopping;
    if (this.running()) return;
    if (this.starting) return this.starting;
    if (background.getStore()) {
      if (this.state === "unknown") await this.probe();
      if (this.running()) return;
      throw new RuntimeStoppedError();
    }
    return this.start();
  }

  private running() {
    return this.state === "running";
  }

  /** Counts a request or a stream as use until it ends; background work does not. */
  hold() {
    if (background.getStore()) return () => undefined;
    this.holds += 1;
    this.lastUse = this.now();
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.holds -= 1;
      this.lastUse = this.now();
    };
  }

  /** Install, update, repair, reset and explicit starts: never stopped under. */
  async operation<T extends { status: string }>(work: () => Promise<T>) {
    this.operations += 1;
    try {
      if (this.stopping) await this.stopping;
      if (this.starting) await this.starting.catch(() => undefined);
      const report = await work();
      if (report.status === "ready") this.becameRunning();
      else this.state = "unknown";
      return report;
    } catch (error) {
      this.state = "unknown";
      throw error;
    } finally {
      this.operations -= 1;
    }
  }

  /** The agent's connection to the VM ended on its own: look again next time. */
  connectionLost() {
    if (this.state === "running") this.state = "unknown";
  }

  async stopIfIdle() {
    if (this.state !== "running" || this.starting || this.stopping)
      return false;
    if (this.holds > 0 || this.operations > 0) return false;
    const now = this.now();
    if ([...this.busyChecks].some(busy)) {
      this.lastUse = now;
      return false;
    }
    if (now - this.lastUse < runtimeIdleStopMs) return false;
    const idleMinutes = Math.round((now - this.lastUse) / 60_000);
    this.stopping = this.stop(idleMinutes).finally(() => {
      this.stopping = undefined;
    });
    await this.stopping;
    return true;
  }

  /** At launch: a VM left running by an earlier Blame stops once unused. */
  probe() {
    this.probing ??= this.controls
      .availability()
      .then((availability) => {
        if (this.state !== "unknown") return;
        this.state = availability === "running" ? "running" : "stopped";
        this.lastUse = this.now();
      })
      .catch(() => undefined)
      .finally(() => {
        this.probing = undefined;
      });
    return this.probing;
  }

  private start() {
    this.starting = this.boot().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async boot() {
    const availability = await this.controls.availability();
    if (availability === "unavailable") {
      this.state = "unknown";
      throw new Error("Blame Runtime is not installed.");
    }
    if (availability === "stopped") {
      const startedAt = this.now();
      this.setState("starting");
      try {
        await this.controls.start((progress) =>
          this.controls.notify({ progress, state: "starting" }),
        );
      } catch (error) {
        this.setState("stopped", errorMessage(error));
        throw error;
      }
      log.info(`Blame Runtime started in ${this.now() - startedAt} ms`);
    }
    this.becameRunning();
  }

  private async stop(idleMinutes: number) {
    this.setState("stopping");
    try {
      await this.controls.stop();
      log.info(`Blame Runtime stopped after ${idleMinutes} min without use`);
      this.setState("stopped");
    } catch (error) {
      log.warn("Blame Runtime could not be stopped", error);
      this.state = "unknown";
    }
  }

  private becameRunning() {
    this.lastUse = this.now();
    const wasRunning = this.state === "running";
    this.setState("running");
    if (wasRunning) return;
    for (const listener of this.runningListeners) {
      try {
        listener();
      } catch (error) {
        log.warn("A Blame Runtime start listener failed", error);
      }
    }
  }

  private setState(state: RuntimePowerState, error?: string) {
    const changed = this.state !== state;
    this.state = state;
    if (changed || error)
      this.controls.notify(error ? { error, state } : { state });
  }

  private now() {
    return this.controls.now?.() ?? Date.now();
  }
}

let power: RuntimePower | undefined;
let idleTimer: NodeJS.Timeout | undefined;
const busyChecks = new Set<() => boolean>();
const runningListeners = new Set<() => void>();

/** Called once by the desktop; without it the runtime agent connects as is (tests). */
export function configureRuntimePower(controls: RuntimePowerControls) {
  power = new RuntimePower(controls, busyChecks, runningListeners);
  void power.probe();
  clearInterval(idleTimer);
  idleTimer = setInterval(() => void power?.stopIfIdle(), idleCheckIntervalMs);
  idleTimer.unref?.();
  return power;
}

/** The one place that starts the VM: called before each runtime agent request. */
export function ensureRuntimeRunning() {
  return power?.ensureRunning() ?? Promise.resolve();
}

export function holdRuntime() {
  return power?.hold() ?? (() => undefined);
}

export function runtimeLifecycleOperation<T extends { status: string }>(
  work: () => Promise<T>,
) {
  return power ? power.operation(work) : work();
}

export function runtimeConnectionLost() {
  power?.connectionLost();
}

/** While a check holds, the VM counts as used. */
export function keepRuntimeRunningWhile(check: () => boolean) {
  busyChecks.add(check);
}

/** Runs each time the VM becomes usable after a start or an operation. */
export function onRuntimeRunning(listener: () => void) {
  runningListeners.add(listener);
}

function busy(check: () => boolean) {
  try {
    return check();
  } catch {
    return false;
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
