// The system prompt of the agents that work in a project (quick chats and
// stories), from the prompt template.

import { basename } from "node:path";
import {
  developmentPracticePrompts,
  renderPrompt,
} from "../../development-prompt-parts.js";
import {
  normalizePersonalization,
  personalizationSystemSection,
  type AgentPersonalization,
} from "../../personalization.js";
import { loadPrompt } from "../../prompt-loader.js";
import type { ProjectCodePracticePreference } from "../../types.js";
import { webResearchGuidance } from "../../web-research-calls.js";

export const directFolderEnvironment =
  "You work directly in the user's project folder, on their current branch, with no isolation. The folder may hold the user's own uncommitted work and other running processes. Never discard or overwrite changes you did not make: no git reset, git clean, git checkout or git stash, no branch switching, and no commits. Prefer ports and processes that do not collide with ones already running, and stop anything you start.";

export const worktreeEnvironment =
  "Commands use the current process permissions. Keep their effects within the user's authorized scope and preserve unrelated state.";

export type ProjectPromptInput = {
  template: "code-agent-system";
  workspaceRoot: string;
  environment: string;
  /** Preview guidance, empty when the session has no preview tool. */
  preview?: string;
  /** Story proposals guidance, empty without the proposal tool. */
  proposals?: string;
  /** Guidance on the plan tool, empty when the session does not offer it. */
  plan?: string;
  personalization?: Partial<AgentPersonalization>;
  practices?: ProjectCodePracticePreference[];
  /** The day the conversation started: the prompt keeps it (prompt cache). */
  promptDate: Date;
  /** Every tool the session offers, by name. */
  tools: readonly string[];
};

export function projectPrompt(input: ProjectPromptInput) {
  const personalization = normalizePersonalization(input.personalization);
  const prompt = renderPrompt(loadPrompt(input.template), {
    BLAME_ENVIRONMENT: input.environment,
    // Another response style replaces the prompt's call for a concise reply.
    BLAME_FINAL_REPLY:
      personalization.responseStyle === "balanced"
        ? "concise factual"
        : "factual",
    BLAME_PARETO: loadPrompt("pareto/code-agent"),
    BLAME_PRACTICES: developmentPracticePrompts(input.practices ?? []),
    BLAME_PREVIEW: input.preview ?? "",
    BLAME_PLAN: input.plan ?? "",
    BLAME_PROPOSALS: input.proposals ?? "",
    CURRENT_DATE: input.promptDate.toISOString().slice(0, 10),
    CWD: input.workspaceRoot,
    IDE_NAME: "Blame",
    PLATFORM_NAME: process.platform,
    WORKSPACE_METADATA: "",
    WORKSPACE_NAME: basename(input.workspaceRoot),
    WORKSPACE_ROOT: input.workspaceRoot,
  });
  const web = input.tools.includes("search_web") ? webResearchGuidance : "";
  const style = personalizationSystemSection(personalization);
  return [prompt + web, style].filter(Boolean).join("\n\n");
}
