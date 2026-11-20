import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync, type Dirent } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { AgentToolContext } from "@cline/sdk";
import type { LightTaskContract, LightToolResult } from "./light-contracts.js";
import { bundledRipgrepDirectory } from "./lexical-search.js";
import { LightWorkspace as TypeScriptLightWorkspace } from "./light-workspace.js";

// Conformance adapter: a LightWorkspace whose operations run in the Rust
// harness (crates/blame-harness) over its JSON-lines protocol, so the
// behavioural tests written for the TypeScript workspace can drive it.
// rust-harness-hooks.ts substitutes it for ./light-workspace.js.
//
// BLAME_HARNESS_RUST=<binary>: the tests read the Rust results.
// BLAME_HARNESS_COMPARE=<log.jsonl>: the tests read the TypeScript results,
// and every search_code/read_code/edit_code also runs in Rust, on a shadow
// copy of the workspace, and is compared byte for byte (an edit's resulting
// files too), one log line per call. After a command, which the Rust
// harness does not run yet, the instance stops comparing.

type Options = ConstructorParameters<typeof TypeScriptLightWorkspace>[1];
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

const binary = process.env.BLAME_HARNESS_RUST_BINARY ?? process.env.BLAME_HARNESS_RUST ?? "blame-harness";
const compareLog = process.env.BLAME_HARNESS_COMPARE;

export class RustHarnessProcess {
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
    // What run_task takes from the TypeScript package: its Node reporter and
    // Vitest preload hook, the bundled package managers, the bundled rg.
    env.BLAME_HARNESS_NODE_ASSETS = fileURLToPath(new URL(".", import.meta.url));
    env.BLAME_HARNESS_NODE_MODULES = fileURLToPath(new URL("../../node_modules", import.meta.url));
    const ripgrep = bundledRipgrepDirectory();
    if (ripgrep) env.BLAME_HARNESS_RIPGREP_DIRECTORY = ripgrep;
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

