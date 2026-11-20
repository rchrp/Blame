import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { AgentToolContext } from "@cline/sdk";
import type { LightTaskContract, LightToolResult } from "./light-contracts.js";
import { LightWorkspace as TypeScriptLightWorkspace } from "./light-workspace.js";

// Conformance adapter: a LightWorkspace whose operations run in the Rust
// harness (crates/blame-harness) over its JSON-lines protocol, so the
// behavioural tests written for the TypeScript workspace can drive it.
// rust-harness-hooks.ts substitutes it for ./light-workspace.js.
//
// BLAME_HARNESS_RUST=<binary>: the tests read the Rust results.
// BLAME_HARNESS_COMPARE=<log.jsonl>: the tests read the TypeScript results,
// and every search_code/read_code also runs in Rust (on its own session
// journal) and is compared byte for byte, one log line per call. After an
// edit or a command, which the Rust harness does not run yet, the instance
// stops comparing: their states differ from then on.

type Options = ConstructorParameters<typeof TypeScriptLightWorkspace>[1];
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

const binary = process.env.BLAME_HARNESS_RUST_BINARY ?? process.env.BLAME_HARNESS_RUST ?? "blame-harness";
const compareLog = process.env.BLAME_HARNESS_COMPARE;

class RustHarnessProcess {
  private child?: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, Pending>();
  private sequence = 0;

  private start() {
    if (this.child) return this.child;
    // The compiler side process next to this file, unless the run checks the
    // harness without one (BLAME_HARNESS_NO_COMPILER).
    const compiler = JSON.stringify([process.execPath, fileURLToPath(new URL("./rust-harness-compiler.js", import.meta.url))]);
    const env = { ...process.env };
    if (!process.env.BLAME_HARNESS_NO_COMPILER) env.BLAME_HARNESS_COMPILER = compiler;
    const child = spawn(binary, ["serve"], { stdio: ["pipe", "pipe", "pipe"], env });
    // Neither the process nor its pipes keep a finished test alive; the
    // harness stops when its stdin closes.
    child.unref();
    for (const stream of [child.stdin, child.stdout, child.stderr]) (stream as unknown as { unref?: () => void }).unref?.();
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("error", (error) => this.failAll(error));
    child.on("exit", () => this.failAll(new Error("The Rust harness exited.")));
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
      let message: { id?: string; result?: unknown; presented?: unknown; error?: string };
      try { message = JSON.parse(line); } catch { return; }
      const waiting = message.id === undefined ? undefined : this.pending.get(message.id);
      if (!waiting) return;
      this.pending.delete(message.id!);
      if (message.error !== undefined) waiting.reject(new Error(message.error));
      else waiting.resolve(message.result ?? message.presented);
    });
    this.child = child;
    return child;
  }

  private failAll(error: Error) {
    for (const waiting of this.pending.values()) waiting.reject(error);
    this.pending.clear();
    this.child = undefined;
  }

  send(kind: "request" | "call", body: unknown, signal?: AbortSignal): Promise<unknown> {
    const child = this.start();
    const id = `c${++this.sequence}`;
    const answer = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    child.stdin.write(`${JSON.stringify({ id, [kind]: body })}\n`);
    signal?.addEventListener("abort", () => child.stdin.write(`${JSON.stringify({ id, cancel: true })}\n`), { once: true });
    return answer;
  }
}

function toolContext(context: Partial<AgentToolContext> | undefined) {
  if (!context) return {};
  const copy: Record<string, unknown> = { ...context };
  delete copy.signal;
  return JSON.parse(JSON.stringify(copy)) as Record<string, unknown>;
}

function cancelled(signal: AbortSignal): LightToolResult<unknown> {
  const reason = signal.reason instanceof Error ? signal.reason.message : String(signal.reason);
  return { status: "blocked", category: "input", message: reason, diagnosticId: `read-${Date.now().toString(36)}` };
}

/** The Rust harness behind the TypeScript workspace's interface. */
class RustLightWorkspace {
  private readonly process = new RustHarnessProcess();
  private readonly root: string;
  private readonly taskContract: LightTaskContract;

  constructor(root: string, options: Options, sessionSuffix = "") {
    this.root = root;
    this.taskContract = { ...options.taskContract, session_id: `${options.sessionId}${sessionSuffix}` };
  }

