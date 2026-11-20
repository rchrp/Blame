// A quick chat: an agent that works in the project folder, on its current
// branch, with the harness and the web research tools.

import { basename } from "node:path";
import type { SessionConfig } from "@blame/engine-client";
import {
  developmentPracticePrompts,
  renderPrompt,
} from "../../development-prompt-parts.js";
import {
  normalizePersonalization,
  personalizationSystemSection,
} from "../../personalization.js";
import { loadPrompt } from "../../prompt-loader.js";
import { webResearchGuidance } from "../../web-research-calls.js";
import { engineReasoning, type QuickChatSettings } from "../protocol.js";
import type { ToolSet } from "../tool.js";

export const quickChatClientTools = ["search_web", "read_web_page"] as const;

const directFolder =
  "You work directly in the user's project folder, on their current branch, with no isolation. The folder may hold the user's own uncommitted work and other running processes. Never discard or overwrite changes you did not make: no git reset, git clean, git checkout or git stash, no branch switching, and no commits. Prefer ports and processes that do not collide with ones already running, and stop anything you start.";

export function quickChatConfig(
  settings: QuickChatSettings,
  tools: ToolSet,
  now = new Date(),
): SessionConfig {
  const provider = settings.model.providerId;
  const personalization = normalizePersonalization(settings.personalization);
  const reasoning = engineReasoning(settings.model.reasoning);
  return {
    purpose: "quick-chat",
    workspace_root: settings.workspaceRoot,
    model: { provider, model: settings.model.modelId },
    ...(reasoning ? { reasoning } : {}),
    system_prompt: quickChatSystemPrompt(settings, now),
    engine_tools: ["harness"],
    client_tools: tools.specs(quickChatClientTools),
    tool_options: {
      harness: {
        taskContract: {
          environment: { isolated: false, managedPreview: false },
          effect_requirement: "none",
        },
        responseStyle: personalization.responseStyle,
      },
    },
    limits: settings.maxContextTokens
      ? { max_context_tokens: settings.maxContextTokens }
      : {},
    // Each message can be undone with its files.
    checkpoints: true,
  };
}

function quickChatSystemPrompt(settings: QuickChatSettings, now: Date) {
  const personalization = normalizePersonalization(settings.personalization);
  const prompt = renderPrompt(loadPrompt("code-agent-system"), {
    BLAME_ENVIRONMENT: directFolder,
    // Another response style replaces the prompt's call for a concise reply.
    BLAME_FINAL_REPLY:
      personalization.responseStyle === "balanced"
        ? "concise factual"
        : "factual",
    BLAME_PARETO: loadPrompt("pareto/code-agent"),
    BLAME_PRACTICES: developmentPracticePrompts(settings.codePractices ?? []),
    BLAME_PREVIEW: "",
    BLAME_PROPOSALS: "",
    BLAME_SPECIALISTS: "",
    CURRENT_DATE: now.toISOString().slice(0, 10),
    CWD: settings.workspaceRoot,
    IDE_NAME: "Blame",
    PLATFORM_NAME: process.platform,
    WORKSPACE_METADATA: "",
    WORKSPACE_NAME: basename(settings.workspaceRoot),
    WORKSPACE_ROOT: settings.workspaceRoot,
  });
  const style = personalizationSystemSection(personalization);
  return [prompt + webResearchGuidance, style].filter(Boolean).join("\n\n");
}
