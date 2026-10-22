import assert from "node:assert/strict";
import test from "node:test";

import {
  developmentUserInput,
  referencedStories,
} from "./cline-runtime-prompts.js";

const storyPrompt = async (title: string) =>
  (await developmentUserInput({ summary: "salut ca va ?", title }, "/tmp"))
    .prompt;

test("names the backlog item when the story has a title", async () => {
  const prompt = await storyPrompt("Say Hello");
  assert.ok(prompt.startsWith("Backlog item: Say Hello\n\nsalut ca va ?"));
});

for (const title of ["Untitled user story", "  "]) {
  test(`starts with the request when the title is ${JSON.stringify(title)}`, async () => {
    const prompt = await storyPrompt(title);
    assert.ok(prompt.startsWith("salut ca va ?"));
    assert.doesNotMatch(prompt, /Backlog item|Untitled user story/);
  });
}

test("points the agent at earlier stories the request names", async () => {
  const prompt = (
    await developmentUserInput(
      {
        projectId: "project",
        summary:
          "Fix the export from US-14.\n\n## Depends on\n- US-014 · Export (to be merged first)\n- US-009",
        title: "Fix export",
      },
      "/tmp",
    )
  ).prompt;
  assert.match(
    prompt,
    /Earlier stories mentioned: US-014, US-009\. read_user_story loads/u,
  );
  const withoutProject = await storyPrompt("Mentions US-014");
  assert.doesNotMatch(withoutProject, /Earlier stories mentioned/u);
  assert.deepEqual(referencedStories("us-7 and US-007, then US-1200"), [
    "US-007",
    "US-1200",
  ]);
});
