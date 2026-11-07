import assert from "node:assert/strict";
import test from "node:test";

import { buildDevelopmentSystemPrompt } from "./cline-runtime-prompts.js";
import { lightCompletionDescription } from "./harness/light-completion.js";
import { finishSummaryLimit } from "./harness/light-contracts.js";
import {
  defaultPersonalization,
  normalizePersonalization,
  personalizationUpdateNote,
  responseStyleBlock,
  type AgentPersonalization,
} from "./personalization.js";
import { loadPrompt } from "./prompt-loader.js";
import type { StartDevelopmentSessionInput } from "./types.js";

const todaysFinishDescription =
  "Finish with the final reply the user reads. For a question, conversation, analysis or review, the summary is the answer itself, in the user's language, not a note that no change was needed. For code work, give a concise factual summary. Use run_task reporting or read_code @checks for test counts: null is unknown, pending is distinct from skipped, and unreported categories must not become zero. Separate commands run, passing tests, admitted verification and user criteria. Mention a non-obvious durable implementation decision only when it helps future work. The runtime checks known changes, reuses current checks, and refreshes relevant checks already requested in this session. Work without a current check is reported as unverified. Do not provide receipts or internal state. When the work changed something visible, attach the most useful screenshots you took in this run in images (before/after, each state that was asked for, light and dark when relevant), each with a one-line caption saying what it shows; refer to them as screenshot:<id>, exactly as the screenshot result named them. Do not attach screenshots that show nothing new.";

const base: StartDevelopmentSessionInput = {
  apiConnection: { token: "token", url: "https://example.com" },
  cwd: process.cwd(),
  modelId: "model",
  providerId: "provider",
  summary: "Summary",
  title: "Title",
  workspaceRoot: process.cwd(),
};

function personalized(
  changes: Partial<AgentPersonalization>,
): AgentPersonalization {
  return { ...defaultPersonalization, ...changes };
}

