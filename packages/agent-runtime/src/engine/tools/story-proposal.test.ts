import assert from "node:assert/strict";
import test from "node:test";

import { proposedStories, storyProposalTool } from "./story-proposal.js";
import { toolContext } from "./testing.js";

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
    tool.run({ stories: [] } as never, toolContext()),
  );
  assert.deepEqual(
    await tool.run(
      { stories: [{ key: "P1", title: "A", summary: "B" }] } as never,
      toolContext(),
    ),
    {
      json: {
        shown: 1,
        keys: ["P1"],
        note: "The person reviews these cards and decides what to add.",
      },
    },
  );
});

test("a story names the attached files it needs, each once", () => {
  const stories = proposedStories({
    stories: [
      {
        key: "P1",
        title: "Build the screen",
        summary: "A",
        attachments: [" mockup.png ", "spec.pdf", "mockup.png", "", 3, null],
      },
      { key: "P2", title: "Document it", summary: "B" },
      { key: "P3", title: "Wire it", summary: "C", attachments: "spec.pdf" },
    ],
  });
  assert.deepEqual(
    stories.map((story) => story.attachments),
    [["mockup.png", "spec.pdf"], [], []],
  );
});

test("the proposal schema lets a story list attachments without requiring them", () => {
  const schema = storyProposalTool().inputSchema as {
    properties: {
      stories: {
        items: {
          properties: Record<string, { type: string }>;
          required: string[];
        };
      };
    };
  };
  const { properties, required } = schema.properties.stories.items;
  assert.equal(properties.attachments?.type, "array");
  assert.equal(required.includes("attachments"), false);
});
