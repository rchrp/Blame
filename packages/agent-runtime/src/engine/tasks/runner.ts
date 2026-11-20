// Runs engine tasks (docs/engine-in-the-app.md, "Tasks"): an agent run with
// no user in it, whose end the engine enforces through a completion contract.
// A purpose (engine/purposes/) builds the task; this module runs it, turns
// its outcome into a typed result or a typed error, and lets the renderer
// cancel it. Nothing here imports Cline.

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import type {
  CompletionContract,
  EngineClient,
  HostParamsOf,
  Limits,
  SessionConfig,
  TaskOutcome,
  ToolHostContext,
  ToolResult,
  ToolSpec,
} from "@blame/engine-client";
import type { EngineModelChoice } from "../protocol.js";
import { engineModel } from "../purposes/purpose.js";
import type { TaskWorkspace } from "../task-protocol.js";
import { ToolSet, type ClientTool } from "../tool.js";

/** A task as a purpose describes it. */
export type TaskSpec<R> = {
  config: SessionConfig;
  /** The message that opens the task's only turn. */
  instruction: string;
  /** The typed result, from the input the engine validated against the result schema. */
  result(value: unknown): R;
  /**
   * Client tools of this task alone, served while it runs: a result tool
   * the host checks itself (`{ source: "tool" }`), with state of its own.
   * Their specs go in the config's `client_tools` (`toolSpec`).
   */
  tools?: ClientTool<never>[];
};

type Failure = Exclude<TaskOutcome, { status: "completed" }>;

/** A task that did not complete: what the engine said, typed. */
export class EngineTaskError extends Error {
  readonly outcome: Failure;
  readonly session: string;

  constructor(session: string, outcome: Failure, what: string) {
    super(`${what} ${failureText(outcome)}`);
    this.name = "EngineTaskError";
    this.session = session;
    this.outcome = outcome;
  }
}

