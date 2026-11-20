import type { LightTaskContract, LightToolResult } from "../light-contracts.js";
import { HarnessProcess } from "./harness.js";

// The workspace interface the behavioural tests drive, served by
// blame-harness: its tools by `request`, and the internals some tests call
// (the runner alone, the edit service alone, a formatter commit) by the
// harness's internal requests (`task_runner`, `edit_service`,
// `replace_files`). Each workspace has its own harness process, as each
// TypeScript workspace had its own state.

export type LightWorkspaceOptions = {
  sessionId: string;
  taskContract?: LightTaskContract;
  initialCommandWaitMs?: number;
  /** Asked before each command, as the app grants them. */
  commandCredentials?: () => Promise<unknown>;
};

type ToolContext = { signal?: AbortSignal; [key: string]: unknown };
type CommandContext = ToolContext & { commandCredentials?: unknown };
type Replacement = { path: string; before: Uint8Array; content: Uint8Array };

function toolContext(context: ToolContext | undefined) {
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

function reason(signal: AbortSignal) {
  return signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason));
}

export class LightWorkspace {
  private readonly process = new HarnessProcess();
  private readonly root: string;
  private readonly taskContract: LightTaskContract;
  private readonly options: LightWorkspaceOptions;
  private readonly workspaceOptions?: { initialCommandWaitMs: number };

  constructor(root: string, options: LightWorkspaceOptions) {
    this.root = root;
    this.options = options;
    this.taskContract = { ...options.taskContract, session_id: options.sessionId };
    if (options.initialCommandWaitMs !== undefined) this.workspaceOptions = { initialCommandWaitMs: options.initialCommandWaitMs };
  }

  readonly tasks = {
    running: false,
    run: (input: unknown, context: CommandContext = {}) =>
      this.request("task_runner", input, context, context.signal, context.commandCredentials ? { commandCredentials: context.commandCredentials } : {}),
  };

  readonly edits = {
    edit: (input: unknown, context: ToolContext = {}) => this.request("edit_service", input, context, context.signal),
    replaceFiles: (replacements: Replacement[], context: ToolContext = {}) => this.request("replace_files", {
      replacements: replacements.map(({ path, before, content }) => ({
        path, before: Buffer.from(before).toString("base64"), content: Buffer.from(content).toString("base64"),
      })),
    }, context, context.signal),
  };

  private async request(tool: string, input: unknown, context: ToolContext | undefined, signal?: AbortSignal, extra: Record<string, unknown> = {}) {
    // In process, a cancelled operation comes back blocked with the abort
    // reason; over the protocol a cancel carries no reason, so it is put
    // back. An already aborted call is not sent at all.
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

  readCode(input: unknown, context: ToolContext = {}) {
    return this.request("read_code", input, context, context.signal);
  }

  editCode(input: unknown, context: ToolContext = {}) {
    return this.request("edit_code", input, context, context.signal);
  }

  /**
   * A cancelled run_task answers with its command's result; only analyze
   * rejects with the abort reason. The call is sent even when already
   * aborted, and the harness says which.
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
      if (signal?.aborted) throw reason(signal);
      throw error;
    }
  }
}
