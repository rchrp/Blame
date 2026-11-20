// Plan mode: an agent that reads the project, discusses the next work and
// proposes stories for the backlog. It never edits.

import { normalizePersonalization } from "../../personalization.js";
import type { PlanSettings } from "../protocol.js";
import { engineModel, sessionToolNames, type Purpose } from "./purpose.js";
import { directFolderEnvironment, projectPrompt } from "./prompt.js";
import { purposeHarnessTools } from "./tool-sets.js";

export const planPurpose: Purpose<PlanSettings> = {
  workspace: (settings) => settings.workspace,
  config(settings, _session, { tools, clientTools, promptDate }) {
    const harnessTools = purposeHarnessTools.plan;
    return {
      purpose: "plan",
      workspace_root: settings.workspace.root,
      ...engineModel(settings.model),
      system_prompt: projectPrompt({
        template: "plan-agent-system",
        workspaceRoot: settings.workspace.root,
        environment: directFolderEnvironment,
        personalization: settings.personalization,
        promptDate,
        tools: sessionToolNames(clientTools, harnessTools),
      }),
      engine_tools: ["harness"],
      client_tools: tools.specs(clientTools),
      tool_options: {
        harness: {
          taskContract: {
            environment: { isolated: false, managedPreview: false },
            effect_requirement: "none",
          },
          responseStyle: normalizePersonalization(settings.personalization)
            .responseStyle,
          ...(harnessTools ? { tools: [...harnessTools] } : {}),
        },
      },
      limits: settings.maxContextTokens
        ? { max_context_tokens: settings.maxContextTokens }
        : {},
      // Nothing to undo: it does not edit.
      checkpoints: false,
    };
  },
};
