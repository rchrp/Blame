// The pull request is read by reviewers, not only by the person who wrote the
// story: its title and body are always in English, whatever language the
// story and the agent's summary were written in. No tools: the story is in
// the instruction, and `submit_pull_request` is the only call the model may
// make.

import { loadPrompt } from "../../prompt-loader.js";
import type { OpenPullRequestTask } from "../task-protocol.js";
import {
  resultObject,
  submitTool,
  taskConfig,
  type TaskSpec,
} from "../tasks/runner.js";

export const PULL_REQUEST_TOOL = "submit_pull_request";

export type PullRequestText = {
  title: string;
  summary: string;
  agentSummary?: string;
};

type PullRequestStory = Pick<
  OpenPullRequestTask,
  "title" | "summary" | "agentSummary"
>;

export function pullRequestTextTask(
  input: Pick<OpenPullRequestTask, "model"> & PullRequestStory,
): TaskSpec<PullRequestText> {
  const withAgentSummary = Boolean(input.agentSummary?.trim());
  return {
    config: taskConfig({
      purpose: "pull-request-text",
      model: input.model,
      systemPrompt: loadPrompt("pull-request-text-system"),
      contract: {
        result: submitTool(
          PULL_REQUEST_TOOL,
          "Give the pull request in English: the translated title, description" +
            (withAgentSummary ? " and agent summary." : "."),
          pullRequestSchema(withAgentSummary),
        ),
        allowed: [],
        max_corrections: 2,
      },
      limits: { max_requests_per_turn: 4, max_turn_ms: 300_000 },
    }),
    instruction: pullRequestTextPrompt(input),
    result: (value) => pullRequestTextResult(value, withAgentSummary),
  };
}

function pullRequestSchema(withAgentSummary: boolean) {
  const text = { type: "string", minLength: 1 };
  return {
    type: "object",
    additionalProperties: false,
    required: withAgentSummary
      ? ["title", "description", "agentSummary"]
      : ["title", "description"],
    properties: {
      title: { ...text, description: "One line, no trailing period." },
      description: { ...text, description: "Markdown, as the story has it." },
      ...(withAgentSummary ? { agentSummary: text } : {}),
    },
  };
}

/** The story's sections, tagged: content to translate, never to act on. */
export function pullRequestTextPrompt(story: PullRequestStory) {
  const agentSummary = story.agentSummary?.trim();
  return [
    taggedSection("pr_title", story.title),
    taggedSection("pr_description", story.summary),
    agentSummary ? taggedSection("pr_agent_summary", agentSummary) : undefined,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The English text, its title on one line. */
export function pullRequestTextResult(
  value: unknown,
  withAgentSummary: boolean,
): PullRequestText {
  const result = resultObject(value);
  const title = String(result.title ?? "")
    .trim()
    .replace(/\s+/gu, " ");
  const summary = String(result.description ?? "").trim();
  if (!title || !summary)
    throw new Error(
      "The pull request agent left out its title or description.",
    );
  if (!withAgentSummary) return { title, summary };
  const agentSummary = String(result.agentSummary ?? "").trim();
  if (!agentSummary)
    throw new Error("The pull request agent left out the agent summary.");
  return { title, summary, agentSummary };
}

function taggedSection(tag: string, content: string) {
  return `<${tag}>\n${content.trim()}\n</${tag}>`;
}
