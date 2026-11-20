// Whether commits between two revisions make a project's saved preview
// setup obsolete. The host reads the diff itself; the agent gets only that
// summary and no tool: the engine's `submit_initialization_impact` is the
// only call it may make.

import {
  parseProjectInitializationImpactResult,
  projectInitializationImpactPrompt,
  projectInitializationImpactResultSchema,
  type ProjectInitializationImpact,
} from "../../project-initialization-impact.js";
import { loadPrompt } from "../../prompt-loader.js";
import type { ProjectInitializationImpactDiagnostics } from "../../types.js";
import type { AssessInitializationImpactTask } from "../task-protocol.js";
import { submitTool, taskConfig, type TaskSpec } from "../tasks/runner.js";

export const IMPACT_TOOL = "submit_initialization_impact";

export function initializationImpactTask(
  input: AssessInitializationImpactTask,
  diagnostics: ProjectInitializationImpactDiagnostics,
): TaskSpec<ProjectInitializationImpact> {
  return {
    config: taskConfig({
      purpose: "initialization-impact",
      model: input.model,
      systemPrompt: loadPrompt("project-initialization-impact-system"),
      workspace: input.workspace,
      contract: {
        result: submitTool(
          IMPACT_TOOL,
          "Give the classification and its reason, and for initialization_update_required the repair instruction.",
          projectInitializationImpactResultSchema,
        ),
        allowed: [],
        max_corrections: 2,
      },
      limits: { max_requests_per_turn: 4, max_turn_ms: 300_000 },
    }),
    instruction: projectInitializationImpactPrompt(diagnostics),
    result: parseProjectInitializationImpactResult,
  };
}
