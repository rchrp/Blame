import assert from "node:assert/strict";
import test from "node:test";

import type { ClineCore } from "@cline/sdk";

import {
  planningPrompt,
  planReply,
  planUserStories,
  storyPlanningToolPolicies,
} from "./story-planning.js";
import type { PlanUserStoriesInput } from "./types.js";

const baseInput: PlanUserStoriesInput = {
  apiConnection: { url: "https://api.test" },
  providerId: "anthropic",
  modelId: "model",
  cwd: "/repo",
  workspaceRoot: "/repo",
  projectId: "project",
  messages: [{ role: "user", text: "Let people export invoices" }],
};

test("cleans the agent's proposal: keys, priorities and real dependencies", () => {
  const reply = planReply({
    message: "  I suggest two stories.  ",
    stories: [
      {
        key: "p1",
        title: "Add export  button",
        summary: "A",
        priority: "high",
        dependsOn: ["us-12", "P9"],
      },
      {
        key: "P1",
        title: "Send export by email",
        summary: "B",
        priority: "urgent",
        dependsOn: ["p1", "P2"],
      },
      { key: "P3", title: "", summary: "dropped" },
    ],
    notes: "Invoices live in src/billing.",
  });
  assert.equal(reply.message, "I suggest two stories.");
  assert.deepEqual(
    reply.stories.map(({ key, title, priority, dependsOn }) => ({
      key,
      title,
      priority,
      dependsOn,
    })),
    [
      {
        key: "P1",
        title: "Add export button",
        priority: "High",
        dependsOn: ["US-012"],
      },
      {
        key: "P2",
        title: "Send export by email",
        priority: "Medium",
        dependsOn: ["P1"],
      },
    ],
  );
  assert.equal(reply.notes, "Invoices live in src/billing.");
});

test("the prompt carries the dialogue, the latest proposal in full and the notes", () => {
  const prompt = planningPrompt(
    {
      ...baseInput,
      notes: "Uses Prisma.",
      messages: [
        { role: "user", text: "Export invoices" },
        {
          role: "assistant",
          text: "Two stories.",
          stories: [
            {
              key: "P1",
              title: "CSV export",
              summary: "## Acceptance criteria\n- [ ] CSV",
              priority: "High",
              dependsOn: [],
              addedAs: "US-014",
            },
            {
              key: "P2",
              title: "PDF export",
              summary: "## Acceptance criteria\n- [ ] PDF",
              priority: "Low",
              dependsOn: ["P1"],
            },
          ],
        },
        { role: "user", text: "Make the PDF one high priority" },
      ],
    },
    'US-013 · ready · "Billing page"',
  );
  assert.match(prompt, /<open_backlog>[\s\S]*US-013 · ready/u);
  assert.match(prompt, /<your_notes>\nUses Prisma\.\n<\/your_notes>/u);
  assert.match(
    prompt,
    /\[P1\] CSV export \(High\) → added to the backlog as US-014/u,
  );
  assert.doesNotMatch(prompt, /- \[ \] CSV/u);
  assert.match(
    prompt,
    /\[P2\] PDF export \(Low after P1\)\n {4}## Acceptance criteria\n {4}- \[ \] PDF/u,
  );
  assert.match(
    prompt,
    /<latest_message>\nMake the PDF one high priority\n<\/latest_message>/u,
  );
});

test("the planner reads code and history but cannot edit or run anything", () => {
  const policies = storyPlanningToolPolicies() as Record<
    string,
    { enabled?: boolean }
  >;
  assert.equal(policies.read_files?.enabled, true);
  assert.equal(policies.search_codebase?.enabled, true);
  assert.equal(policies.search_user_stories?.enabled, true);
  assert.equal(policies.read_user_story?.enabled, true);
  assert.equal(policies.submit_plan_reply?.enabled, true);
  for (const name of [
    "editor",
    "apply_patch",
    "run_commands",
    "edit_code",
    "run_task",
    "ask_question",
  ])
    assert.equal(policies[name]?.enabled, false, name);
});

test("a planning turn returns what the agent submitted", async () => {
  let prompt = "";
  const cline = {
    async start(request: {
      prompt: string;
      config: {
        sessionId?: string;
        extraTools?: Array<{
          name: string;
          execute(input: unknown, context: unknown): unknown;
        }>;
      };
    }) {
      prompt = request.prompt;
      const submit = request.config.extraTools!.find(
        (tool) => tool.name === "submit_plan_reply",
      )!;
      await submit.execute(
        {
          message: "One story is enough.",
          stories: [
            {
              key: "P1",
              title: "Export CSV",
              summary: "Body",
              priority: "Medium",
              dependsOn: [],
            },
          ],
        },
        {},
      );
      return { sessionId: request.config.sessionId, result: { text: "" } };
    },
  } as unknown as ClineCore;
  const result = await planUserStories(
    baseInput,
    cline,
    { apiKey: "k", baseUrl: null },
    "plan-1",
    {
      listStories: async () => [
        {
          id: "a",
          storyNumber: 3,
          title: "Billing page",
          summary: "",
          status: "in-progress",
        },
        {
          id: "b",
          storyNumber: 2,
          title: "Login",
          summary: "",
          status: "done",
        },
      ],
    },
  );
  assert.equal(result.sessionId, "plan-1");
  assert.equal(result.message, "One story is enough.");
  assert.equal(result.stories[0]?.title, "Export CSV");
  assert.match(prompt, /US-003 · in-progress · "Billing page"/u);
  assert.doesNotMatch(prompt, /US-002/u);
});

test("a planning turn falls back to the agent's text when it forgets to submit", async () => {
  const cline = {
    start: async () => ({
      sessionId: "plan-2",
      result: { text: "Which format do you need?" },
    }),
  } as unknown as ClineCore;
  const result = await planUserStories(
    baseInput,
    cline,
    { apiKey: "k", baseUrl: null },
    "plan-2",
    {
      listStories: async () => [],
    },
  );
  assert.deepEqual(result, {
    sessionId: "plan-2",
    message: "Which format do you need?",
    stories: [],
  });
});