/** Why a task did not complete, in words. */
export function failureText(outcome: Failure): string {
  if (outcome.status === "interrupted") return "was stopped.";
  const { failure } = outcome;
  switch (failure.kind) {
    case "contract_unmet":
      return `did not finish: the agent never ${failure.unmet
        .map((obligation) =>
          obligation.kind === "call"
            ? `called \`${obligation.tool}\``
            : `gave its result with \`${obligation.tool}\``,
        )
        .join(" and ")}.`;
    case "limit_reached":
      return `stopped at its limit (${failure.limit}).`;
    case "provider_error":
      return `failed: ${failure.error.message}`;
  }
}

export type TaskRunOptions = {
  /** The task's session id, when the caller wants to follow or cancel it. */
  session?: string;
  signal?: AbortSignal;
  /** What the failure message starts with ("The title generator"). */
  what: string;
};

/**
 * Runs tasks on the engine. Each running task can be cancelled by its
 * session id; a cancelled or failed task rejects with `EngineTaskError`.
 */
export class TaskRunner {
  private readonly running = new Map<string, AbortController>();
  private readonly tools = new Map<string, ToolSet>();
  private readonly client: () => Promise<EngineClient>;
  /**
   * Task ids whose call reached the host and whose session the engine has
   * not created yet (a project scan can come first), each with the follows
   * waiting for it.
   */
  private readonly announced = new Map<string, Array<() => void>>();
  /** Announced tasks cancelled before they ran: they end as interrupted. */
  private readonly cancelledEarly = new Set<string>();

  constructor(client: () => Promise<EngineClient>) {
    this.client = client;
  }

  /**
   * A call that runs the task `session` arrived: a follow of it waits for
   * its session (`whenCreated`) until `settled`.
   */
  announce(session: string) {
    if (!this.announced.has(session)) this.announced.set(session, []);
  }

  /** The task's session exists, or the call ended without one. */
  settled(session: string) {
    const waiting = this.announced.get(session);
    this.announced.delete(session);
    if (!this.running.has(session)) this.cancelledEarly.delete(session);
    for (const resolve of waiting ?? []) resolve();
  }

  /** Resolves once the engine has the session of an announced task; at once otherwise. */
  whenCreated(session: string): Promise<void> {
    const waiting = this.announced.get(session);
    if (!waiting) return Promise.resolve();
    return new Promise((resolve) => waiting.push(resolve));
  }

  async run<R>(
    spec: TaskSpec<R>,
    options: TaskRunOptions,
  ): Promise<{ session: string; result: R }> {
    const session = options.session ?? `task-${randomUUID()}`;
    if (this.running.has(session))
      throw new Error(`The task ${session} is already running.`);
    const controller = new AbortController();
    const forward = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted || this.cancelledEarly.delete(session))
      forward();
    options.signal?.addEventListener("abort", forward, { once: true });
    this.running.set(session, controller);
    if (spec.tools?.length) this.tools.set(session, new ToolSet(spec.tools));
    try {
      // Stopped before it ran: the engine never hears of it.
      if (controller.signal.aborted)
        throw new EngineTaskError(
          session,
          { status: "interrupted" },
          options.what,
        );
      const client = await this.client();
      const pending = client.runTask(
        {
          session,
          config: spec.config,
          instruction: [{ type: "text", text: spec.instruction }],
        },
        { signal: controller.signal },
      );
      // The engine reads no message before the session exists: a follow
      // sent after this one finds it.
      this.settled(session);
      let outcome: TaskOutcome;
      try {
        outcome = await pending;
      } catch (error) {
        // Aborting rejects at once; the engine ends the task as interrupted.
        if (controller.signal.aborted) outcome = { status: "interrupted" };
        else throw error;
      }
      if (outcome.status !== "completed")
        throw new EngineTaskError(session, outcome, options.what);
      return { session, result: spec.result(outcome.result) };
    } finally {
      options.signal?.removeEventListener("abort", forward);
      this.running.delete(session);
      this.tools.delete(session);
    }
  }

  /** Answers `host/tool` for a running task's own tool; undefined otherwise. */
  handleTool(
    params: HostParamsOf<"host/tool">,
    host: ToolHostContext,
  ): Promise<ToolResult> | undefined {
    return this.tools.get(params.session)?.handle(params, host);
  }

  /**
   * Stops a running task, or one announced and still being prepared (it
   * then ends as interrupted without running); false when there is none.
   */
  cancel(session: string): boolean {
    const controller = this.running.get(session);
    if (controller) {
      controller.abort();
      return true;
    }
    if (!this.announced.has(session)) return false;
    this.cancelledEarly.add(session);
    return true;
  }

  /** Every running task stops (the app quits). */
  cancelAll() {
    for (const controller of this.running.values()) controller.abort();
  }
}

export type TaskConfigInput = {
  purpose: string;
  model: EngineModelChoice;
  systemPrompt: string;
  contract: CompletionContract;
  /** Where the task works; absent for a task that reads no file. */
  workspace?: TaskWorkspace;
  engineTools?: string[];
  clientTools?: ToolSpec[];
  toolOptions?: SessionConfig["tool_options"];
  limits?: Limits;
  maxOutputTokens?: number;
  /** Copy the log to Blame's database (a long task the person may look back at). */
  replicate?: boolean;
};

/** The configuration of a task, from what a purpose decides. */
export function taskConfig(input: TaskConfigInput): SessionConfig {
  return {
    purpose: input.purpose,
    workspace_root: taskRoot(input.workspace, input.engineTools?.length),
    ...engineModel(input.model),
    system_prompt: input.systemPrompt,
    ...(input.maxOutputTokens
      ? { max_output_tokens: input.maxOutputTokens }
      : {}),
    engine_tools: input.engineTools ?? [],
    client_tools: input.clientTools ?? [],
    tool_options: input.toolOptions ?? {},
    limits: input.limits ?? {},
    checkpoints: false,
    kind: { kind: "task", replicate: input.replicate ?? false },
    contract: input.contract,
  };
}

/** Said when a task needs files that live in the runtime VM. */
export const VM_WORKSPACE_UNSUPPORTED =
  "This project runs in the Blame Runtime VM, and Blame's agent engine does not run inside the VM yet: this agent cannot work on its files until it does.";

/**
 * The folder the engine works in. A task that reads files needs the
 * workspace on this machine; one that reads none works in the temporary
 * folder when the project lives in the VM.
 */
function taskRoot(workspace: TaskWorkspace | undefined, tools = 0): string {
  if (workspace && !workspace.inVm) return workspace.root;
  if (workspace?.inVm && tools > 0) throw new Error(VM_WORKSPACE_UNSUPPORTED);
  return tmpdir();
}

/** A result tool the engine defines and answers itself. */
export function submitTool(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
): CompletionContract["result"] {
  return {
    source: "submit",
    name,
    description,
    input_schema: inputSchema as SessionConfig["tool_options"],
  };
}

/** The object at `value`, or an error naming what was expected. */
export function resultObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("The engine accepted a result that is not an object.");
  return value as Record<string, unknown>;
}
