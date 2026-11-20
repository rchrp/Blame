// Tools the app runs for the engine (`client_tools`, served through
// `host/tool`). A tool is plain data plus a function: no agent framework
// stands between the model's call and the code that answers it.

import type {
  HostParamsOf,
  JsonValue,
  ToolEffect,
  ToolHostContext,
  ToolResult,
  ToolResultBlock,
  ToolSpec,
} from "@blame/engine-client";

/** What a running call is given. */
export type ToolCallContext = {
  session: string;
  turn: string;
  call: string;
  /** Aborted when the turn is interrupted or the engine withdraws the call. */
  signal: AbortSignal;
  /** Tells the viewers what the call is doing; cheap, call it as often as useful. */
  progress(text: string): void;
};

/**
 * What a tool returns. A string or a JSON value is the model's text; blocks
 * carry images too. `ok: false` tells the model the tool reported a failure
 * (a thrown error does the same with its message).
 */
export type ToolOutput =
  | string
  | { ok?: boolean; content: ToolResultBlock[] }
  | { ok?: boolean; json: unknown };

export type ClientTool<Input = Record<string, unknown>> = {
  name: string;
  description: string;
  /** JSON Schema of the input object, as the model sees it. */
  inputSchema: Record<string, unknown>;
  effect: ToolEffect;
  /** The turn ends when this tool succeeds. */
  endsTurn?: boolean;
  /** The user approves each call before it runs. */
  needsApproval?: boolean;
  /** Longest a call may run before it fails; none by default. */
  timeoutMs?: number;
  run(input: Input, context: ToolCallContext): Promise<ToolOutput> | ToolOutput;
};

/** Keeps a tool's input type while letting a set hold tools of any input. */
export function defineTool<Input>(tool: ClientTool<Input>): ClientTool<Input> {
  return tool;
}

export function toolSpec(tool: ClientTool<never>): ToolSpec {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as JsonValue,
    effect: tool.effect,
    ends_turn: tool.endsTurn ?? false,
    needs_approval: tool.needsApproval ?? false,
  };
}

/**
 * The tools of the app, found by name when the engine calls one. The engine
 * only calls tools named in a session's `client_tools`, which come from
 * these same definitions, so one set serves every session.
 */
export class ToolSet {
  private readonly tools = new Map<string, ClientTool<never>>();

  constructor(tools: ClientTool<never>[]) {
    for (const tool of tools) {
      if (this.tools.has(tool.name))
        throw new Error(`Two client tools are named ${tool.name}`);
      this.tools.set(tool.name, tool);
    }
  }

  specs(names?: readonly string[]): ToolSpec[] {
    const selected = names
      ? names.map((name) => this.require(name))
      : [...this.tools.values()];
    return selected.map(toolSpec);
  }

  /** Answers `host/tool`. Never throws: every failure is a result the model reads. */
  async handle(
    params: HostParamsOf<"host/tool">,
    host: ToolHostContext,
  ): Promise<ToolResult> {
    const tool = this.tools.get(params.name);
    if (!tool)
      return failed(`There is no tool named ${params.name} in this app.`);
    const input = params.input;
    if (!input || typeof input !== "object" || Array.isArray(input))
      return failed(`${params.name} takes an object as its input.`);
    const signal = tool.timeoutMs
      ? AbortSignal.any([host.signal, AbortSignal.timeout(tool.timeoutMs)])
      : host.signal;
    const context: ToolCallContext = {
      session: params.session,
      turn: params.turn,
      call: params.call,
      signal,
      progress: host.progress,
    };
    try {
      const output = await abortable(
        Promise.resolve(tool.run(input as never, context)),
        signal,
      );
      return result(output);
    } catch (error) {
      if (host.signal.aborted)
        return { outcome: "cancelled", content: [text("Cancelled.")] };
      if (signal.aborted)
        return failed(`${params.name} took longer than ${tool.timeoutMs} ms.`);
      return failed(error instanceof Error ? error.message : String(error));
    }
  }

  private require(name: string) {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`There is no client tool named ${name}`);
    return tool;
  }
}

function result(output: ToolOutput): ToolResult {
  if (typeof output === "string")
    return { outcome: "completed", content: [text(output)] };
  const outcome = output.ok === false ? "failed" : "completed";
  if ("content" in output) return { outcome, content: output.content };
  return { outcome, content: [text(JSON.stringify(output.json))] };
}

function failed(message: string): ToolResult {
  return { outcome: "failed", content: [text(message)] };
}

function text(value: string): ToolResultBlock {
  return { type: "text", text: value };
}

// A tool that ignores its signal still lets the turn move on when it is
// stopped: its late result is dropped.
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}