test("the default settings leave the system prompts and finish_task exactly as they were", async () => {
  for (const purpose of ["development", "plan"] as const) {
    const withoutSettings = await buildDevelopmentSystemPrompt({
      ...base,
      purpose,
    });
    const withDefaults = await buildDevelopmentSystemPrompt({
      ...base,
      personalization: { ...defaultPersonalization },
      purpose,
    });
    assert.equal(withDefaults, withoutSettings);
    assert.doesNotMatch(withDefaults, /Personalization|\{\{/);
  }
  const development = await buildDevelopmentSystemPrompt(base);
  assert.match(development, /write a concise factual Markdown summary\./);
  assert.equal(lightCompletionDescription(), todaysFinishDescription);
  assert.equal(
    lightCompletionDescription(defaultPersonalization.responseStyle),
    todaysFinishDescription,
  );
});

test("keeps the new project prompt free of personalization", async () => {
  const plain = await buildDevelopmentSystemPrompt({
    ...base,
    purpose: "new-project",
  });
  const custom = await buildDevelopmentSystemPrompt({
    ...base,
    personalization: personalized({ ambition: "ambitious", experience: "new" }),
    purpose: "new-project",
  });
  assert.equal(custom, plain);
});

for (const purpose of ["development", "plan"] as const) {
  test(`adds the work style blocks to the ${purpose} system prompt`, async () => {
    const cases = [
      [{ experience: "new" }, "experience-new"],
      [{ experience: "experienced" }, "experience-experienced"],
      [{ autonomy: "ask" }, "autonomy-ask"],
      [{ autonomy: "decide" }, "autonomy-decide"],
      [{ ambition: "quick" }, "ambition-quick"],
      [{ ambition: "ambitious" }, "ambition-ambitious"],
    ] as const;
    const withoutSettings = await buildDevelopmentSystemPrompt({
      ...base,
      purpose,
    });
    for (const [changes, block] of cases) {
      const prompt = await buildDevelopmentSystemPrompt({
        ...base,
        personalization: personalized(changes),
        purpose,
      });
      assert.equal(
        prompt,
        `${withoutSettings}\n\n## Personalization\n\n${loadPrompt(`personalization/${block}`)}`,
      );
    }
  });
}

test("combines the blocks in a fixed order, after the efficiency guidance", async () => {
  const prompt = await buildDevelopmentSystemPrompt({
    ...base,
    personalization: personalized({
      ambition: "ambitious",
      autonomy: "decide",
      experience: "new",
    }),
  });
  const positions = [
    "Apply the Pareto principle",
    "## Personalization",
    loadPrompt("personalization/experience-new"),
    loadPrompt("personalization/autonomy-decide"),
    loadPrompt("personalization/ambition-ambitious"),
  ].map((text) => prompt.indexOf(text));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
});

test("response style never enters the system prompt, and replaces its call for a concise reply", async () => {
  for (const responseStyle of ["concise", "detailed"] as const) {
    const prompt = await buildDevelopmentSystemPrompt({
      ...base,
      personalization: personalized({ responseStyle }),
    });
    assert.doesNotMatch(prompt, /Personalization|Final reply style/);
    assert.match(prompt, /write a factual Markdown summary\./);
    assert.doesNotMatch(prompt, /concise factual/);
  }
});

test("response style goes in the finish_task description", () => {
  const concise = lightCompletionDescription("concise");
  const detailed = lightCompletionDescription("detailed");
  assert.ok(concise.endsWith(responseStyleBlock("concise")));
  assert.ok(detailed.endsWith(responseStyleBlock("detailed")));
  for (const description of [concise, detailed]) {
    assert.match(description, /give a factual summary\./);
    assert.doesNotMatch(description, /concise factual/);
  }
  assert.match(
    detailed,
    /limit of the summary/,
    "Detailed names the limit it stays under",
  );
  assert.ok(finishSummaryLimit >= 100_000);
  assert.equal(responseStyleBlock("balanced"), "");
});

test("response style covers the final reply only", () => {
  for (const style of ["concise", "detailed"] as const) {
    assert.match(
      responseStyleBlock(style),
      /stories you propose or the comments you write in code/,
    );
  }
});

test("the ambitious block outranks the efficiency guidance and keeps the simplicity rule", () => {
  const ambitious = loadPrompt("personalization/ambition-ambitious");
  assert.match(ambitious, /takes precedence over the efficiency guidance above/);
  assert.match(ambitious, /propose out-of-scope ideas instead of doing them/);
  assert.match(ambitious, /what you explored, which alternatives you rejected and why, and what risks remain/);
  assert.match(ambitious, /no speculative abstractions, options, generalizations or defensive layers/);
  assert.match(ambitious, /tests to write and the checks to run stay those/);
  const quick = loadPrompt("personalization/ambition-quick");
  assert.match(quick, /no speculative abstractions, options, generalizations or defensive layers/);
  assert.match(quick, /Keep every check the task requires/);
  assert.match(quick, /point out the shortcuts you took/);
});

test("experience sets vocabulary, trust in technical claims and literalness", () => {
  const beginner = loadPrompt("personalization/experience-new");
  assert.match(beginner, /Vocabulary: use plain words/);
  assert.match(beginner, /leads to check, not as facts/);
  assert.match(beginner, /frontend/);
  assert.match(beginner, /intent|trying to achieve/);
  assert.match(beginner, /flag every discrepancy/);
  const expert = loadPrompt("personalization/experience-experienced");
  assert.match(expert, /without explaining them/);
  assert.match(expert, /Follow their technical indications directly/);
  assert.match(expert, /literally/);
  assert.match(expert, /flag every discrepancy/);
});

test("normalizes unknown or missing values to the default", () => {
  assert.deepEqual(normalizePersonalization(undefined), defaultPersonalization);
  assert.deepEqual(normalizePersonalization(null), defaultPersonalization);
  assert.deepEqual(
    normalizePersonalization({ ambition: "reckless", autonomy: "decide" }),
    personalized({ autonomy: "decide" }),
  );
});

test("a change reaches the next message as a note, and nothing else does", () => {
  assert.equal(
    personalizationUpdateNote(defaultPersonalization, defaultPersonalization),
    "",
  );
  const same = personalized({ ambition: "quick" });
  assert.equal(personalizationUpdateNote(same, { ...same }), "");

  const note = personalizationUpdateNote(
    defaultPersonalization,
    personalized({ ambition: "ambitious", responseStyle: "concise" }),
  );
  assert.ok(note.includes(loadPrompt("personalization/ambition-ambitious")));
  assert.ok(note.includes(responseStyleBlock("concise")));
  assert.doesNotMatch(note, /\{\{/);

  const reset = personalizationUpdateNote(
    personalized({ ambition: "ambitious" }),
    defaultPersonalization,
  );
  assert.match(reset, /every setting is back to its default/);
  assert.ok(!reset.includes(loadPrompt("personalization/ambition-ambitious")));
});
