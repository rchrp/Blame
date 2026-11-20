// Resolves the merge conflicts of a worktree with the harness: it searches,
// reads and edits the conflicted files and may run checks, but cannot run
// git mutations (the workspace is not isolated), so the host stages what it
// resolved. Its contract makes it read code before it answers, and its
// result says whether it resolved everything, and why not.

import { loadPrompt } from "../../prompt-loader.js";
import type { GitFlowCall } from "../task-protocol.js";
import {
  resultObject,
  submitTool,
  taskConfig,
  type TaskSpec,
} from "../tasks/runner.js";

export const MERGE_RESOLUTION_TOOL = "submit_merge_resolution";
export const mergeConflictTools = [
  "search_code",
  "read_code",
  "edit_code",
  "run_task",
];

export type MergeResolution = { resolved: boolean; reason: string };

export function mergeConflictTask(
  input: Pick<GitFlowCall, "model" | "worktree" | "inVm">,
  instruction: string,
): TaskSpec<MergeResolution> {
  return {
    config: taskConfig({
      purpose: "merge-conflict-resolution",
      model: input.model,
      systemPrompt: loadPrompt("merge-conflict-resolution"),
      workspace: { root: input.worktree, inVm: input.inVm },
      engineTools: ["harness"],
      toolOptions: {
        harness: {
          taskContract: {
            environment: { isolated: false, managedPreview: false },
            effect_requirement: "none",
          },
        },
      },
      contract: {
        result: submitTool(
          MERGE_RESOLUTION_TOOL,
          "Say whether every conflict is resolved, with a short reason: what you resolved and checked, or what stopped you.",
          {
            type: "object",
            additionalProperties: false,
            required: ["resolved", "reason"],
            properties: {
              resolved: { type: "boolean" },
              reason: { type: "string", minLength: 1, maxLength: 2_000 },
            },
          },
        ),
        required: ["read_code"],
        allowed: mergeConflictTools,
        max_corrections: 2,
      },
      limits: { max_requests_per_turn: 20, max_turn_ms: 900_000 },
    }),
    instruction,
    result: mergeResolutionResult,
  };
}

export function mergeResolutionResult(value: unknown): MergeResolution {
  const result = resultObject(value);
  return {
    resolved: result.resolved === true,
    reason: String(result.reason ?? "").trim(),
  };
}
