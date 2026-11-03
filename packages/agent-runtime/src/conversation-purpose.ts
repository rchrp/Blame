import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentTool } from "./cline-initialization.js";
import { projectStackProposalTool } from "./new-project-planning.js";
import { storyProposalTool } from "./story-proposal-tool.js";
import type { StartDevelopmentSessionInput } from "./types.js";

// Plan mode and the new-project assistant are ordinary development sessions:
// same harness, same events, same conversation UI. Their purpose only adds
// or removes a few tools and picks the system prompt.

export type ConversationSessionOptions = {
  checkpointEnabled?: boolean;
  conversationTools: AgentTool[];
  toolFilter?: (name: string) => boolean;
};

// Plan mode reads code, history, the web and the computer; it never edits.
const planModeExcludedTools = new Set([
  "edit_code",
  "open_component_preview",
  "repair_preview_initialization",
]);

// The project does not exist yet: no code, preview, backlog or specialists.
const newProjectTools = new Set([
  "finish_task",
  "propose_project_stack",
  "read_attachment",
  "read_web_page",
  "run_task",
  "search_web",
]);

/**
 * The new-project assistant runs in a scratch folder of its own, so the
 * runtime never writes its logs or attachments into the user's folders.
 */
export async function conversationWorkspace(
  input: StartDevelopmentSessionInput,
  conversationId: string,
): Promise<StartDevelopmentSessionInput> {
  if (input.purpose !== "new-project") return input;
  const folder = join(
    tmpdir(),
    "blame-new-project-assistant",
    conversationId.replace(/[^\w.-]/gu, "_"),
  );
  await mkdir(folder, { recursive: true });
  return { ...input, cwd: folder, workspaceRoot: folder, projectId: undefined };
}

export function conversationSessionOptions(
  input: StartDevelopmentSessionInput,
): ConversationSessionOptions {
  if (input.purpose === "new-project")
    return {
      checkpointEnabled: false,
      conversationTools: [projectStackProposalTool()],
      toolFilter: (name) => newProjectTools.has(name),
    };
  return {
    ...(input.purpose === "plan"
      ? {
          checkpointEnabled: false,
          toolFilter: (name: string) => !planModeExcludedTools.has(name),
        }
      : { checkpointEnabled: input.checkpointEnabled }),
    conversationTools: input.projectId ? [storyProposalTool()] : [],
  };
}