  /** The tests look at a workspace's managed runs; the Rust harness has none yet. */
  readonly tasks = { running: false };

  private async request(tool: string, input: unknown, context: Partial<AgentToolContext> | undefined, signal?: AbortSignal) {
    // In process, a cancelled operation comes back blocked with the abort
    // reason; over the protocol a cancel carries no reason, so the adapter
    // restores it. An already aborted call is not sent at all.
    if (signal?.aborted) return cancelled(signal);
    try {
      return await this.process.send("request", {
        tool, input, workspaceRoot: this.root, taskContract: this.taskContract, toolContext: toolContext(context),
      }, signal) as LightToolResult<unknown>;
    } catch (error) {
      if (signal?.aborted) return cancelled(signal);
      throw error;
    }
  }

  searchCode(input: unknown, signal?: AbortSignal) {
    return this.request("search_code", input, undefined, signal);
  }

  readCode(input: unknown, context: Partial<AgentToolContext> = {}) {
    return this.request("read_code", input, context, context.signal);
  }

  editCode(input: unknown, context: Partial<AgentToolContext> = {}) {
    return this.request("edit_code", input, context, context.signal);
  }

  runTask(input: unknown, context: Partial<AgentToolContext> = {}) {
    return this.request("run_task", input, context, context.signal);
  }
}

/** Runs the TypeScript workspace and checks every read against Rust. */
class ComparingLightWorkspace extends TypeScriptLightWorkspace {
  private readonly rust: RustLightWorkspace;
  private diverged = false;

  constructor(root: string, options: Options) {
    super(root, options);
    // Its own session journal, so neither implementation replays the other's.
    this.rust = new RustLightWorkspace(root, options, "::rust-shadow");
  }

  override async searchCode(input: Parameters<TypeScriptLightWorkspace["searchCode"]>[0], signal?: AbortSignal) {
    const result = await super.searchCode(input, signal);
    await this.compare("search_code", input, result, () => this.rust.searchCode(input, signal));
    return result;
  }

  override async readCode(input: Parameters<TypeScriptLightWorkspace["readCode"]>[0], context: Parameters<TypeScriptLightWorkspace["readCode"]>[1]) {
    const result = await super.readCode(input, context);
    await this.compare("read_code", input, result, () => this.rust.readCode(input, context));
    return result;
  }

  override async editCode(...args: Parameters<TypeScriptLightWorkspace["editCode"]>) {
    this.diverged = true;
    return super.editCode(...args);
  }

  override async runTask(...args: Parameters<TypeScriptLightWorkspace["runTask"]>) {
    this.diverged = true;
    return super.runTask(...args);
  }

  private async compare(tool: string, input: unknown, expected: unknown, actual: () => Promise<unknown>) {
    if (this.diverged) {
      log({ tool, input, outcome: "skipped_after_edit" });
      return;
    }
    let rust: unknown;
    try {
      rust = await actual();
    } catch (error) {
      log({ tool, input, outcome: "rust_error", error: error instanceof Error ? error.message : String(error), ts: expected });
      return;
    }
    const [left, right] = [normalized(expected), normalized(rust)];
    if (left === right) return log({ tool, input, outcome: "equal" });
    // Cross-file links come from the compiler tier's import index, not ported.
    const withoutLinks = (text: string) => JSON.stringify(JSON.parse(text), (key, value) => key === "links" ? undefined : value);
    if (withoutLinks(left) === withoutLinks(right)) return log({ tool, input, outcome: "links_only" });
    log({ tool, input, outcome: "different", ts: expected, rust });
  }
}

/** Time-based diagnostic ids are the one field no two runs share. */
function normalized(value: unknown) {
  return JSON.stringify(value, (key, item) => key === "diagnosticId" ? "<id>" : item);
}

function log(entry: Record<string, unknown>) {
  if (!compareLog) return;
  const test = process.argv.find((argument) => argument.endsWith(".test.js"))?.split("/").at(-1);
  appendFileSync(compareLog, `${JSON.stringify({ test, ...entry })}\n`);
}

export const LightWorkspace = (compareLog ? ComparingLightWorkspace : RustLightWorkspace) as unknown as typeof TypeScriptLightWorkspace;
