import { spawn, type ChildProcess } from "node:child_process";
import { execa } from "execa";
import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";
import type { LightCommandCredentials } from "./light-contracts.js";
import {
  withBundledTools,
  withCommandCredentials,
  withProvisionedPackageManagers,
  workspaceCommandEnvironment,
} from "./workspace-command-environment.js";

type CommandOptions = {
  cwd: string;
  credentials?: LightCommandCredentials;
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  maximumOutputBytes?: number;
};

export type WorkspaceCommandSnapshot = {
  cursor: string;
  output: string;
  process: "running" | "exited" | "timed_out" | "cancelled";
  /** With a page limit: where the shown output starts, and the whole output's size, in bytes. */
  start?: number;
  totalBytes?: number;
};

export type WorkspaceCommandResult = {
  all: string;
  exitCode?: number;
  failed: boolean;
  interruption?: "cancelled" | "timed_out" | "output_limit";
};

export function executeWorkspaceCommand(
  executable: string,
  args: string[],
  options: CommandOptions,
): Promise<WorkspaceCommandResult> {
  return startWorkspaceCommand(executable, args, options).completion;
}

export function startWorkspaceCommand(
  executable: string,
  args: string[],
  options: CommandOptions,
) {
  options.signal?.throwIfAborted();
  const child = spawnWorkspaceProcess(executable, args, options.cwd,
    withCommandCredentials({ ...process.env, ...options.environment }, options.credentials));
  const execution = new CommandExecution(child, options);
  return {
    completion: execution.run(),
    inspect: (cursor?: string, limit?: number) => execution.inspect(cursor, limit),
    waitForUpdate: (cursor?: string, timeoutMs = 30_000, signal?: AbortSignal) => execution.waitForUpdate(cursor, timeoutMs, signal),
    waitForExit: (timeoutMs: number, signal?: AbortSignal) => execution.waitForExit(timeoutMs, signal),
  };
}

function spawnWorkspaceProcess(executable: string, args: string[], cwd: string, environment: NodeJS.ProcessEnv) {
  const options = {
    cwd,
    env: withProvisionedPackageManagers(
      withBundledTools(workspaceCommandEnvironment(environment, executable)), cwd),
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
    windowsHide: true,
  };
  if (process.platform !== "win32") return spawn(executable, args, options);
  // cmd.exe consumes a command line, not the C-runtime argv quoting used for executables.
  if (/(?:^|[\\/])cmd(?:\.exe)?$/iu.test(executable))
    return spawn(executable, args, { ...options, windowsVerbatimArguments: true });
  const child = execa(executable, args, {
    ...options,
    buffer: false,
    extendEnv: false,
    reject: false,
  });
  void child.catch(() => undefined);
  return child.nodeChildProcess;
}

class CommandExecution {
  private readonly chunks: Buffer[] = [];
  private readonly waiters = new Set<() => void>();
  private bytes = 0;
  private finished = false;
  private exitCode?: number;
  private interruption?: WorkspaceCommandResult["interruption"];
  private error?: string;
  private timer?: NodeJS.Timeout;
  private drainTimer?: NodeJS.Timeout;
  private resolve!: (result: WorkspaceCommandResult) => void;
  private readonly cancel = () => this.interrupt("cancelled");

  private readonly child: ChildProcess;
  private readonly options: CommandOptions;

  constructor(child: ChildProcess, options: CommandOptions) {
    this.child = child;
    this.options = options;
  }

  run() {
    const completion = new Promise<WorkspaceCommandResult>((resolve) => {
      this.resolve = resolve;
    });
    this.capture(this.child.stdout);
    this.capture(this.child.stderr);
    this.child.once("error", (error) => this.spawnError(error));
    this.child.once("exit", (code, signal) => this.exited(code, signal));
    this.child.once("close", () => this.finish());
    this.timer = setTimeout(
      () => this.interrupt("timed_out"),
      this.options.timeoutMs ?? 120_000,
    );
    this.options.signal?.addEventListener("abort", this.cancel, { once: true });
    if (this.options.signal?.aborted) this.cancel();
    return completion;
  }

