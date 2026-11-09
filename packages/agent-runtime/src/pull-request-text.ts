import { appendProductionConfig } from "./production.js";
import { loadPrompt } from "./prompt-loader.js";
import { reasoningConfig } from "./reasoning.js";
import type { OpenPullRequestInput } from "./types.js";

// The pull request is read by reviewers, not only by the person who wrote the
// story: its title and body are always in English, whatever language the story
// and the agent's summary were written in.

export type PullRequestText = {
  title: string;
  summary: string;
  agentSummary?: string;
};

type PullRequestStory = Pick<
  OpenPullRequestInput,
  "title" | "summary" | "agentSummary"
>;

export function pullRequestTextConfig(
  input: OpenPullRequestInput,
  credential: { apiKey: string; baseUrl: string | null },
) {
  return appendProductionConfig({
    providerId: input.providerId,
    modelId: input.modelId,
    apiKey: credential.apiKey,
    baseUrl: credential.baseUrl ?? undefined,
    ...reasoningConfig(input.reasoningEffort),
    systemPrompt: loadPrompt("pull-request-text-system"),
    cwd: input.worktree,
    workspaceRoot: input.worktree,
    enableTools: false,
    enableSpawnAgent: false,
    enableAgentTeams: false,
    maxIterations: 2,
  });
}

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

// The agent's answer, or undefined when a section it must return is missing.
export function parsePullRequestText(
  output: unknown,
  expectAgentSummary: boolean,
): PullRequestText | undefined {
  if (typeof output !== "string") return undefined;
  const title = answerSection(output, "pr_title")?.replace(/\s+/gu, " ");
  const summary = answerSection(output, "pr_description");
  if (!title || !summary) return undefined;
  if (!expectAgentSummary) return { title, summary };
  const agentSummary = answerSection(output, "pr_agent_summary");
  return agentSummary ? { title, summary, agentSummary } : undefined;
}

function taggedSection(tag: string, content: string) {
  return `<${tag}>\n${content.trim()}\n</${tag}>`;
}

// Greedy: Markdown content may itself hold tags such as <details>.
function answerSection(output: string, tag: string) {
  const match = new RegExp(`<${tag}>([\\s\\S]*)</${tag}>`, "u").exec(output);
  return match?.[1]?.trim() || undefined;
}
