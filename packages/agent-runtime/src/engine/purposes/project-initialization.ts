// A project's preview setup (previewManifest, runConfigurations and its
// cloud exclusions) from a scan of its files and what the agent reads. The
// agent must read the code before it answers (`required`), with the
// harness's read-only tools. Its result tool is the host's own
// `submit_project_initialization`: Blame's rules check each submission as it
// comes (InitializationSession), a rejected one goes back to the agent as
// the call's error, and the same tool with only `blocked` reports what
// outside the repository stops the analysis.

import {
  InitializationBlockedError,
  InitializationSession,
  initializationBlockedSchema,
  submitInitializationToolName,
} from "../../initialization-session.js";
import type { CloudPreviewIgnoreRule } from "../../project-cloud-ignore.js";
import {
  parseProjectInitializationPayload,
  projectInitializationCorrectionPrompt,
  projectInitializationPrompt,
  projectInitializationResultSchema,
  scanProjectForInitialization,
} from "../../project-initialization.js";
import { loadPrompt } from "../../prompt-loader.js";
import type { ReasoningSelection } from "../../types.js";
import type {
  InitializeProjectTask,
  ProjectPreviewSetup,
} from "../task-protocol.js";
import { defineTool, toolSpec, type ClientTool } from "../tool.js";
import { assertHostScan, taskConfig, type TaskSpec } from "../tasks/runner.js";

/** The harness tools of an analysis that only reads the project. */
export const readOnlyHarness = {
  engineTools: ["harness"],
  toolOptions: {
    harness: {
      taskContract: {
        environment: { isolated: false, managedPreview: false },
        effect_requirement: "none",
      },
    },
  },
  allowed: ["search_code", "read_code"],
};

export type ProjectInitialization = ProjectPreviewSetup & {
  cloudPreviewIgnore?: CloudPreviewIgnoreRule[];
};

const setupKeys = [
  "cloudPreviewIgnore",
  "previewManifest",
  "runConfigurations",
];

export async function projectInitializationTask(
  input: InitializeProjectTask,
): Promise<TaskSpec<ProjectInitialization>> {
  const root = input.workspace.root;
  // The scan reads the folder on this computer: never one in the VM.
  assertHostScan(input.workspace);
  const config = (tools: ClientTool<never>[]) =>
    taskConfig({
      purpose: "project-initialization",
      model: input.model,
      systemPrompt: loadPrompt("project-initialization-system"),
      workspace: input.workspace,
      engineTools: readOnlyHarness.engineTools,
      toolOptions: readOnlyHarness.toolOptions,
      clientTools: tools.map((tool) => toolSpec(tool)),
      contract: {
        result: { source: "tool", name: submitInitializationToolName },
        required: ["read_code"],
        allowed: readOnlyHarness.allowed,
        max_corrections: 2,
      },
      limits: initializationLimits(input.model.reasoning),
    });
  const scan = await scanProjectForInitialization(root);
  const session = new InitializationSession((submitted, options) => {
    const missing = setupKeys.filter((key) => !(key in asRecord(submitted)));
    if (missing.length)
      throw new Error(
        `Initialization result is missing ${missing.join(", ")}: submit the complete setup`,
      );
    return parseProjectInitializationPayload(
      submitted,
      scan,
      input.preferences,
      options,
    );
  });
  const tools = [initializationSubmitTool(session)];
  return {
    config: config(tools),
    tools,
    instruction: input.validationFeedback
      ? projectInitializationCorrectionPrompt(
          scan,
          input.validationFeedback,
          input.preferences,
        )
      : projectInitializationPrompt(scan, input.preferences),
    // The session holds the setup as Blame normalized it, warnings included.
    result: () => initializationOutcome(session),
  };
}

/** What the analysis ended with, or why it gave no setup. */
export function initializationOutcome(
  session: InitializationSession<ProjectInitialization>,
): ProjectInitialization {
  const outcome = session.outcome();
  switch (outcome.type) {
    case "accepted":
      return outcome.result;
    case "blocked":
      throw new InitializationBlockedError(outcome.blocked);
    case "stopped":
      throw outcome.error;
    case "none":
      throw new Error("The project initialization agent submitted no setup.");
  }
}

/**
 * One tool for both endings, since only the result tool ends the task: the
 * setup (checked here, refused with every problem) or only `blocked`.
 */
export function initializationSubmitTool(
  session: InitializationSession<ProjectInitialization>,
) {
  return defineTool<Record<string, unknown>>({
    name: submitInitializationToolName,
    description:
      "Submit the complete Blame project initialization result: cloudPreviewIgnore, previewManifest and runConfigurations. Blame checks it immediately: a rejected result comes back as an error listing every problem to fix before submitting again. When something outside the repository and the setup you write blocks the analysis, submit only `blocked` instead.",
    inputSchema: {
      ...projectInitializationResultSchema,
      required: [],
      properties: {
        ...projectInitializationResultSchema.properties,
        blocked: initializationBlockedSchema,
      },
    },
    effect: "read_only",
    run: (input) => {
      if ("blocked" in input) {
        if (Object.keys(input).length > 1)
          throw new Error(
            "Submit either the complete setup or only `blocked`, not both.",
          );
        const block = session.reportBlocked(input.blocked);
        if (!block.recorded) throw new Error(block.message);
        return "Recorded: the analysis stops here and the user is told what blocks it.";
      }
      const answer: {
        accepted: boolean;
        savedWithWarnings?: boolean;
        stopped?: boolean;
        reason?: string;
        message?: string;
      } = session.submit(input);
      // A stopped analysis ends the task too; its result says why.
      if (answer.stopped) return `Stopped: ${answer.reason}`;
      if (!answer.accepted) throw new Error(answer.message);
      return answer.savedWithWarnings
        ? "Accepted with its warnings, which the user sees."
        : "Accepted.";
    },
  });
}

// An analysis takes minutes; a model that loops in its answer is stopped
// by the time limit rather than by the provider's output limit.
function initializationLimits(reasoning: ReasoningSelection | undefined) {
  const long = reasoning === "xhigh" || reasoning === "max";
  return {
    max_requests_per_turn: 60,
    max_turn_ms: (long ? 60 : 30) * 60_000,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}
