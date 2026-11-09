import type { AgentTool } from "./cline-initialization.js";
import type { PlannedUserStory, StoryPlanPriority } from "./types.js";

// Lets any project conversation (chat, user story, plan mode) suggest user
// stories. Nothing is created: the app shows them as cards the person can
// edit and add to the backlog.

export const storyProposalToolName = "propose_user_stories";
const maxStories = 12;

export function storyProposalTool(): AgentTool {
  return {
    name: storyProposalToolName,
    description:
      "Propose user stories the person can add to their backlog. They appear as cards next to your reply; nothing is created until the person adds them. Each story is a self-contained brief for a coding agent that has not seen this conversation. To revise a proposal, call it again with the full revised set and reuse the keys of the stories that keep their meaning. Do not repeat the stories in your reply.",
    inputSchema: storyProposalSchema,
    execute(value: unknown) {
      const stories = proposedStories(value);
      if (!stories.length)
        throw new Error(
          "Propose at least one story with a title and a summary.",
        );
      return {
        shown: stories.length,
        keys: stories.map((story) => story.key),
        note: "The person reviews these cards and decides what to add.",
      };
    },
  };
}

/** The stories of a propose_user_stories call, cleaned and linked. */
export function proposedStories(value: unknown): PlannedUserStory[] {
  const input = recordValue(value);
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
  return stories;
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
    attachments: attachmentNames(item.attachments),
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

function textField(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function attachmentNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(value.map((entry) => textField(entry)).filter(Boolean)),
  );
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const storyProposalSchema = {
  type: "object",
  properties: {
    stories: {
      type: "array",
      minItems: 1,
      maxItems: maxStories,
      description:
        "Usually 1 to 5 stories: one per independently shippable, testable slice of value.",
      items: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description: "P1, P2… stable across revisions.",
          },
          title: {
            type: "string",
            description: "Imperative, at most 8 words, no story id.",
          },
          summary: {
            type: "string",
            description:
              'Markdown brief in the person\'s language: one or two sentences of context, "## Acceptance criteria" as a "- [ ]" checklist of observable outcomes, then optional "## Notes" (files, patterns to follow, earlier stories to read, out of scope).',
          },
          priority: {
            type: "string",
            enum: ["Low", "Medium", "High"],
            description: "High only for what blocks other work or users.",
          },
          dependsOn: {
            type: "array",
            items: { type: "string" },
            description:
              "Keys (P1) or story ids (US-012) that must be merged first. Empty unless the dependency is real.",
          },
          attachments: {
            type: "array",
            items: { type: "string" },
            description:
              "Names of the files the person attached in this conversation (screenshots, mockups, specs) that this story's coding agent needs, exactly as listed with their message. They are handed to that agent with the story. Omit for a story that needs none; never list a file a story does not use.",
          },
        },
        required: ["key", "title", "summary", "priority", "dependsOn"],
        additionalProperties: false,
      },
    },
  },
  required: ["stories"],
  additionalProperties: false,
};
