import { createTool, type AgentTool, type AgentToolContext } from "@cline/sdk";
import { z } from "zod";

import {
  blameSpecialistAgent,
  blameSpecialistAgentIds,
  blameSpecialistAgentMetadata,
} from "./specialist-agents.js";
import {
  specialistStepReader,
  specialistStepUpdate,
} from "./specialist-thread-events.js";

const consultSpecialistInputSchema = z.object({
  specialist: z.enum(blameSpecialistAgentIds),
  task: z.string().trim().min(1).max(12_000),
  context: z.string().trim().max(20_000).optional(),
  additional_consultation_justification: z
    .string()
    .trim()
    .min(20)
    .max(2_000)
    .optional(),
});

export type ConsultSpecialistInput = z.infer<
  typeof consultSpecialistInputSchema
>;

type ConsultSpecialistToolOptions = {
  capsule?: (input: ConsultSpecialistInput) => Promise<string | undefined>;
  objective?: string;
  spawnTool: SpawnTool;
  // Builds a spawn tool for one consultation that reports the sub-agent's
  // events, so its thread can be shown. Falls back to spawnTool.
  createSpawnTool?: (onSubAgentEvent: (event: unknown) => void) => SpawnTool;
  storyId?: string;
  timeoutMs?: number;
};

type SpawnTool = Pick<
  AgentTool<{ systemPrompt: string; task: string }, unknown>,
  "execute"
>;

type ConsultationState = {
  completed: Map<string, number>;
  inFlight: Map<string, Promise<unknown>>;
};

export function createConsultSpecialistTool(
  options: ConsultSpecialistToolOptions,
): AgentTool {
  const state: ConsultationState = {
    completed: new Map(),
    inFlight: new Map(),
  };
  return createTool<unknown, unknown>({
    name: "consult_specialist",
    description: [
      "Consult one private read-only adviser only when explicitly requested. The lead implements and verifies. Available:",
      ...blameSpecialistAgentMetadata.map(
        (agent) => `${agent.id} (${agent.name}): ${agent.routing}`,
      ),
    ].join("\n"),
    inputSchema: consultSpecialistInputSchema as unknown as Record<
      string,
      unknown
    >,
    timeoutMs: options.timeoutMs ?? 90_000,
    retryable: false,
    maxRetries: 0,
    execute: (raw: unknown, context: AgentToolContext) =>
      executeConsultation(raw, context, options, state),
  });
}

async function executeConsultation(
  raw: unknown,
  context: AgentToolContext,
  options: ConsultSpecialistToolOptions,
  state: ConsultationState,
) {
  const parsed = consultSpecialistInputSchema.safeParse(raw);
  if (!parsed.success) return invalidConsultation(parsed.error.issues);
  const specialist = blameSpecialistAgent(parsed.data.specialist);
  if (!specialist)
    return recoverableConsultationFailure(
      "UNKNOWN_SPECIALIST",
      "Unknown Blame specialist.",
    );
  const key = consultationKey(parsed.data, context, options.objective);
  const previous = state.completed.get(key);
  if (previous !== undefined) return repeatedConsultationReceipt(key);
  const pending = state.inFlight.get(key);
  if (pending) return pending;
  const execution = (async () => {
    const capsule = await options.capsule?.(parsed.data);
    const result = await executeWithDeadline(
      (signal) =>
        Promise.resolve(
          consultationSpawnTool(options, context).execute(
            {
              systemPrompt: specialist.systemPrompt,
              task: specialistTask(parsed.data, options, capsule),
            },
            { ...context, signal },
          ),
        ),
      context.signal,
      options.timeoutMs ?? 90_000,
    );
    if (completedConsultation(result)) state.completed.set(key, Date.now());
    return result;
  })();
  state.inFlight.set(key, execution);
  try {
    return await execution;
  } finally {
    if (state.inFlight.get(key) === execution) state.inFlight.delete(key);
  }
}

// Relays the specialist's steps as updates of this consult_specialist call.
function consultationSpawnTool(
  options: ConsultSpecialistToolOptions,
  context: AgentToolContext,
) {
  if (!options.createSpawnTool || !context.emitUpdate) return options.spawnTool;
  const emitUpdate = context.emitUpdate;
  const readStep = specialistStepReader();
  return options.createSpawnTool((event) => {
    const step = readStep(event);
    if (!step) return;
    try {
      emitUpdate(specialistStepUpdate(step));
    } catch {
      // The thread is a view; the consultation goes on without it.
    }
  });
}

function completedConsultation(value: unknown) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).outcome === "completed"
  );
}

function invalidConsultation(issues: Array<{ message: string }>) {
  return {
    outcome: "failed",
    fatal: false,
    reason: "INVALID_SPECIALIST_REQUEST",
    recommendation: "Correct the specialist request and continue.",
    isError: false,
    output: {
      error: "Invalid consult_specialist input.",
      issues: issues.map(({ message }) => message),
    },
  };
}

