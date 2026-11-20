import { spawn, type ChildProcess } from "node:child_process";
import { LineSplitter } from "./lines.js";

/** How to start the engine: the one thing that differs between local, Lima and WSL. */
export interface EngineCommand {
  command: string;
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

/** How a connection ended, before the client decides whether that was expected. */
export interface TransportExit {
  code: number | null;
  signal: string | null;
  error?: Error;
  stderrTail: readonly string[];
}

export interface TransportEvents {
  /** One line of the engine's output, without its newline. */
  line(line: string): void;
  /** One line the engine wrote to stderr. */
  stderr(line: string): void;
  /** Called once, after every line has been delivered. */
  close(exit: TransportExit): void;
}

/**
 * A duplex of lines to one engine. Standard input and output of a child
 * process today, a WebSocket in Blame's cloud later: the client only needs
 * this much.
 */
export interface Transport {
  /** Queues one message; false when the connection is already closed. */
  write(line: string): boolean;
  /**
   * Ends the connection: closes the engine's input, which tells it to stop, and
   * waits up to `graceMs` for it to exit before killing it.
   */
  close(graceMs: number): Promise<TransportExit>;
  /** Kills the engine at once. */
  kill(): void;
}

export type TransportFactory = (events: TransportEvents) => Transport;

const STDERR_TAIL_LINES = 40;

// A process killed by the parent's death must not outlive it. The engine ends
// when its stdin closes, which the operating system does for us even on
// SIGKILL; this covers the remaining case of a parent that exits (or throws)
// while a child is still running, where stdin may be held open by a wrapper.
const liveChildren = new Set<ChildProcess>();
let exitHookInstalled = false;

function trackChild(child: ChildProcess): void {
  liveChildren.add(child);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const live of liveChildren) live.kill("SIGKILL");
  });
}

/** Starts the engine as a child process and talks to it over stdio. */
export function spawnTransport(command: EngineCommand): TransportFactory {
  return (events) => new ProcessTransport(command, events);
}

class ProcessTransport implements Transport {
  private readonly child: ChildProcess;
  private readonly stderrTail: string[] = [];
  private readonly settled: Promise<TransportExit>;
  private spawnError: Error | undefined;
  private writable = true;

  constructor(
    command: EngineCommand,
    private readonly events: TransportEvents,
  ) {
    this.child = spawn(command.command, [...(command.args ?? [])], {
      stdio: ["pipe", "pipe", "pipe"],
      env: command.env ?? process.env,
      cwd: command.cwd,
      windowsHide: true,
    });
    trackChild(this.child);

    const stdout = new LineSplitter();
    const stderr = new LineSplitter();
    this.child.stdout!.setEncoding("utf8");
    this.child.stderr!.setEncoding("utf8");
    this.child.stdout!.on("data", (chunk: string) => {
      for (const line of stdout.push(chunk)) this.events.line(line);
    });
    this.child.stderr!.on("data", (chunk: string) => {
      for (const line of stderr.push(chunk)) this.recordStderr(line);
    });
    // A write to a dead child fails asynchronously; the exit event reports it.
    this.child.stdin!.on("error", () => {
      this.writable = false;
    });
    this.child.once("error", (error) => {
      // Spawning failed (no such binary): there will be no `close` event.
      this.spawnError = error;
      this.writable = false;
      this.finish(stdout, stderr, null, null);
    });

    this.settled = new Promise((resolve) => {
      this.child.once("close", (code, signal) => {
        this.finish(stdout, stderr, code, signal);
        resolve(this.exit);
      });
      this.child.once("error", () => resolve(this.exit));
    });
  }

  private exit: TransportExit = { code: null, signal: null, stderrTail: [] };
  private finished = false;

  private recordStderr(line: string): void {
    this.stderrTail.push(line);
    if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift();
    this.events.stderr(line);
  }

  private finish(
    stdout: LineSplitter,
    stderr: LineSplitter,
    code: number | null,
    signal: string | null,
  ): void {
    if (this.finished) return;
    this.finished = true;
    this.writable = false;
    liveChildren.delete(this.child);
    const lastOut = stdout.flush();
    if (lastOut !== undefined) this.events.line(lastOut);
    const lastErr = stderr.flush();
    if (lastErr !== undefined) this.recordStderr(lastErr);
    this.exit = {
      code,
      signal,
      error: this.spawnError,
      stderrTail: [...this.stderrTail],
    };
    this.events.close(this.exit);
  }

  write(line: string): boolean {
    if (!this.writable) return false;
    this.child.stdin!.write(`${line}\n`);
    return true;
  }

  async close(graceMs: number): Promise<TransportExit> {
    if (this.finished) return this.exit;
    this.writable = false;
    this.child.stdin!.end();
    if (await this.exitsWithin(graceMs)) return this.exit;
    this.child.kill("SIGTERM");
    // SIGTERM is a request; a stuck engine (or a wrapper that forwards it to
    // nothing) still must not outlive the client.
    if (await this.exitsWithin(Math.min(graceMs, 2_000))) return this.exit;
    this.child.kill("SIGKILL");
    return this.settled;
  }

  kill(): void {
    if (this.finished) return;
    this.writable = false;
    this.child.kill("SIGKILL");
  }

  private async exitsWithin(ms: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    });
    try {
      return await Promise.race([
        this.settled.then(() => true as const),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
