// A rough user story rewritten as a developer-ready one, in Markdown. No
// tools: the engine's `submit_user_story` is the only call the model may
// make, and its Markdown is the result.

import { loadPrompt } from "../../prompt-loader.js";
import type { OptimizeUserStoryTask } from "../task-protocol.js";
import {
  resultObject,
  submitTool,
  taskConfig,
  type TaskSpec,
} from "../tasks/runner.js";

export const USER_STORY_TOOL = "submit_user_story";

export function userStoryTask(
  input: OptimizeUserStoryTask,
): TaskSpec<{ markdown: string }> {
  if (!input.prompt.trim())
    throw new Error("User story optimization needs a user story.");
  return {
    config: taskConfig({
      purpose: "user-story-optimization",
      model: input.model,
      systemPrompt: loadPrompt("prompt-optimizer-agent-system"),
      workspace: input.workspace,
      contract: {
        result: submitTool(
          USER_STORY_TOOL,
          "Give the optimized user story, as Markdown.",
          {
            type: "object",
            additionalProperties: false,
            required: ["markdown"],
            properties: { markdown: { type: "string", minLength: 1 } },
          },
        ),
        allowed: [],
        max_corrections: 2,
      },
      limits: { max_requests_per_turn: 4, max_turn_ms: 300_000 },
    }),
    instruction: [
      "Optimize this rough user story prompt.",
      "",
      ...(input.title?.trim()
        ? [`Current title: ${input.title.trim()}`, ""]
        : []),
      "User prompt:",
      input.prompt.trim(),
    ].join("\n"),
    result: (value) => ({ markdown: userStoryMarkdown(value) }),
  };
}

/** The Markdown without the fence a model sometimes wraps it in. */
export function userStoryMarkdown(value: unknown) {
  const markdown = String(resultObject(value).markdown ?? "")
    .trim()
    .replace(/^```(?:markdown|md)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  if (!markdown)
    throw new Error("The user story optimizer returned no Markdown.");
  return markdown;
}
