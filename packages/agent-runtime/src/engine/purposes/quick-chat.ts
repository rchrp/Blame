// A quick chat: an agent that works in the project folder, on its current
// branch, with the harness and the web research tools.

import type { QuickChatSettings } from "../protocol.js";
import {
  engineModel,
  sessionToolNames,
  workspaceEngineTools,
  type Purpose,
} from "./purpose.js";
import { directFolderEnvironment, projectPrompt } from "./prompt.js";
import { normalizePersonalization } from "../../personalization.js";
import { purposeHarnessTools } from "./tool-sets.js";

export const quickChatPurpose: Purpose<QuickChatSettings> = {
  workspace: (settings) => ({ root: settings.workspaceRoot, location: "host" }),
  config(settings, _session, { tools, clientTools, toolNames, promptDate }) {
    return {
      purpose: "quick-chat",
      workspace_root: settings.workspaceRoot,
      ...engineModel(settings.model),
      system_prompt: projectPrompt({
        template: "code-agent-system",
        workspaceRoot: settings.workspaceRoot,
        environment: directFolderEnvironment,
        personalization: settings.personalization,
        practices: settings.codePractices,
        promptDate,
        tools: sessionToolNames(toolNames, purposeHarnessTools["quick-chat"]),
      }),
      engine_tools: workspaceEngineTools(settings.model),
      client_tools: tools.specs(clientTools),
      tool_options: {
        harness: {
          taskContract: {
            environment: { isolated: false, managedPreview: false },
            effect_requirement: "none",
          },
          responseStyle: normalizePersonalization(settings.personalization)
            .responseStyle,
        },
      },
      limits: settings.maxContextTokens
        ? { max_context_tokens: settings.maxContextTokens }
        : {},
      // Each message can be undone with its files.
      checkpoints: true,
    };
  },
};
