import type { CompletionDecision } from "@blame/harness-core";
import { createTool, type AgentTool, type AgentToolContext } from "@cline/sdk";
import {
  finishTaskInputSchema,
  type FinishTaskImage,
} from "./light-contracts.js";
import type { LightRunTaskInput } from "./light-contracts.js";
import type { ProjectMemoryCandidate } from "./project-memory.js";
import type { LightValidationReport } from "./light-validation-report.js";

export const lightCompletionToolName = "finish_task";

export type LightCompletionNotification = {
  completion: CompletionDecision;
  // Screenshots shown above the final reply, in the agent's order.
  images?: FinishTaskImage[];
  memory?: ProjectMemoryCandidate;
  submission_outcome: "accepted" | "blocked";
  summary: string;
  verified: boolean;
  validationReport?: LightValidationReport;
};

export type LightValidationActivity = {
  input: LightRunTaskInput;
  output?: unknown;
  phase: "finished" | "started";
  toolCallId: string;
};

export function createLightCompletionTool(
  submit: (
    summary: string,
    images: FinishTaskImage[],
    context: AgentToolContext,
  ) => Promise<unknown>,
): AgentTool {
  return createTool({
    name: lightCompletionToolName,
    description:
      "Finish with the final reply the user reads. For a question, conversation, analysis or review, the summary is the answer itself, in the user's language, not a note that no change was needed. For code work, give a concise factual summary. Use run_task reporting or read_code @checks for test counts: null is unknown, pending is distinct from skipped, and unreported categories must not become zero. Separate commands run, passing tests, admitted verification and user criteria. Mention a non-obvious durable implementation decision only when it helps future work. The runtime checks known changes, reuses current checks, and refreshes relevant checks already requested in this session. Work without a current check is reported as unverified. Do not provide receipts or internal state. When the work changed something visible, attach the most useful screenshots you took in this run in images (before/after, each state that was asked for, light and dark when relevant), each with a one-line caption saying what it shows; refer to them as screenshot:<id>, exactly as the screenshot result named them. Do not attach screenshots that show nothing new.",
    inputSchema: finishTaskInputSchema as unknown as Record<string, unknown>,
    lifecycle: { completesRun: true },
    retryable: false,
    maxRetries: 0,
    execute(input: unknown, context: AgentToolContext) {
      const parsed = finishTaskInputSchema.parse(input);
      return submit(parsed.summary, finishImages(parsed.images), context);
    },
  });
}

// Drops repeated screenshots and keeps the agent's order.
export function finishImages(
  images: ReadonlyArray<{ caption: string; ref: string }> | undefined,
): FinishTaskImage[] {
  const seen = new Set<string>();
  const result: FinishTaskImage[] = [];
  for (const image of images ?? []) {
    const id = image.ref.slice("screenshot:".length);
    if (seen.has(id)) continue;
    seen.add(id);
    result.push({ caption: image.caption, id });
  }
  return result;
}