  /**
   * Output from the cursor. With a limit, one page of at most that many
   * bytes, and the cursor where the next page starts, so nothing is skipped;
   * without a cursor the page is the latest output.
   */
  inspect(cursor?: string, limit?: number): WorkspaceCommandSnapshot {
    const offset = cursor === undefined ? 0 : Number(cursor);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.bytes)
      throw new Error(`Invalid run cursor ${cursor}.`);
    const content = Buffer.concat(this.chunks);
    let start = offset;
    let end = content.length;
    if (limit !== undefined) {
      if (cursor === undefined) start = characterStart(content, Math.max(0, end - limit));
      else end = characterEnd(content, Math.min(end, start + limit));
    }
    return {
      cursor: String(end),
      output: content.subarray(start, end).toString("utf8"),
      ...(limit !== undefined ? { start, totalBytes: content.length } : {}),
      process:
        this.interruption === "cancelled"
          ? "cancelled"
          : this.interruption === "timed_out"
            ? "timed_out"
            : this.finished
              ? "exited"
              : "running",
    };
  }

  waitForUpdate(cursor: string | undefined, timeoutMs: number, signal?: AbortSignal): Promise<WorkspaceCommandSnapshot> {
    signal?.throwIfAborted();
    const snapshot = this.inspect(cursor);
    if (snapshot.process !== "running" || Number(snapshot.cursor) > Number(cursor ?? 0) || timeoutMs <= 0)
      return Promise.resolve(snapshot);
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.waiters.delete(updated);
        signal?.removeEventListener("abort", cancelled);
      };
      const updated = () => { cleanup(); resolve(this.inspect(cursor)); };
      const cancelled = () => { cleanup(); reject(signal?.reason ?? new Error("Inspection cancelled.")); };
      const timer = setTimeout(updated, timeoutMs);
      timer.unref();
      this.waiters.add(updated);
      signal?.addEventListener("abort", cancelled, { once: true });
      if (signal?.aborted) cancelled();
    });
  }

  /** Resolves once the process ended, or after the timeout. */
  waitForExit(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.finished || timeoutMs <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.waiters.delete(updated);
        signal?.removeEventListener("abort", cancelled);
      };
      const updated = () => {
        if (!this.finished) return;
        cleanup();
        resolve();
      };
      const cancelled = () => { cleanup(); reject(signal?.reason ?? new Error("Inspection cancelled.")); };
      const timer = setTimeout(() => { cleanup(); resolve(); }, timeoutMs);
      timer.unref();
      this.waiters.add(updated);
      signal?.addEventListener("abort", cancelled, { once: true });
    });
  }

  private notifyWaiters() {
    for (const updated of this.waiters) updated();
  }

  private capture(stream: Readable | null) {
    if (!stream) return;
    const decoder = new StringDecoder("utf8");
    stream.on("data", (chunk: Buffer) => this.append(Buffer.from(decoder.write(chunk))));
    stream.once("end", () => this.append(Buffer.from(decoder.end())));
    stream.once("error", (error) => {
      terminateCommand(this.child);
      this.spawnError(error);
    });
  }

  private append(chunk: Buffer) {
    if (this.finished || this.interruption) return;
    const limit = this.options.maximumOutputBytes ?? 512 * 1024;
    const remaining = limit - this.bytes;
    const retained = chunk.subarray(0, remaining);
    this.chunks.push(retained);
    this.bytes += retained.length;
    if (retained.length) this.notifyWaiters();
    if (chunk.length > remaining) this.interrupt("output_limit");
  }

  private exited(code: number | null, signal: NodeJS.Signals | null) {
    if (this.finished) return;
    this.exitCode = code ?? undefined;
    if (signal) this.error = `Command terminated by ${signal}.`;
    this.scheduleDrain();
  }

  private spawnError(error: Error) {
    this.error = error.message;
    this.finish();
  }

  private interrupt(reason: NonNullable<WorkspaceCommandResult["interruption"]>) {
    if (this.finished || this.interruption) return;
    this.interruption = reason;
    terminateCommand(this.child);
    this.scheduleDrain();
    this.notifyWaiters();
  }

  private scheduleDrain() {
    if (!this.drainTimer)
      this.drainTimer = setTimeout(() => this.finish(), 100);
  }

  private finish() {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.timer);
    clearTimeout(this.drainTimer);
    this.options.signal?.removeEventListener("abort", this.cancel);
    this.child.stdout?.destroy();
    this.child.stderr?.destroy();
    this.child.unref();
    this.resolve({
      all: this.output(),
      exitCode: this.exitCode,
      failed: this.exitCode !== 0 || !!this.interruption || !!this.error,
      ...(this.interruption ? { interruption: this.interruption } : {}),
    });
    this.notifyWaiters();
  }

  private output() {
    const diagnostic = this.interruption
      ? interruptionDiagnostic(this.interruption, this.options.timeoutMs)
      : this.error;
    return [Buffer.concat(this.chunks).toString("utf8"), diagnostic]
      .filter(Boolean)
      .join("\n");
  }
}

/** The first byte at or after index that starts a UTF-8 character. */
function characterStart(content: Buffer, index: number) {
  while (index < content.length && (content[index]! & 0xc0) === 0x80) index += 1;
  return index;
}

/** The last character boundary at or before index. */
function characterEnd(content: Buffer, index: number) {
  while (index > 0 && index < content.length && (content[index]! & 0xc0) === 0x80) index -= 1;
  return index;
}

function terminateCommand(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const cleanup = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    cleanup.once("error", () => child.kill());
    cleanup.unref();
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL");
  }
}

function interruptionDiagnostic(
  reason: NonNullable<WorkspaceCommandResult["interruption"]>,
  timeoutMs = 120_000,
) {
  if (reason === "cancelled") return "Command cancelled before completion.";
  if (reason === "timed_out") return `Command timed out after ${timeoutMs} ms.`;
  return "Command exceeded the captured output limit.";
}
