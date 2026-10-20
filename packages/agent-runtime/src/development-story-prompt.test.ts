import assert from "node:assert/strict";
import test from "node:test";

import { developmentUserInput } from "./cline-runtime-prompts.js";

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
