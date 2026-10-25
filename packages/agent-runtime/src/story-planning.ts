import { randomUUID } from "node:crypto";

import type { ClineCore, CoreSessionConfig } from "@cline/sdk";

import type { PlanningHost } from "./planning-host.js";

import {
  initializationFallbackReadTools,
  legacyDirectWorkspaceTools,
  readTools,
  writeTools,
} from "./cline-tool-policy.js";
import { appendProductionConfig, assertWorkspacePath } from "./production.js";
import { loadPrompt } from "./prompt-loader.js";
import { reasoningConfig } from "./reasoning.js";
import {
  storyHistoryToolNames,
  storyHistoryTools,
  type StoryHistoryOptions,
} from "./story-history-tools.js";
import type {
  PlannedUserStory,
  PlanUserStoriesInput,
  PlanUserStoriesResult,
  StoryPlanMessage,
  StoryPlanPriority,
} from "./types.js";

type AgentTool = NonNullable<CoreSessionConfig["extraTools"]>[number];
type PlanningCredential = { apiKey: string; baseUrl: string | null };
type PlanReply = Omit<PlanUserStoriesResult, "sessionId">;

export type StoryPlanningHost = PlanningHost;

// The planning agent: one non-interactive run per message of the person.
// The conversation travels as a compact transcript plus the agent's own
// notes, so each turn costs the dialogue, not the previous turns' tool output.

export const storyPlanningSubmitToolName = "submit_plan_reply";
const maxStories = 12;
const maxTranscriptCharacters = 24_000;
const openStatuses = new Set(["backlog", "ready", "in-progress", "in-review"]);

// Streams the agent's steps under input.sessionId while it plans.
export async function runStoryPlanning(
  input: PlanUserStoriesInput,
  host: StoryPlanningHost,
) {
  assertWorkspacePath(input.cwd, input.workspaceRoot, "cwd");
  const credential = await host.credential(input);
  const cline = await host.core(input.backend);
  const sessionId =
    input.sessionId ||
    `${Date.now()}_${randomUUID().replaceAll("-", "").slice(0, 5)}`;
  const git = host.git;
  await host.subscribe(sessionId, input.backend);
  try {
    return await host.telemetry.runOperation(
      input,
      "story_planning",
      () =>
        planUserStories(input, cline, credential, sessionId, {
          ...(git ? { git: (args) => git(input.workspaceRoot, args) } : {}),
        }),
      credential.authMethod,
    );
  } finally {
    await host.unsubscribe(sessionId).catch(() => undefined);
  }
}

export async function planUserStories(
  input: PlanUserStoriesInput,
  cline: ClineCore,
  credential: PlanningCredential,
  sessionId: string,
  history: Pick<StoryHistoryOptions, "git" | "listStories" | "getStory"> = {},
): Promise<PlanUserStoriesResult> {
  if (!input.messages.some((message) => message.role === "user"))
    throw new Error("Planning needs a message from the person.");
  let submitted: PlanReply | undefined;
  const historyTools = storyHistoryTools({
    apiConnection: input.apiConnection,
    projectId: input.projectId,
    ...history,
  });
  const openStories = await openBacklog(historyTools).catch(() => "");
  const submit: AgentTool = {
    name: storyPlanningSubmitToolName,
    description:
      "Send your reply to the person: the message, the full current story proposal (empty when asking questions) and private notes for the next turn. Call it exactly once, last.",
    inputSchema: planReplySchema,
    lifecycle: { completesRun: true },
    execute(value: unknown) {
      submitted = planReply(value);
      return { accepted: true, stories: submitted.stories.length };
    },
  };
  const session = (await cline.start({
    prompt: planningPrompt(input, openStories),
    config: appendProductionConfig({
      sessionId,
      providerId: input.providerId,
      modelId: input.modelId,
      apiKey: credential.apiKey,
      baseUrl: credential.baseUrl ?? undefined,
      ...reasoningConfig(input.reasoningEffort),
      systemPrompt: loadPrompt("story-planner-system"),
      cwd: input.cwd,
      workspaceRoot: input.workspaceRoot,
      enableTools: true,
      enableSpawnAgent: false,
      enableAgentTeams: false,
      extraTools: [...historyTools, submit],
      maxIterations: 16,
    }),
    interactive: false,
    source: "blame-story-planning",
    toolPolicies: storyPlanningToolPolicies(),
  })) as { result?: { text?: unknown }; sessionId?: string };
  const reply = submitted ?? fallbackReply(session.result?.text);
  return { sessionId: session.sessionId ?? sessionId, ...reply };
}

