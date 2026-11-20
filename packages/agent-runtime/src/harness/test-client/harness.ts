import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { harnessEnvironment } from "../runner-path.js";

// The behavioural suite's link to blame-harness (crates/blame-harness), the
// only harness: the test client's modules answer the interfaces the tests
// use with its JSON-lines protocol and nothing else. The binary is
// BLAME_HARNESS_BIN, else this checkout's debug build
// (`cargo build -p blame-harness`).

export const harnessBinary =
  process.env.BLAME_HARNESS_BIN ??
  fileURLToPath(new URL(`../../../../../target/debug/blame-harness${process.platform === "win32" ? ".exe" : ""}`, import.meta.url));

/** The environment the engine gives the harness: its Node side from this package. */
export function environment() {
  return { ...process.env, ...harnessEnvironment(process.execPath) };
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

/** One `blame-harness serve`, started on first use. */
export class HarnessProcess {
  private child?: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, Pending>();
  private sequence = 0;

  private start() {
    if (this.child) return this.child;
    const child = spawn(harnessBinary, ["serve"], { stdio: ["pipe", "pipe", "pipe"], env: environment() });
    // Neither the process nor its pipes keep a finished test alive; the
    // harness stops when its stdin closes.
    child.unref();
    for (const stream of [child.stdin, child.stdout, child.stderr]) (stream as unknown as { unref?: () => void }).unref?.();
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("error", (error) => this.failAll(error));
    child.on("exit", () => this.failAll(new Error("The harness exited.")));
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
      let message: { id?: string; result?: unknown; presented?: unknown; tools?: unknown; error?: string };
      try { message = JSON.parse(line); } catch { return; }
      const waiting = message.id === undefined ? undefined : this.pending.get(message.id);
      if (!waiting) return;
      this.pending.delete(message.id!);
      if (message.error !== undefined) waiting.reject(new Error(message.error));
      else waiting.resolve(message.result ?? message.presented ?? message.tools);
    });
    this.child = child;
    return child;
  }

  // A pending call keeps the test process alive; an idle harness does not.
  private hold(referenced: boolean) {
    const child = this.child;
    if (!child) return;
    for (const handle of [child, child.stdin, child.stdout] as unknown as Array<{ ref?: () => void; unref?: () => void }>)
      (referenced ? handle.ref : handle.unref)?.call(handle);
  }

  private failAll(error: Error) {
    for (const waiting of this.pending.values()) waiting.reject(error);
    this.pending.clear();
    this.child = undefined;
  }

  send(kind: "request" | "call" | "describe", body: unknown, signal?: AbortSignal): Promise<unknown> {
    const child = this.start();
    const id = `c${++this.sequence}`;
    if (!this.pending.size) this.hold(true);
    const answer = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }))
      .finally(() => { if (!this.pending.size) this.hold(false); });
    child.stdin.write(`${JSON.stringify({ id, [kind]: body })}\n`);
    const cancel = () => child.stdin.write(`${JSON.stringify({ id, cancel: true })}\n`);
    // A signal aborted before the call still cancels what the call starts.
    if (signal?.aborted) cancel();
    else signal?.addEventListener("abort", cancel, { once: true });
    return answer;
  }
}

/** One request answered by a harness started for it (synchronous helpers). */
export function requestSync(request: Record<string, unknown>): unknown {
  const run = spawnSync(harnessBinary, [], { input: JSON.stringify({ workspaceRoot: "/", ...request }), env: environment(), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(run.stderr.trim() || `blame-harness exited with ${run.status}`);
  return JSON.parse(run.stdout);
}

/** A harness function by its TypeScript name (`units.rs`), synchronously. */
export function unit(name: string, ...args: unknown[]): unknown {
  return requestSync({ tool: "unit", input: { function: name, args: args.map((arg) => arg === undefined ? null : arg) } });
}

/** `null` from the harness is TypeScript's `undefined`. */
export function absent<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}
