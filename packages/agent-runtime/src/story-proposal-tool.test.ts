import assert from "node:assert/strict";
import test from "node:test";

import {
  conversationSessionOptions,
  conversationWorkspace,
} from "./conversation-purpose.js";
import { proposedStories, storyProposalTool } from "./story-proposal-tool.js";
import type { StartDevelopmentSessionInput } from "./types.js";

const session: StartDevelopmentSessionInput = {
  apiConnection: { url: "https://api.test" },
  providerId: "anthropic",
  modelId: "model",
  cwd: "/repo",
  workspaceRoot: "/repo",
  projectId: "project",
  title: "Plan Mode",
  summary: "Let people export invoices",
};

test("cleans the agent's proposal: keys, priorities and real dependencies", () => {
  const stories = proposedStories({
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
  });
  assert.deepEqual(
    stories.map(({ key, title, priority, dependsOn }) => ({
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
});

test("the proposal tool refuses an empty proposal", async () => {
  const tool = storyProposalTool();
  await assert.rejects(async () =>
    tool.execute({ stories: [] }, {} as never),
  );
  assert.deepEqual(
    await tool.execute(
      { stories: [{ key: "P1", title: "A", summary: "B" }] },
      {} as never,
    ),
    {
      shown: 1,
      keys: ["P1"],
      note: "The person reviews these cards and decides what to add.",
    },
  );
});

test("chats and stories of a project can propose stories and keep every tool", () => {
  const options = conversationSessionOptions(session);
  assert.deepEqual(
    options.conversationTools.map((tool) => tool.name),
    ["propose_user_stories"],
  );
  assert.equal(options.toolFilter, undefined);
  assert.deepEqual(
    conversationSessionOptions({ ...session, projectId: undefined })
      .conversationTools,
    [],
  );
});

test("plan mode reads code, history, the web and the computer but never edits", () => {
  const options = conversationSessionOptions({ ...session, purpose: "plan" });
  const keeps = options.toolFilter!;
  for (const name of [
    "read_code",
    "search_code",
    "run_task",
    "search_web",
    "read_web_page",
    "search_user_stories",
    "read_user_story",
    "propose_user_stories",
    "finish_task",
  ])
    assert.equal(keeps(name), true, name);
  assert.equal(keeps("edit_code"), false);
  assert.equal(options.checkpointEnabled, false);
});

test("the new-project assistant works in a scratch folder with web, commands and the stack tool", async () => {
  const input = await conversationWorkspace(
    { ...session, purpose: "new-project", cwd: "/parent", workspaceRoot: "/parent" },
    "conversation/1",
  );
  assert.notEqual(input.cwd, "/parent");
  assert.equal(input.workspaceRoot, input.cwd);
  assert.match(input.cwd, /blame-new-project-assistant/u);
  assert.equal(input.projectId, undefined);
  const options = conversationSessionOptions(input);
  assert.deepEqual(
    options.conversationTools.map((tool) => tool.name),
    ["propose_project_stack"],
  );
  const keeps = options.toolFilter!;
  for (const name of ["search_web", "read_web_page", "run_task", "finish_task"])
    assert.equal(keeps(name), true, name);
  for (const name of [
    "read_user_story",
    "propose_user_stories",
    "edit_code",
    "get_preview_devtools",
    "consult_specialist",
  ])
    assert.equal(keeps(name), false, name);
});
