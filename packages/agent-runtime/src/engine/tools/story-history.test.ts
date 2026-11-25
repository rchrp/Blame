import assert from "node:assert/strict";
import test from "node:test";

import {
  formatStoryDigest,
  parseStoryReference,
  rankStories,
  storyHistoryTools,
  type StoryRecord,
} from "./story-history.js";
import { toolContext } from "./testing.js";

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
  const output = String(
    await search!.run({ query: "login" } as never, toolContext()),
  );
  assert.match(
    output,
    /US-001 · done · merged 2026-10-01 · "Add GitHub OAuth login"/u,
  );
  assert.doesNotMatch(output, /US-003/u);
  assert.match(output, /read_user_story/u);
  const filtered = String(
    await search!.run({ status: "backlog" } as never, toolContext()),
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
  const first = String(
    await read!.run({ story: "US-001" } as never, toolContext()),
  );
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
    await read!.run(
      { story: "1", include: ["discussion", "activity"] } as never,
      toolContext(),
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

  const missing = String(
    await read!.run({ story: "US-099" } as never, toolContext()),
  );
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

// An engine story: its outcome, messages and tool calls live in its session.
test("a story run on the engine reads its outcome, messages and tools from its session", async () => {
  const model = { provider: "anthropic", model: "m" };
  const usage = { input_tokens: 1, output_tokens: 1 };
  let seq = 0;
  const record = (body: Record<string, unknown>) => ({
    seq: ++seq,
    at_ms: seq,
    ...body,
  });
  const turn = (
    id: string,
    message: string,
    tool: { name: string; input: Record<string, unknown> },
    reply: string,
  ) => [
    record({
      type: "user_message",
      turn: id,
      input: [{ type: "text", text: message }],
      delivery: "turn",
    }),
    record({
      type: "request_started",
      turn: id,
      request: `${id}-r1`,
      model,
      attempt: 1,
      prefix_digest: "d",
    }),
    record({
      type: "assistant_message",
      turn: id,
      request: `${id}-r1`,
      stop: "tool_use",
      usage,
      blocks: [
        {
          type: "tool_call",
          call: `${id}-c1`,
          name: tool.name,
          input: tool.input,
        },
      ],
    }),
    record({
      type: "tool_call_started",
      turn: id,
      call: `${id}-c1`,
      name: tool.name,
      effect: "read_only",
    }),
    record({
      type: "tool_call_finished",
      turn: id,
      call: `${id}-c1`,
      outcome: "completed",
      content: [{ type: "text", text: "ok" }],
    }),
    record({
      type: "request_started",
      turn: id,
      request: `${id}-r2`,
      model,
      attempt: 1,
      prefix_digest: "d",
    }),
    record({
      type: "assistant_message",
      turn: id,
      request: `${id}-r2`,
      stop: "end_turn",
      usage,
      blocks: [{ type: "text", text: reply }],
    }),
    record({ type: "turn_ended", turn: id, outcome: { status: "completed" } }),
  ];
  const records = [
    record({
      type: "session_created",
      config: {
        purpose: "development-story",
        workspace_root: "/w",
        model,
        engine_tools: [],
        client_tools: [],
        tool_options: {},
        limits: {},
        checkpoints: false,
      },
    }),
    ...turn(
      "t1",
      "Backlog item: harness",
      { name: "run_task", input: { command: "cargo test" } },
      "First pass done.",
    ),
    ...turn(
      "t2",
      "Any other frictions?",
      { name: "read_code", input: { target: "src/lib.rs" } },
      "Yes: three more, fixed.",
    ),
  ];
  const { readStoryConversation } = await import("./story-conversation.js");
  const conversation = await readStoryConversation(
    {
      readRecords: async ({ after }: { after: number }) => ({
        records: records.filter((item) => item.seq > after),
        head: records.length,
      }),
    } as never,
    "s1",
  );
  const digest = formatStoryDigest(
    { ...stories[0]!, engineSessionId: "s1" },
    ["outcome", "discussion", "activity"],
    undefined,
    conversation,
  );
  assert.match(
    digest,
    /## Outcome\nThe agent's last reply \(turn 2 of 2\):\n\nYes: three more, fixed\./,
  );
  assert.match(
    digest,
    /- You \(turn 2\): Any other frictions\?\n {2}→ agent completed: its reply is the outcome above\./,
  );
  assert.match(
    digest,
    /1\. \[turn 1\] run_task: cargo test\n2\. \[turn 2\] read_code: src\/lib\.rs/,
  );
  assert.doesNotMatch(digest, /No agent outcome recorded/);
});
