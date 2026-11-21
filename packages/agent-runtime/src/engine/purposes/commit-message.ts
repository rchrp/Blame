// A commit message for a story's work or the Git page's selection. No
// tools: the changes are in the instruction (status, changed files, diff
// stat, recent subjects), and `submit_commit_message` is the only call the
// model may make.

import { developmentPracticePrompt } from "../../development-prompt-parts.js";
import type { GitFlowCall } from "../task-protocol.js";
import {
  resultObject,
  submitTool,
  taskConfig,
  type TaskSpec,
} from "../tasks/runner.js";

export const COMMIT_MESSAGE_TOOL = "submit_commit_message";

export function commitMessageTask(
  input: Pick<GitFlowCall, "model" | "codePractices">,
  instruction: string,
): TaskSpec<string> {
  return {
    config: taskConfig({
      purpose: "commit-message",
      model: input.model,
      reasoningAtMost: "low",
      systemPrompt: developmentPracticePrompt(
        input.codePractices ?? [],
        "commit_message_convention",
      ),
      contract: {
        result: submitTool(
          COMMIT_MESSAGE_TOOL,
          "Give the commit message: one subject line.",
          {
            type: "object",
            additionalProperties: false,
            required: ["message"],
            properties: { message: { type: "string", minLength: 1 } },
          },
        ),
        allowed: [],
        max_corrections: 2,
      },
      limits: { max_requests_per_turn: 4, max_turn_ms: 180_000 },
      maxOutputTokens: 2_000,
    }),
    instruction,
    result: commitMessageResult,
  };
}

/**
 * The subject line Blame commits with (the story's issue trailers follow
 * it), without the fence or quotes a model sometimes wraps it in.
 */
export function commitMessageResult(value: unknown): string {
  const message = String(resultObject(value).message ?? "")
    .trim()
    .replace(/^```(?:text)?\s*/, "")
    .replace(/\s*```$/, "")
    .split("\n")
    .find((line) => line.trim())
    ?.trim()
    .replace(/^["'`]|["'`]$/g, "");
  if (!message) throw new Error("The commit message agent wrote no message.");
  return message;
}
