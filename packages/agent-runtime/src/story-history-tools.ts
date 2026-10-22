import type { CoreSessionConfig } from "@cline/sdk";

import { getProjectUserStory, listProjectUserStories } from "./cloud-api.js";
import type { ApiConnection } from "./types.js";

type AgentTool = NonNullable<CoreSessionConfig["extraTools"]>[number];

// Lets an agent find earlier user stories of its project and load what
// happened in them, in two cheap steps: a ranked one-line-per-story search,
// then a digest of one story whose sections are opt-in. Results are plain
// text sized for a model's context, not raw API records.

export const storyHistoryToolNames = [
  "search_user_stories",
  "read_user_story",
] as const;

export type StoryHistoryOptions = {
  apiConnection: ApiConnection;
  projectId: string;
  // The story the agent works on; left out of search results.
  storyId?: string;
  // Lists the files a merged story changed, when Git is reachable.
  git?: (args: string[]) => Promise<string>;
  // Stories are fetched through these; tests replace them.
  listStories?: () => Promise<unknown>;
  getStory?: (id: string) => Promise<unknown>;
};

export type StorySection =
  | "request"
  | "outcome"
  | "discussion"
  | "files"
  | "activity";

export type StoryRecord = {
  id: string;
  storyNumber: number;
  title: string;
  summary: string;
  status: string;
  priority?: string;
  branch?: string | null;
  baseCommit?: string | null;
  mergeCommit?: string | null;
  mergedAt?: string | null;
  discardedReason?: string | null;
  agentSessionSummary?: string | null;
  agentFinalResponse?: string | null;
  agentActivities?: Array<Record<string, unknown>> | null;
  comments?: Array<Record<string, unknown>> | null;
  agentRuns?: Array<Record<string, unknown>> | null;
  createdAt?: string;
  updatedAt?: string | null;
};

const statuses = [
  "backlog",
  "ready",
  "in-progress",
  "in-review",
  "done",
  "discarded",
] as const;
const sections: StorySection[] = [
  "request",
  "outcome",
  "discussion",
  "files",
  "activity",
];
const defaultSections: StorySection[] = ["request", "outcome", "files"];
const listCacheMs = 30_000;

export function storyHistoryTools(options: StoryHistoryOptions): AgentTool[] {
  const listStories =
    options.listStories ??
    (() => listProjectUserStories(options.apiConnection, options.projectId));
  const getStory =
    options.getStory ??
    ((id: string) => getProjectUserStory(options.apiConnection, id));
  let cachedList: { at: number; stories: Promise<StoryRecord[]> } | undefined;
  const details = new Map<string, Promise<StoryRecord | undefined>>();
  const summaries = () => {
    if (!cachedList || Date.now() - cachedList.at > listCacheMs) {
      const stories = Promise.resolve(listStories()).then(storyRecords);
      cachedList = { at: Date.now(), stories };
      stories.catch(() => {
        if (cachedList?.stories === stories) cachedList = undefined;
      });
    }
    return cachedList.stories;
  };
  const detail = (id: string) => {
    let story = details.get(id);
    if (!story) {
      story = Promise.resolve(getStory(id)).then(storyRecord);
      details.set(id, story);
      story.catch(() => details.delete(id));
    }
    return story;
  };

  return [
    {
      name: "search_user_stories",
      description:
        "Find earlier user stories of this project: past features, fixes and their outcome. Use it when the request mentions a previous story (US-012), continues or repairs earlier work, or when you need to know why existing code was written. Returns one compact line per story, best matches first; then call read_user_story on the one you need. Leave query empty to list the most recent stories.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Keywords or a story id (US-012). Matches titles first, then descriptions.",
          },
          status: {
            type: "string",
            enum: [...statuses, "any"],
            description: "Only stories in this column. Default: any.",
          },
          limit: { type: "number", minimum: 1, maximum: 20 },
        },
        additionalProperties: false,
      },
      retryable: true,
      timeoutMs: 15_000,
      execute: async (input: unknown) => {
        const request = searchInput(input);
        try {
          const stories = (await summaries()).filter(
            (story) => story.id !== options.storyId,
          );
          return formatStorySearch(stories, request);
        } catch (error) {
          return `Story history is unavailable: ${errorText(error)}`;
        }
      },
    },
    {
      name: "read_user_story",
      description:
        "Load what happened in one earlier user story: the original request, the agent's outcome summary and the files it changed. Ask only for the sections you need: request, outcome, files (default), discussion (comments and change requests), activity (the agent's step-by-step tool trail). Accepts US-012, 12 or the story id.",
      inputSchema: {
        type: "object",
        properties: {
          story: {
            type: "string",
            description: "Story reference: US-012, 12 or its id.",
          },
          include: {
            type: "array",
            items: { type: "string", enum: sections },
            description:
              "Sections to return. Default: request, outcome, files.",
          },
        },
        required: ["story"],
        additionalProperties: false,
      },
      retryable: true,
      timeoutMs: 20_000,
      execute: async (input: unknown) => {
        const request = readInput(input);
        if (!request)
          return "Give a story reference such as US-012. Use search_user_stories to find one.";
        try {
          const target = findStory(await summaries(), request.story);
          if (!target)
            return `No story matches "${request.story}" in this project. Use search_user_stories to find it.`;
          const story = (await detail(target.id)) ?? target;
          const files = request.include.includes("files")
            ? await changedFiles(story, options.git)
            : undefined;
          return formatStoryDigest(story, request.include, files);
        } catch (error) {
          return `Story history is unavailable: ${errorText(error)}`;
        }
      },
    },
  ];
}

