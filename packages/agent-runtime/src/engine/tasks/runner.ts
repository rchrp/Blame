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
  ErrorInfo,
  HostParamsOf,
  Limits,
  ReasoningEffort,
  SessionConfig,
  TaskOutcome,
  ToolHostContext,
  ToolResult,
  ToolSpec,
} from "@blame/engine-client";
import type { EngineLocation, EngineModelChoice } from "../protocol.js";
import { engineModel } from "../purposes/purpose.js";
import type { TaskWorkspace } from "../task-protocol.js";
import { ToolSet, type ClientTool } from "../tool.js";
import { usageResetAt } from "./usage-reset.js";

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
  /** Where its engine is: the VM's for a task on a VM workspace with tools. */
  location?: EngineLocation;
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
export function failureText(outcome: Failure, now = Date.now()): string {
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
      return providerFailureText(failure.error, now);
  }
}

/**
 * A plan used up or an account out of credit cannot succeed by running the
 * task again with the same model: the text says so, with the instant the
 * plan resets when known (the app names the setting that picks the model,
 * and waits for that instant before running it by itself again).
 */
function providerFailureText(error: ErrorInfo, now: number) {
  if (error.kind === "billing") return `could not run: ${error.message}`;
  if (error.kind !== "usage_limit") return `failed: ${error.message}`;
  const resetsAt = usageResetAt(error, now);
  return `could not run: ${error.message}${resetsAt ? ` It resets at ${resetsAt.toISOString()}.` : ""}`;
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
  private readonly client: (location: EngineLocation) => Promise<EngineClient>;
  /**
   * Task ids whose call reached the host and whose session the engine has
   * not created yet (a project scan can come first), each with the follows
   * waiting for it.
   */
  private readonly announced = new Map<string, Array<() => void>>();
  /** Announced tasks cancelled before they ran: they end as interrupted. */
  private readonly cancelledEarly = new Set<string>();

  /** Where a task working in a folder runs: the VM's engine for a VM folder. */
  private readonly locate: (workspaceRoot: string) => EngineLocation;

  constructor(
    client: (location: EngineLocation) => Promise<EngineClient>,
    locate: (workspaceRoot: string) => EngineLocation = () => "host",
  ) {
    this.client = client;
    this.locate = locate;
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
      // A task that works on files in the runtime VM runs on the VM's engine.
      const client = await this.client(
        spec.location ?? this.locate(spec.config.workspace_root),
      );
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
  /**
   * The most reasoning the task uses: a short text (a title, a commit
   * message) gains nothing from the person's high effort and waits for it.
   * Lower settings are kept; the engine gives the model its nearest level.
   */
  reasoningAtMost?: ReasoningEffort;
  maxOutputTokens?: number;
  /** Copy the log to Blame's database (a long task the person may look back at). */
  replicate?: boolean;
};

/** The configuration of a task, from what a purpose decides. */
export function taskConfig(input: TaskConfigInput): SessionConfig {
  return {
    purpose: input.purpose,
    workspace_root: taskRoot(input.workspace, input.engineTools?.length),
    ...cappedReasoning(engineModel(input.model), input.reasoningAtMost),
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

const efforts: ReasoningEffort[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function cappedReasoning<M extends { reasoning?: ReasoningEffort }>(
  model: M,
  most: ReasoningEffort | undefined,
): M {
  if (!most || !model.reasoning) return model;
  return efforts.indexOf(model.reasoning) > efforts.indexOf(most)
    ? { ...model, reasoning: most }
    : model;
}

/** Said when a task must scan a folder on this computer that lives in the VM. */
export const VM_SCAN_UNSUPPORTED =
  "This task scans the project folder on this computer, and this folder lives in the Blame Runtime VM.";

/** Refuses a workspace in the VM for a task that scans its files here first. */
export function assertHostScan(workspace: TaskWorkspace) {
  if (workspace.inVm) throw new Error(VM_SCAN_UNSUPPORTED);
}

/**
 * The folder the engine works in. A task that reads files works in its
 * workspace, on the VM's engine when the workspace lives in the VM (the
 * runner locates it); one that reads none works in this computer's
 * temporary folder, which spares starting the VM's engine.
 */
function taskRoot(workspace: TaskWorkspace | undefined, tools = 0): string {
  if (workspace && (!workspace.inVm || tools > 0)) return workspace.root;
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
