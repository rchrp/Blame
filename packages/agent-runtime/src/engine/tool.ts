// Tools the app runs for the engine (`client_tools`, served through
// `host/tool`). A tool is plain data plus a function: no agent framework
// stands between the model's call and the code that answers it.

import type {
  BlobRef,
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
 * A block of a tool's answer. An image is given as its bytes (base64): the
 * tool set stores it as a blob and the model receives the image itself.
 * `screenshot` is Blame's metadata of a stored preview screenshot; the
 * engine does not keep it.
 */
export type ToolContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      data: string;
      mediaType: string;
      screenshot?: Record<string, unknown>;
    }
  | { type: "image"; blob: BlobRef };

/**
 * What a tool returns. A string or a JSON value is the model's text; blocks
 * carry images too. `ok: false` tells the model the tool reported a failure
 * (a thrown error does the same with its message).
 */
export type ToolOutput =
  | string
  | { ok?: boolean; content: ToolContentBlock[] }
  | { ok?: boolean; json: unknown };

/** Where a tool comes from, for the policy and the guards (`tools/policy.ts`). */
export type ToolSource = {
  kind: "mcp";
  /** The MCP server, as named in the tool's name prefix. */
  server: string;
  /** The server marks the tool as changing nothing (`readOnlyHint`). */
  readOnly?: boolean;
};

export type ClientTool<Input = Record<string, unknown>> = {
  name: string;
  description: string;
  /** JSON Schema of the input object, as the model sees it. */
  inputSchema: Record<string, unknown>;
  /** The tool's own effect; the tool set's policy may decide another. */
  effect: ToolEffect;
  /** The turn ends when this tool succeeds. */
  endsTurn?: boolean;
  /** The user approves each call before it runs. */
  needsApproval?: boolean;
  /** Longest a call may run before it fails; none by default. */
  timeoutMs?: number;
  source?: ToolSource;
  run(input: Input, context: ToolCallContext): Promise<ToolOutput> | ToolOutput;
};

/** Keeps a tool's input type while letting a set hold tools of any input. */
export function defineTool<Input>(tool: ClientTool<Input>): ClientTool<Input> {
  return tool;
}

/** The effect and approval a tool runs with; the tool's own by default. */
export type ToolPolicy = (tool: ClientTool<never>) => {
  effect: ToolEffect;
  needsApproval: boolean;
};

/** One call, as the guards see it. */
export type GuardedCall = {
  tool: ClientTool<never>;
  session: string;
  input: Record<string, unknown>;
};

/**
 * Runs around every call of the set: `before` may refuse a call (the model
 * reads the reason), `after` may rewrite what the model reads.
 */
export type ToolGuard = {
  before?(call: GuardedCall): string | undefined;
  after?(call: GuardedCall, output: ToolOutput): ToolOutput;
};

export type ToolSetOptions = {
  policy?: ToolPolicy;
  guards?: ToolGuard[];
  /** Stores an image of a tool's answer (`blob/put`) for the session that called it. */
  putBlob?(
    params: { media_type: string; data: string },
    signal: AbortSignal,
    session: string,
  ): Promise<BlobRef>;
};

const ownPolicy: ToolPolicy = (tool) => ({
  effect: tool.effect,
  needsApproval: tool.needsApproval ?? false,
});

export function toolSpec(
  tool: ClientTool<never>,
  policy: ToolPolicy = ownPolicy,
): ToolSpec {
  const { effect, needsApproval } = policy(tool);
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as JsonValue,
    effect,
    ends_turn: tool.endsTurn ?? false,
    needs_approval: needsApproval,
  };
}

/**
 * The tools of the app, found by name when the engine calls one. Tools given
 * at construction serve every session; a session also has the tools bound to
 * it (its preview, its MCP servers), set with `setSessionTools`. The engine
 * only calls tools named in a session's `client_tools`, which come from these
 * same definitions.
 */