export function storyDisplayId(story: Pick<StoryRecord, "storyNumber">) {
  return `US-${String(story.storyNumber).padStart(3, "0")}`;
}

export function parseStoryReference(value: string) {
  const text = value.trim();
  const number = /^(?:us[-_\s]?|#)?0*(\d{1,6})$/iu.exec(text);
  return number ? { storyNumber: Number(number[1]) } : { id: text };
}

export function findStory(stories: StoryRecord[], reference: string) {
  const parsed = parseStoryReference(reference);
  return "storyNumber" in parsed
    ? stories.find((story) => story.storyNumber === parsed.storyNumber)
    : stories.find((story) => story.id === parsed.id);
}

export function rankStories(
  stories: StoryRecord[],
  query: string | undefined,
): StoryRecord[] {
  const newest = [...stories].sort(
    (left, right) => right.storyNumber - left.storyNumber,
  );
  if (!query?.trim()) return newest;
  const reference = findStory(stories, query);
  const terms = searchTerms(query);
  const scored = newest
    .map((story) => ({ story, score: storyScore(story, terms) }))
    .filter(({ story, score }) => score > 0 && story !== reference)
    .sort((left, right) => right.score - left.score);
  return [
    ...(reference ? [reference] : []),
    ...scored.map(({ story }) => story),
  ];
}

export function formatStorySearch(
  stories: StoryRecord[],
  request: { limit: number; query?: string; status?: string },
) {
  const pool =
    request.status && request.status !== "any"
      ? stories.filter((story) => story.status === request.status)
      : stories;
  if (!pool.length) return "This project has no other user stories yet.";
  const ranked = rankStories(pool, request.query);
  const shown = ranked.slice(0, request.limit);
  if (!shown.length)
    return `No story matches "${request.query}" among ${pool.length}. Try other keywords or leave query empty for the latest stories.`;
  const heading = request.query?.trim()
    ? `${shown.length} of ${ranked.length} matching stories for "${request.query.trim()}" (${pool.length} searched):`
    : `${shown.length} most recent of ${pool.length} stories:`;
  return [
    heading,
    ...shown.map(storyLine),
    "Next: read_user_story with an id above for its request, outcome and changed files.",
  ].join("\n");
}

export function formatStoryDigest(
  story: StoryRecord,
  include: StorySection[] = defaultSections,
  files?: string,
) {
  const lines = [
    `# ${storyDisplayId(story)} · ${story.title}`,
    storyFacts(story),
  ];
  if (include.includes("request"))
    lines.push("", "## Request", clip(story.summary, 2_400) || "(empty)");
  if (include.includes("outcome")) lines.push("", "## Outcome", outcome(story));
  if (include.includes("files"))
    lines.push("", "## Changed files", files ?? filesHint(story));
  if (include.includes("discussion"))
    lines.push("", "## Discussion", discussion(story));
  if (include.includes("activity"))
    lines.push("", "## Agent activity", activityTrail(story));
  const left = sections.filter((section) => !include.includes(section));
  if (left.length)
    lines.push("", `More: read_user_story include=[${left.join(", ")}]`);
  return lines.join("\n");
}

async function changedFiles(
  story: StoryRecord,
  git: StoryHistoryOptions["git"],
) {
  if (!git || !story.mergeCommit) return undefined;
  const range = story.baseCommit
    ? `${story.baseCommit}..${story.mergeCommit}`
    : `${story.mergeCommit}^..${story.mergeCommit}`;
  try {
    const output = await git(["diff", "--name-status", "--no-renames", range]);
    const files = output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.replace(/\s+/u, " "));
    if (!files.length) return "No file changes recorded.";
    const shown = files.slice(0, 60);
    return [
      ...shown,
      ...(files.length > shown.length
        ? [`… ${files.length - shown.length} more (git diff --stat ${range})`]
        : []),
      `Full diff: git diff ${range} -- <path>`,
    ].join("\n");
  } catch {
    return undefined;
  }
}