function repeatedConsultationReceipt(key: string) {
  return {
    outcome: "skipped",
    fatal: false,
    reason: "REPEATED_SPECIALIST_CONSULTATION",
    recommendation: "Use the previous consultation receipt.",
    isError: false,
    output: {
      previous_receipt: `specialist-consultation://${key}`,
      cached_summary:
        "This specialist already handled the same objective and source revision.",
    },
  };
}

function consultationKey(
  input: ConsultSpecialistInput,
  context: AgentToolContext,
  objective?: string,
) {
  const revision =
    context.metadata?.sourceRevisionId ??
    context.metadata?.source_revision_id ??
    "unversioned";
  return simpleDigest(
    [
      input.specialist,
      normalizedText(objective ?? ""),
      normalizedText(input.task),
      normalizedText(input.context ?? ""),
      normalizedText(String(revision)),
    ].join("\0"),
  );
}

async function executeWithDeadline(
  execute: (signal: AbortSignal) => Promise<unknown>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
) {
  if (signal?.aborted)
    return recoverableConsultationFailure(
      "SPECIALIST_CANCELLED",
      "The specialist consultation was cancelled.",
    );
  const controller = new AbortController();
  let stopReason: "SPECIALIST_CANCELLED" | "SPECIALIST_TIMEOUT" | undefined;
  let timeout: NodeJS.Timeout | undefined;
  let abortListener: (() => void) | undefined;
  const stopped = new Promise<unknown>((resolve) => {
    timeout = setTimeout(() => {
      stopReason = "SPECIALIST_TIMEOUT";
      controller.abort(stopReason);
      resolve(
        recoverableConsultationFailure(
          "SPECIALIST_TIMEOUT",
          `The specialist exceeded its ${timeoutMs} ms timeout.`,
        ),
      );
    }, timeoutMs);
    abortListener = () => {
      stopReason = "SPECIALIST_CANCELLED";
      controller.abort(signal?.reason);
      resolve(
        recoverableConsultationFailure(
          "SPECIALIST_CANCELLED",
          "The specialist consultation was cancelled.",
        ),
      );
    };
    signal?.addEventListener("abort", abortListener, { once: true });
  });
  try {
    const execution = execute(controller.signal).catch((error: unknown) =>
      stopReason
        ? recoverableConsultationFailure(
            stopReason,
            stopReason === "SPECIALIST_TIMEOUT"
              ? `The specialist exceeded its ${timeoutMs} ms timeout.`
              : "The specialist consultation was cancelled.",
          )
        : recoverableSpecialistExecutionFailure(error),
    );
    const result = await Promise.race([execution, stopped]);
    if (stopReason)
      return recoverableConsultationFailure(
        stopReason,
        stopReason === "SPECIALIST_TIMEOUT"
          ? `The specialist exceeded its ${timeoutMs} ms timeout.`
          : "The specialist consultation was cancelled.",
      );
    return completedConsultationResult(result);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (abortListener) signal?.removeEventListener("abort", abortListener);
  }
}

function recoverableSpecialistExecutionFailure(error: unknown) {
  return {
    outcome: "failed",
    fatal: false,
    reason: "SPECIALIST_FAILED",
    recommendation: "Continue without the specialist or report the limitation.",
    isError: false,
    output: {
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

function completedConsultationResult(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const result = value as Record<string, unknown>;
  if (result.outcome) return result;
  return {
    outcome: result.isError === true ? "failed" : "completed",
    fatal: false,
    reason:
      result.isError === true
        ? "SPECIALIST_FAILED"
        : "SPECIALIST_CONSULTATION_COMPLETED",
    recommendation: "Apply the useful advice and continue as the lead agent.",
    ...result,
    isError: false,
  };
}

function recoverableConsultationFailure(reason: string, message: string) {
  return {
    outcome: "blocked",
    fatal: false,
    reason,
    recommendation:
      "Continue without the specialist or finish with the identified limitation.",
    isError: false,
    output: { message },
  };
}

function normalizedText(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

function simpleDigest(value: string) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0)!;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function specialistTask(
  input: ConsultSpecialistInput,
  options: Omit<ConsultSpecialistToolOptions, "spawnTool">,
  capsule?: string,
) {
  return [
    "You are advising the lead Blame development agent. Do not implement or modify anything.",
    options.objective
      ? `<root_user_objective>\n${options.objective}\n</root_user_objective>`
      : undefined,
    options.storyId ? `<story_id>${options.storyId}</story_id>` : undefined,
    capsule,
    `<lead_request>\n${input.task}\n</lead_request>`,
    input.context
      ? `<relevant_context>\n${input.context}\n</relevant_context>`
      : undefined,
    input.additional_consultation_justification
      ? `<additional_consultation_justification>\n${input.additional_consultation_justification}\n</additional_consultation_justification>`
      : undefined,
    "Treat revision-bound runtime evidence as authoritative. Do not inventory files, manifests, lockfiles, or dependencies already listed in it.",
    "Inspect at most three targeted files and use at most one discovery search unless the lead explicitly requests a broader audit.",
    "Stop as soon as the decision is supported. Return a concise recommendation, up to three evidence references, and only material unresolved uncertainty.",
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n\n");
}
