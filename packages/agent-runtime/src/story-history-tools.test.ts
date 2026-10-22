import assert from "node:assert/strict";
import test from "node:test";

import {
  formatStoryDigest,
  parseStoryReference,
  rankStories,
  storyHistoryTools,
  type StoryRecord,
} from "./story-history-tools.js";

const stories: StoryRecord[] = [
  story(1, "Add GitHub OAuth login", "Users sign in with GitHub.", "done", {
    baseCommit: "base111",
    mergeCommit: "merge111",
    mergedAt: "2026-10-01T10:00:00Z",
  }),
  story(2, "Dark mode toggle", "Add a theme switch in settings.", "done"),
  story(
    3,
    "Fix login redirect loop",
    "After OAuth the app loops.",
    "in-review",
  ),
  story(4, "Export invoices as CSV", "Download invoices.", "backlog"),
];

test("reads story references in the forms people and agents use", () => {
  assert.deepEqual(parseStoryReference("US-012"), { storyNumber: 12 });
  assert.deepEqual(parseStoryReference("us 7"), { storyNumber: 7 });
  assert.deepEqual(parseStoryReference("#3"), { storyNumber: 3 });
  assert.deepEqual(parseStoryReference("42"), { storyNumber: 42 });
  assert.deepEqual(parseStoryReference("0b7c-uuid"), { id: "0b7c-uuid" });
});

test("ranks title matches above description matches, ignoring accents", () => {
  const ranked = rankStories(stories, "login OAuth");
  assert.deepEqual(
    ranked.map((item) => item.storyNumber),
    [1, 3],
  );
  assert.equal(rankStories(stories, "thème")[0]?.storyNumber, 2);
  assert.equal(rankStories(stories, "US-004")[0]?.storyNumber, 4);
  assert.deepEqual(
    rankStories(stories, undefined).map((item) => item.storyNumber),
    [4, 3, 2, 1],
  );
});

test("search returns one compact line per story and skips the current story", async () => {
  const [search] = storyHistoryTools({
    apiConnection: { url: "https://api.test" },
    projectId: "project",
    storyId: "story-3",
    listStories: async () => stories,
  });
  const output = String(await search!.execute({ query: "login" }, {} as never));
  assert.match(
    output,
    /US-001 · done · merged 2026-10-01 · "Add GitHub OAuth login"/u,
  );
  assert.doesNotMatch(output, /US-003/u);
  assert.match(output, /read_user_story/u);
  const filtered = String(
    await search!.execute({ status: "backlog" }, {} as never),
  );
  assert.match(filtered, /US-004/u);
  assert.doesNotMatch(filtered, /US-001/u);
});

test("reading a story loads its digest once and lists changed files from Git", async () => {
  let listCalls = 0;
  let detailCalls = 0;
  const gitCalls: string[][] = [];
  const [, read] = storyHistoryTools({
    apiConnection: { url: "https://api.test" },
    projectId: "project",
    listStories: async () => {
      listCalls += 1;
      return stories;
    },
    getStory: async (id) => {
      detailCalls += 1;
      return {
        ...stories.find((item) => item.id === id),
        agentSessionSummary: "Added a GitHub provider and a callback route.",
        comments: [
          {
            id: "c1",
            author: "Ana",
            body: "Use the org app",
            createdAt: "2026-10-01",
          },
        ],
        agentRuns: [
          {
            commentId: "c1",
            status: "completed",
            finalResponse: "Switched app.",
          },
        ],
        agentActivities: [
          { kind: "tool", title: "Read src/auth.ts" },
          { kind: "tool", title: "Read src/auth.ts" },
          { kind: "tool", title: "Edit src/auth.ts" },
        ],
      };
    },
    git: async (args) => {
      gitCalls.push(args);
      return "M\tsrc/auth.ts\nA\tsrc/routes/callback.ts\n";
    },
  });
  const first = String(await read!.execute({ story: "US-001" }, {} as never));
  assert.match(first, /# US-001 · Add GitHub OAuth login/u);
  assert.match(first, /## Outcome\nAdded a GitHub provider/u);
  assert.match(first, /M src\/auth.ts\nA src\/routes\/callback.ts/u);
  assert.match(
    first,
    /More: read_user_story include=\[discussion, activity\]/u,
  );
  assert.deepEqual(gitCalls[0], [
    "diff",
    "--name-status",
    "--no-renames",
    "base111..merge111",
  ]);

  const second = String(
    await read!.execute(
      { story: "1", include: ["discussion", "activity"] },
      {} as never,
    ),
  );
  assert.match(
    second,
    /Ana \(2026-10-01\): Use the org app\n {2}→ agent completed: Switched app\./u,
  );
  assert.match(second, /1\. Read src\/auth.ts\n2\. Edit src\/auth.ts/u);
  assert.doesNotMatch(second, /## Request/u);
  assert.equal(listCalls, 1);
  assert.equal(detailCalls, 1);

  const missing = String(await read!.execute({ story: "US-099" }, {} as never));
  assert.match(missing, /No story matches "US-099"/u);
});

test("long sections are clipped with a visible marker", () => {
  const long = { ...stories[3]!, summary: "x".repeat(10_000) };
  const digest = formatStoryDigest(long, ["request"]);
  assert.ok(digest.length < 3_000);
  assert.match(digest, /characters omitted/u);
});

function story(
  storyNumber: number,
  title: string,
  summary: string,
  status: string,
  extra: Partial<StoryRecord> = {},
): StoryRecord {
  return {
    id: `story-${storyNumber}`,
    storyNumber,
    title,
    summary,
    status,
    ...extra,
  };
}