function filesHint(story: StoryRecord) {
  if (story.mergeCommit)
    return `Merged as ${story.mergeCommit.slice(0, 12)}. Inspect with: git show --stat ${story.mergeCommit}`;
  if (story.branch) return `Not merged. Work lives on branch ${story.branch}.`;
  return "No code was merged for this story.";
}

function storyLine(story: StoryRecord) {
  const facts = [
    story.status,
    story.mergedAt ? `merged ${story.mergedAt.slice(0, 10)}` : undefined,
    story.priority && story.priority !== "Medium"
      ? `${story.priority.toLowerCase()} priority`
      : undefined,
  ].filter(Boolean);
  const gist = oneLine(story.summary, 140);
  return `${storyDisplayId(story)} · ${facts.join(" · ")} · "${oneLine(story.title, 90)}"${gist ? ` — ${gist}` : ""}`;
}

function storyFacts(story: StoryRecord) {
  return [
    `Status: ${story.status}`,
    story.priority ? `Priority: ${story.priority}` : undefined,
    story.branch ? `Branch: ${story.branch}` : undefined,
    story.mergeCommit
      ? `Merged: ${story.mergedAt?.slice(0, 10) ?? "yes"} (${story.mergeCommit.slice(0, 12)})`
      : undefined,
    story.discardedReason
      ? `Discarded: ${oneLine(story.discardedReason, 160)}`
      : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

function outcome(story: StoryRecord) {
  const summary = story.agentSessionSummary?.trim();
  const final = story.agentFinalResponse?.trim();
  if (!summary && !final) return "No agent outcome recorded yet.";
  if (summary && final && !summary.includes(final.slice(0, 80)))
    return `${clip(summary, 2_000)}\n\nFinal reply:\n${clip(final, 1_200)}`;
  return clip(summary ?? final ?? "", 2_400);
}

function discussion(story: StoryRecord) {
  const comments = (story.comments ?? [])
    .map((comment) => ({
      at: stringField(comment, "createdAt"),
      author: stringField(comment, "author") ?? "user",
      body: stringField(comment, "body") ?? "",
      id: stringField(comment, "id"),
    }))
    .filter((comment) => comment.body.trim());
  if (!comments.length) return "No comments or change requests.";
  const runs = story.agentRuns ?? [];
  const shown = comments.slice(-10);
  return [
    ...(comments.length > shown.length
      ? [`(${comments.length - shown.length} older comments omitted)`]
      : []),
    ...shown.map((comment) => {
      const run = runs.find((item) => item.commentId === comment.id);
      const reply = run ? stringField(run, "finalResponse") : undefined;
      return [
        `- ${comment.author}${comment.at ? ` (${comment.at.slice(0, 10)})` : ""}: ${clip(comment.body, 500)}`,
        ...(run
          ? [
              `  → agent ${stringField(run, "status") ?? "run"}${reply ? `: ${oneLine(reply, 400)}` : ""}`,
            ]
          : []),
      ].join("\n");
    }),
  ].join("\n");
}

function activityTrail(story: StoryRecord) {
  const steps: string[] = [];
  for (const activity of story.agentActivities ?? []) {
    if (activity.kind !== "tool" && activity.kind !== "error") continue;
    const title = oneLine(stringField(activity, "title") ?? "", 120);
    if (!title || steps.at(-1) === title) continue;
    steps.push(activity.kind === "error" ? `error: ${title}` : title);
  }
  if (!steps.length) return "No tool activity recorded.";
  const shown = steps.slice(-40);
  return [
    ...(steps.length > shown.length
      ? [`(${steps.length - shown.length} earlier steps omitted)`]
      : []),
    ...shown.map((step, index) => `${index + 1}. ${step}`),
  ].join("\n");
}

function searchTerms(query: string) {
  return Array.from(
    new Set(
      normalized(query)
        .split(/[^\p{L}\p{N}]+/u)
        .filter((term) => term.length > 1 && !stopWords.has(term)),
    ),
  );
}

function storyScore(story: StoryRecord, terms: string[]) {
  if (!terms.length) return 0;
  const title = normalized(story.title);
  const summary = normalized(story.summary);
  let score = 0;
  for (const term of terms) {
    if (wordMatch(title, term)) score += 4;
    else if (title.includes(term)) score += 2;
    if (wordMatch(summary, term)) score += 1.5;
    else if (summary.includes(term)) score += 0.5;
  }
  // Prefer stories that match every word over long lists of partial hits.
  const matched = terms.filter(
    (term) => title.includes(term) || summary.includes(term),
  ).length;
  return matched ? score * (matched / terms.length) : 0;
}

function wordMatch(text: string, term: string) {
  return new RegExp(
    `(?:^|[^\\p{L}\\p{N}])${escapeRegExp(term)}(?:$|[^\\p{L}\\p{N}])`,
    "u",
  ).test(text);
}

function normalized(value: string) {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function searchInput(value: unknown) {
  const input = recordValue(value);
  const limit = Number(input.limit);
  const status = typeof input.status === "string" ? input.status : undefined;
  return {
    limit: Number.isFinite(limit)
      ? Math.min(20, Math.max(1, Math.round(limit)))
      : 8,
    query: typeof input.query === "string" ? input.query : undefined,
    status,
  };
}

function readInput(value: unknown) {
  const input = recordValue(value);
  const story = typeof input.story === "string" ? input.story.trim() : "";
  if (!story) return undefined;
  const requested = Array.isArray(input.include)
    ? input.include.filter((item): item is StorySection =>
        sections.includes(item as StorySection),
      )
    : [];
  return { include: requested.length ? requested : defaultSections, story };
}

function storyRecords(value: unknown): StoryRecord[] {
  return Array.isArray(value)
    ? value
        .map(storyRecord)
        .filter((story): story is StoryRecord => Boolean(story))
    : [];
}

function storyRecord(value: unknown): StoryRecord | undefined {
  const record = recordValue(value);
  const id = stringField(record, "id");
  const storyNumber = Number(record.storyNumber);
  if (!id || !Number.isFinite(storyNumber)) return undefined;
  return {
    ...(record as Partial<StoryRecord>),
    id,
    status: stringField(record, "status") ?? "backlog",
    storyNumber,
    summary: stringField(record, "summary") ?? "",
    title: stringField(record, "title") ?? "Untitled",
  };
}

function clip(value: string | null | undefined, limit: number) {
  const text = value?.trim() ?? "";
  if (text.length <= limit) return text;
  const head = text.slice(0, Math.floor(limit * 0.7));
  const tail = text.slice(-Math.floor(limit * 0.2));
  return `${head}\n… [${text.length - head.length - tail.length} characters omitted] …\n${tail}`;
}

function oneLine(value: string | null | undefined, limit: number) {
  const text = (value ?? "")
    .replace(/[#*`>_]+/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

function stringField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

const stopWords = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "when",
  "les",
  "des",
  "une",
  "pour",
  "avec",
  "dans",
  "sur",
  "qui",
  "que",
  "est",
  "aux",
  "du",
  "de",
  "la",
  "le",
  "un",
  "et",
  "en",
  "to",
  "of",
  "in",
  "on",
  "a",
  "an",
  "is",
  "it",
  "be",
]);

/** The history tools for an agent session, when it belongs to a project. */
export function sessionStoryHistoryTools(
  input: {
    apiConnection: ApiConnection;
    clineDefaultTools?: boolean;
    projectId?: string;
    storyId?: string;
    workspaceRoot: string;
  },
  git?: (cwd: string, args: string[]) => Promise<string>,
) {
  if (input.clineDefaultTools || !input.projectId) return [];
  return storyHistoryTools({
    apiConnection: input.apiConnection,
    projectId: input.projectId,
    storyId: input.storyId,
    ...(git ? { git: (args: string[]) => git(input.workspaceRoot, args) } : {}),
  });
}