  send(kind: "request" | "call", body: unknown, signal?: AbortSignal): Promise<unknown> {
    const child = this.start();
    const id = `c${++this.sequence}`;
    // A pending call keeps the test process alive; an idle harness does not.
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

function toolContext(context: Partial<AgentToolContext> | undefined) {
  if (!context) return {};
  const copy: Record<string, unknown> = { ...context };
  delete copy.signal;
  delete copy.commandCredentials;
  return JSON.parse(JSON.stringify(copy)) as Record<string, unknown>;
}

function cancelled(signal: AbortSignal): LightToolResult<unknown> {
  const reason = signal.reason instanceof Error ? signal.reason.message : String(signal.reason);
  return { status: "blocked", category: "input", message: reason, diagnosticId: `read-${Date.now().toString(36)}` };
}

type CommandContext = Partial<AgentToolContext> & { commandCredentials?: unknown };
type Replacement = { path: string; before: Uint8Array; content: Uint8Array };

/** The Rust harness behind the TypeScript workspace's interface. */
class RustLightWorkspace {
  private readonly process = new RustHarnessProcess();
  private readonly root: string;
  private readonly taskContract: LightTaskContract;
  private readonly options: Options;
  private readonly workspaceOptions?: { initialCommandWaitMs: number };

  constructor(root: string, options: Options) {
    this.root = root;
    this.options = options;
    this.taskContract = { ...options.taskContract, session_id: options.sessionId };
    if (options.initialCommandWaitMs !== undefined) this.workspaceOptions = { initialCommandWaitMs: options.initialCommandWaitMs };
  }

  /**
   * The workspace's internals some tests call directly: the runner alone and
   * the edit service alone, served by internal requests of the harness.
   */
  readonly tasks = {
    running: false,
    run: (input: unknown, context: CommandContext = {}) =>
      this.request("task_runner", input, context, context.signal, context.commandCredentials ? { commandCredentials: context.commandCredentials } : {}),
  };

  readonly edits = {
    edit: (input: unknown, context: Partial<AgentToolContext> = {}) => this.request("edit_service", input, context, context.signal),
    replaceFiles: (replacements: Replacement[], context: Partial<AgentToolContext> = {}) => this.request("replace_files", {
      replacements: replacements.map(({ path, before, content }) => ({
        path, before: Buffer.from(before).toString("base64"), content: Buffer.from(content).toString("base64"),
      })),
    }, context, context.signal),
  };

  private async request(tool: string, input: unknown, context: Partial<AgentToolContext> | undefined, signal?: AbortSignal, extra: Record<string, unknown> = {}) {
    // In process, a cancelled operation comes back blocked with the abort
    // reason; over the protocol a cancel carries no reason, so the adapter
    // restores it. An already aborted call is not sent at all.
    if (signal?.aborted) return cancelled(signal);
    try {
      return await this.process.send("request", {
        tool, input, workspaceRoot: this.root, taskContract: this.taskContract, toolContext: toolContext(context),
        ...(this.workspaceOptions ? { workspaceOptions: this.workspaceOptions } : {}), ...extra,
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

  /**
   * Credentials as the workspace asks them: the call's own, else the
   * session's, before each command. In process a cancelled run_task answers
   * with the command's own result, and only analyze rejects with the reason:
   * the request is sent even when already aborted, and the harness says which.
   */
  async runTask(input: unknown, context: CommandContext = {}) {
    const asked = this.options.commandCredentials;
    const credentials = context.commandCredentials ?? (asked ? await asked().catch(() => ({})) : undefined);
    const signal = context.signal;
    try {
      return await this.process.send("request", {
        tool: "run_task", input, workspaceRoot: this.root, taskContract: this.taskContract, toolContext: toolContext(context),
        ...(this.workspaceOptions ? { workspaceOptions: this.workspaceOptions } : {}),
        ...(credentials ? { commandCredentials: credentials } : {}),
      }, signal) as LightToolResult<unknown>;
    } catch (error) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason));
      throw error;
    }
  }
}

/**
 * Runs the TypeScript workspace and checks every read and edit against Rust.
 * The Rust harness works on a shadow copy of the workspace, made identical
 * to it (outside .blame/harness) before each call, so both start from the same
 * files; an edit compares both results and both resulting trees.
 */
class ComparingLightWorkspace extends TypeScriptLightWorkspace {
  private readonly rust: RustLightWorkspace;
  private readonly root: string;
  private readonly shadow: string;
  private diverged = false;

  constructor(root: string, options: Options) {
    super(root, options);
    this.root = root;
    // One shadow per folder: workspaces reopened on it share its journal.
    this.shadow = shadows.get(root) ?? mkdtempSync(join(tmpdir(), "rust-shadow-"));
    shadows.set(root, this.shadow);
    this.rust = new RustLightWorkspace(this.shadow, options);
  }

  override async searchCode(input: Parameters<TypeScriptLightWorkspace["searchCode"]>[0], signal?: AbortSignal) {
    this.sync();
    const result = await super.searchCode(input, signal);
    await this.compare("search_code", input, result, () => this.rust.searchCode(this.shadowed(input), signal));
    return result;
  }

  override async readCode(input: Parameters<TypeScriptLightWorkspace["readCode"]>[0], context: Parameters<TypeScriptLightWorkspace["readCode"]>[1]) {
    this.sync();
    const result = await super.readCode(input, context);
    await this.compare("read_code", input, result, () => this.rust.readCode(this.shadowed(input), context));
    return result;
  }

  override async editCode(...args: Parameters<TypeScriptLightWorkspace["editCode"]>) {
    this.sync();
    const result = await super.editCode(...args);
    await this.compare("edit_code", args[0], result, () => this.rust.editCode(this.shadowed(args[0]), args[1]), true);
    return result;
  }

  override async runTask(...args: Parameters<TypeScriptLightWorkspace["runTask"]>) {
    // run_task is not ported: from here on the two sessions differ.
    this.diverged = true;
    return super.runTask(...args);
  }

  /** An input naming the workspace by absolute path names the shadow instead. */
  private shadowed<T>(input: T): T {
    const pairs = [[this.root, this.shadow], [realpathSync(this.root), realpathSync(this.shadow)]];
    const text = pairs.reduce((value, [from, to]) => value.split(JSON.stringify(from).slice(1, -1)).join(JSON.stringify(to).slice(1, -1)), JSON.stringify(input));
    return JSON.parse(text) as T;
  }

  /**
   * Makes the shadow's files the workspace's, outside .blame/harness, and its pending
   * edit record too: crash recovery is part of what is compared.
   */
  private sync() {
    mirror(this.root, this.shadow);
    const pending = ".blame/harness/light-write/pending.json";
    let record: Buffer | undefined;
    try { record = readFileSync(join(this.root, pending)); } catch { record = undefined; }
    if (record) {
      mkdirSync(join(this.shadow, pending, ".."), { recursive: true });
      writeFileSync(join(this.shadow, pending), record);
    } else rmSync(join(this.shadow, pending), { force: true });
  }

  private async compare(tool: string, input: unknown, expected: unknown, actual: () => Promise<unknown>, files = false) {
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
    const [left, right] = [normalized(expected), this.unshadowed(normalized(rust))];
    const tree = files ? treeDifference(this.root, this.shadow) : undefined;
    if (left === right && !tree) return log({ tool, input, outcome: "equal" });
    // Cross-file links come from the compiler tier's import index.
    const withoutLinks = (text: string) => JSON.stringify(JSON.parse(text), (key, value) => key === "links" ? undefined : value);
    if (!tree && withoutLinks(left) === withoutLinks(right)) return log({ tool, input, outcome: "links_only" });
    log({ tool, input, outcome: "different", ts: expected, rust: JSON.parse(right), ...(tree ? { tree } : {}) });
  }

  /** The shadow's absolute paths, as the workspace's. */
  private unshadowed(text: string) {
    const pairs = [[realpathSync(this.shadow), realpathSync(this.root)], [this.shadow, this.root]];
    return pairs.reduce((value, [from, to]) => value.split(JSON.stringify(from).slice(1, -1)).join(JSON.stringify(to).slice(1, -1)), text);
  }
}

const shadows = new Map<string, string>();
process.on("exit", () => { for (const shadow of shadows.values()) rmSync(shadow, { recursive: true, force: true }); });

function entries(root: string, relative = ""): Map<string, Dirent> {
  const found = new Map<string, Dirent>();
  let listed: Dirent[];
  try { listed = readdirSync(join(root, relative), { withFileTypes: true }); } catch { return found; }
  for (const entry of listed) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    // Each harness's own state stays its own; the rest of .blame is project data.
    if (path === ".blame/harness") continue;
    found.set(path, entry);
    if (entry.isDirectory()) for (const [child, value] of entries(root, path)) found.set(child, value);
  }
  return found;
}

function mirror(source: string, target: string) {
  const wanted = entries(source);
  for (const [path, entry] of entries(target)) {
    const kept = wanted.get(path);
    if (!kept || kept.isDirectory() !== entry.isDirectory() || kept.isSymbolicLink() !== entry.isSymbolicLink())
      rmSync(join(target, path), { recursive: true, force: true });
  }
  for (const [path, entry] of wanted) {
    const [from, to] = [join(source, path), join(target, path)];
    if (entry.isDirectory()) { mkdirSync(to, { recursive: true }); continue; }
    if (entry.isSymbolicLink()) {
      // A link into the workspace points into the shadow instead.
      const original = readlinkSync(from);
      const prefix = [source, realpathSync(source)].find((root) => original === root || original.startsWith(`${root}/`));
      const link = prefix ? target + original.slice(prefix.length) : original;
      let current: string | undefined;
      try { current = readlinkSync(to); } catch { current = undefined; }
      if (current !== link) { rmSync(to, { force: true }); symlinkSync(link, to); }
      continue;
    }
    if (!entry.isFile()) continue;
    const content = readFileSync(from);
    let same: boolean;
    try { same = readFileSync(to).equals(content); } catch { same = false; }
    if (!same) writeFileSync(to, content);
    chmodSync(to, statSync(from).mode & 0o777);
  }
}

/** What differs between the two trees after an edit, outside .blame/harness and .git. */
function treeDifference(left: string, right: string) {
  const describe = (root: string) => new Map([...entries(root)].filter(([path, entry]) => entry.isFile() && !path.startsWith(".git/"))
    .map(([path]) => [path, `${statSync(join(root, path)).mode & 0o777}:${readFileSync(join(root, path)).toString("base64")}`]));
  const [ts, rust] = [describe(left), describe(right)];
  const paths = [...new Set([...ts.keys(), ...rust.keys()])].filter((path) => ts.get(path) !== rust.get(path)).sort();
  return paths.length ? paths : undefined;
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
