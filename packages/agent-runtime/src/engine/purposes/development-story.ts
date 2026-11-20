// A development story: an agent that implements a backlog item in the
// story's own worktree (or the project folder, in Direct mode), checked by
// the harness, with the story's managed preview when it has one.

import { earlierStoriesHint } from "../../development-prompt-parts.js";
import { normalizePersonalization } from "../../personalization.js";
import type { CompletionContract } from "@blame/engine-client";
import type { DevelopmentStorySettings, EngineMessage } from "../protocol.js";
import { engineModel, sessionToolNames, type Purpose } from "./purpose.js";
import {
  directFolderEnvironment,
  projectPrompt,
  worktreeEnvironment,
} from "./prompt.js";
import { purposeClientTools, purposeHarnessTools } from "./tool-sets.js";

/**
 * How a story's turn is complete: through a `finish_task` the harness
 * accepted, which ran the story's checks. The engine enforces it: a reply
 * that stops without one is corrected, and the turn fails as
 * `contract_unmet` when the agent still does not finish.
 */
export const storyCompletionContract: CompletionContract = {
  result: { source: "tool", name: "finish_task" },
  max_corrections: 2,
};

// The placeholder the app saves until the generated title arrives.
const untitledStory = "Untitled user story";

const storyGuidance = [
  "Work in the current worktree when code changes are clearly required.",
  "If the request is a question, analysis, opinion, explanation, or review request, inspect the project if useful and answer in Markdown without editing files. Your final reply is that answer, in the user's language, never a note that no change was needed.",
  "Only modify files when the request explicitly asks for implementation or when a concrete code change is necessary to satisfy it.",
  "Preview verification requires application_ready for the current source and environment revisions; browser_ready alone is transport state. A blocking compiler error or HTTP 500 returns immediately with its diagnostic.",
];

const previewGuidance =
  "After final UI edits, use get_preview_devtools with waitFor=ready once when available. Preview services, databases, containers, and dev servers are managed by Blame and must not be started manually. If preview infrastructure is unavailable, continue with local validation and report it.";

const proposalsGuidance =
  "When follow-up work deserves its own user story, or the person asks for stories, suggest them with `propose_user_stories` instead of doing that work now.";

export const developmentStoryPurpose: Purpose<DevelopmentStorySettings> = {
  workspace: (settings) => settings.workspace,
  config(settings, _session, { tools, clientTools, toolNames, promptDate }) {
    const names = sessionToolNames(
      toolNames,
      purposeHarnessTools["development-story"],
    );
    const direct = settings.workspaceMode === "direct";
    return {
      purpose: "development-story",
      workspace_root: settings.workspace.root,
      ...engineModel(settings.model),
      system_prompt: projectPrompt({
        template: "code-agent-system",
        workspaceRoot: settings.workspace.root,
        environment: direct ? directFolderEnvironment : worktreeEnvironment,
        // Guidance only for tools the session has (the preview and proposal
        // tools join through tool-sets.ts).
        preview:
          settings.previewDevtoolsScope &&
          names.includes("get_preview_devtools")
            ? previewGuidance
            : "",
        proposals: names.includes("propose_user_stories")
          ? proposalsGuidance
          : "",
        personalization: settings.personalization,
        practices: settings.codePractices,
        promptDate,
        tools: names,
      }),
      engine_tools: ["harness"],
      client_tools: tools.specs(clientTools),
      tool_options: {
        harness: {
          taskContract: {
            // A worktree is the story's own: its branch can be reset and
            // committed to. The project folder (Direct) is the person's.
            environment: {
              isolated: !direct,
              managedPreview: Boolean(settings.previewDevtoolsScope),
            },
            effect_requirement: "none",
            story_id: settings.storyId,
            // What a project memory left by this story is about.
            objective: settings.title,
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
      contract: storyCompletionContract,
    };
  },
  async firstMessage(settings, message, services) {
    return {
      ...message,
      text: await storyBrief(settings, message, services),
    };
  },
};

/** The story's first message: the request, then how to work on it. */
async function storyBrief(
  settings: DevelopmentStorySettings,
  message: EngineMessage,
  services: Parameters<
    NonNullable<typeof developmentStoryPurpose.firstMessage>
  >[2],
) {
  const title = settings.title.trim();
  const parts =
    title && title !== untitledStory
      ? [`Backlog item: ${title}`, "", message.text]
      : [message.text];
  const names = purposeClientTools["development-story"];
  const hint = names.includes("read_user_story")
    ? earlierStoriesHint(message.text, [])
    : undefined;
  if (hint) parts.push("", hint);
  parts.push("", ...storyGuidance);
  const memory = await services
    .projectMemory?.({
      projectId: settings.projectId,
      workspaceRoot: settings.workspace.root,
      objective: `${title}\n${message.text}`,
    })
    .catch(() => undefined);
  if (memory) parts.push("", `<task_briefing>\n${memory}\n</task_briefing>`);
  return parts.join("\n");
}