export function storyPlanningToolPolicies() {
  return Object.fromEntries([
    ...[...readTools, ...writeTools].map((name) => [
      name,
      { enabled: false, autoApprove: false },
    ]),
    ...legacyDirectWorkspaceTools.map((name) => [
      name,
      initializationFallbackReadTools.has(name)
        ? { enabled: true, autoApprove: true }
        : { enabled: false, autoApprove: false },
    ]),
    ...storyHistoryToolNames.map((name) => [
      name,
      { enabled: true, autoApprove: true },
    ]),
    [storyPlanningSubmitToolName, { enabled: true, autoApprove: true }],
    ["ask_question", { enabled: false, autoApprove: false }],
    ["skills", { enabled: false, autoApprove: false }],
  ]);
}

export function planningPrompt(input: PlanUserStoriesInput, openStories = "") {
  const messages = input.messages;
  const lastUser = lastIndex(messages, (message) => message.role === "user");
  const latestProposal = lastIndex(
    messages,
    (message) =>
      message.role === "assistant" && Boolean(message.stories?.length),
  );
  const earlier = transcript(messages.slice(0, lastUser), latestProposal);
  return [
    openStories
      ? `<open_backlog>\nStories not merged yet (search_user_stories finds the rest):\n${openStories}\n</open_backlog>`
      : undefined,
    input.notes?.trim()
      ? `<your_notes>\n${input.notes.trim().slice(0, 3_000)}\n</your_notes>`
      : undefined,
    earlier ? `<conversation>\n${earlier}\n</conversation>` : undefined,
    `<latest_message>\n${messages[lastUser]!.text.trim()}\n</latest_message>`,
    "Reply to the latest message, then call submit_plan_reply.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function planReply(value: unknown): PlanReply {
  const input = recordValue(value);
  const message =
    typeof input.message === "string" && input.message.trim()
      ? input.message.trim()
      : "Here is my proposal.";
  const raw = Array.isArray(input.stories) ? input.stories : [];
  const stories: PlannedUserStory[] = [];
  for (const [index, item] of raw.slice(0, maxStories).entries()) {
    const story = plannedStory(item, index, stories);
    if (story) stories.push(story);
  }
  const keys = new Set(stories.map((story) => story.key));
  for (const story of stories)
    story.dependsOn = story.dependsOn.filter(
      (key) => key !== story.key && (keys.has(key) || /^US-\d+$/u.test(key)),
    );
  const notes =
    typeof input.notes === "string" && input.notes.trim()
      ? input.notes.trim().slice(0, 3_000)
      : undefined;
  return { message, stories, ...(notes ? { notes } : {}) };
}

function plannedStory(
  value: unknown,
  index: number,
  previous: PlannedUserStory[],
): PlannedUserStory | undefined {
  const item = recordValue(value);
  const title = textField(item.title).replace(/\s+/gu, " ").slice(0, 160);
  const summary = textField(item.summary).slice(0, 16_000);
  if (!title || !summary) return undefined;
  let key = textField(item.key).toUpperCase() || `P${index + 1}`;
  if (previous.some((story) => story.key === key)) key = `P${index + 1}`;
  return {
    key,
    title,
    summary,
    priority: priority(item.priority),
    dependsOn: Array.isArray(item.dependsOn)
      ? Array.from(
          new Set(
            item.dependsOn
              .map((entry) => storyKey(textField(entry)))
              .filter(Boolean),
          ),
        )
      : [],
  };
}

function storyKey(value: string) {
  const story = /^US[-_\s]?0*(\d+)$/iu.exec(value);
  if (story) return `US-${story[1]!.padStart(3, "0")}`;
  return value.toUpperCase();
}

function priority(value: unknown): StoryPlanPriority {
  const text = textField(value).toLowerCase();
  if (text === "high") return "High";
  if (text === "low") return "Low";
  return "Medium";
}

function fallbackReply(text: unknown): PlanReply {
  const message = typeof text === "string" ? text.trim() : "";
  if (!message) throw new Error("The planning agent did not reply.");
  return { message, stories: [] };
}

function transcript(messages: StoryPlanMessage[], latestProposal: number) {
  const lines = messages.map((message, index) =>
    message.role === "user"
      ? `Person: ${message.text.trim()}`
      : [
          `You: ${message.text.trim()}`,
          ...(message.stories ?? []).map((story) =>
            proposalLine(story, index === latestProposal),
          ),
        ].join("\n"),
  );
  // Keep the most recent exchanges when a long planning session grows.
  const kept: string[] = [];
  let size = 0;
  for (const line of lines.reverse()) {
    size += line.length;
    if (size > maxTranscriptCharacters && kept.length) {
      kept.push("[earlier messages omitted]");
      break;
    }
    kept.push(line);
  }
  return kept.reverse().join("\n\n");
}

function proposalLine(story: PlannedUserStory, full: boolean) {
  const state = story.addedAs
    ? ` → added to the backlog as ${story.addedAs}`
    : story.dismissed
      ? " → dismissed by the person"
      : "";
  const after = story.dependsOn.length
    ? ` after ${story.dependsOn.join(", ")}`
    : "";
  const heading = `  [${story.key}] ${story.title} (${story.priority}${after})${state}`;
  if (!full || story.addedAs || story.dismissed) return heading;
  return `${heading}\n${story.summary
    .trim()
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n")}`;
}

async function openBacklog(tools: AgentTool[]) {
  const search = tools.find((tool) => tool.name === "search_user_stories");
  if (!search) return "";
  const lines = String(
    await search.execute(
      { limit: 20 },
      {} as Parameters<AgentTool["execute"]>[1],
    ),
  )
    .split("\n")
    .filter((line) => /^US-\d+ · /u.test(line))
    .filter((line) => openStatuses.has(line.split(" · ")[1] ?? ""));
  return lines.join("\n");
}

function lastIndex<T>(items: T[], matches: (item: T) => boolean) {
  for (let index = items.length - 1; index >= 0; index -= 1)
    if (matches(items[index]!)) return index;
  return -1;
}

function textField(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const planReplySchema = {
  type: "object",
  properties: {
    message: {
      type: "string",
      description: "Your reply to the person, in Markdown and their language.",
    },
    stories: {
      type: "array",
      maxItems: maxStories,
      description: "The full current proposal. Empty when asking questions.",
      items: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description: "P1, P2… stable across revisions.",
          },
          title: { type: "string" },
          summary: {
            type: "string",
            description:
              "Markdown brief with context, acceptance criteria and notes.",
          },
          priority: { type: "string", enum: ["Low", "Medium", "High"] },
          dependsOn: {
            type: "array",
            items: { type: "string" },
            description:
              "Keys (P1) or story ids (US-012) that must be merged first.",
          },
        },
        required: ["key", "title", "summary", "priority", "dependsOn"],
        additionalProperties: false,
      },
    },
    notes: {
      type: "string",
      description: "Private working memory for your next turn.",
    },
  },
  required: ["message", "stories"],
  additionalProperties: false,
};