export class ToolSet {
  private readonly tools = new Map<string, ClientTool<never>>();
  private readonly sessions = new Map<string, Map<string, ClientTool<never>>>();
  private readonly options: ToolSetOptions;

  constructor(tools: ClientTool<never>[], options: ToolSetOptions = {}) {
    this.options = options;
    for (const tool of tools) {
      if (this.tools.has(tool.name))
        throw new Error(`Two client tools are named ${tool.name}`);
      this.tools.set(tool.name, tool);
    }
  }

  /** Replaces the tools bound to a session. */
  setSessionTools(session: string, tools: ClientTool<never>[]) {
    const bound = new Map<string, ClientTool<never>>();
    for (const tool of tools) {
      if (this.tools.has(tool.name) || bound.has(tool.name))
        throw new Error(`Two client tools are named ${tool.name}`);
      bound.set(tool.name, tool);
    }
    this.sessions.set(session, bound);
  }

  releaseSession(session: string) {
    this.sessions.delete(session);
  }

  /** The specs of the named shared tools (all of them by default). */
  specs(names?: readonly string[]): ToolSpec[] {
    const selected = names
      ? names.map((name) => this.require(name))
      : [...this.tools.values()];
    return selected.map((tool) => toolSpec(tool, this.options.policy));
  }

  /** The specs of the tools bound to a session, in the order they were given. */
  sessionSpecs(session: string): ToolSpec[] {
    return [...(this.sessions.get(session)?.values() ?? [])].map((tool) =>
      toolSpec(tool, this.options.policy),
    );
  }

  /** Answers `host/tool`. Never throws: every failure is a result the model reads. */
  async handle(
    params: HostParamsOf<"host/tool">,
    host: ToolHostContext,
  ): Promise<ToolResult> {
    const tool =
      this.sessions.get(params.session)?.get(params.name) ??
      this.tools.get(params.name);
    if (!tool)
      return failed(
        `There is no tool named ${params.name} in this app, or it is no longer available to this conversation.`,
      );
    const input = params.input;
    if (!input || typeof input !== "object" || Array.isArray(input))
      return failed(`${params.name} takes an object as its input.`);
    const call: GuardedCall = {
      tool,
      session: params.session,
      input: input as Record<string, unknown>,
    };
    for (const guard of this.options.guards ?? []) {
      const refused = guard.before?.(call);
      if (refused) return failed(refused);
    }
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
      let output = await abortable(
        Promise.resolve(tool.run(input as never, context)),
        signal,
      );
      for (const guard of this.options.guards ?? [])
        if (guard.after) output = guard.after(call, output);
      return await this.result(output, signal, params.session);
    } catch (error) {
      if (host.signal.aborted)
        return { outcome: "cancelled", content: [text("Cancelled.")] };
      if (signal.aborted)
        return failed(`${params.name} took longer than ${tool.timeoutMs} ms.`);
      return failed(error instanceof Error ? error.message : String(error));
    }
  }

  private async result(
    output: ToolOutput,
    signal: AbortSignal,
    session: string,
  ): Promise<ToolResult> {
    if (typeof output === "string")
      return { outcome: "completed", content: [text(output)] };
    const outcome = output.ok === false ? "failed" : "completed";
    if (!("content" in output))
      return { outcome, content: [text(JSON.stringify(output.json))] };
    const content: ToolResultBlock[] = [];
    for (const block of output.content) {
      if (block.type === "text") content.push(text(block.text));
      else if ("blob" in block) content.push(block);
      else if (!this.options.putBlob)
        content.push(text(`[An image of type ${block.mediaType}]`));
      else
        content.push({
          type: "image",
          blob: await this.options.putBlob(
            { media_type: block.mediaType, data: block.data },
            signal,
            session,
          ),
        });
    }
    return { outcome, content };
  }

  private require(name: string) {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`There is no client tool named ${name}`);
    return tool;
  }
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
