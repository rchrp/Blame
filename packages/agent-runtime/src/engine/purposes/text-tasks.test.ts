// The tasks that read no file: their purpose, contract and result.

import assert from "node:assert/strict";
import test from "node:test";
import { titleResult, titleTask } from "./title.js";
import { userStoryMarkdown, userStoryTask } from "./user-story.js";

const model = { providerId: "anthropic", modelId: "claude-sonnet-4-6" };

test("a title is a task whose only tool is submit_title", () => {
  const task = titleTask({
    context: "quick-chat",
    model: { ...model, reasoning: "low" },
    prompt: "  Read the README and summarize it.  ",
    workspace: { root: "/projects/app" },
  });
  const { config } = task;
  assert.equal(config.purpose, "title");
  assert.deepEqual(config.kind, { kind: "task", replicate: false });
  assert.equal(config.workspace_root, "/projects/app");
  assert.deepEqual(config.engine_tools, []);
  assert.deepEqual(config.client_tools, []);
  assert.equal(config.reasoning, "low");
  assert.deepEqual(config.contract?.allowed, [], "no tool but the result");
  assert.equal(config.contract?.result.name, "submit_title");
  assert.ok(config.limits.max_requests_per_turn);
  assert.ok(config.limits.max_turn_ms);
  assert.equal(
    task.instruction,
    "Quick chat request:\nRead the README and summarize it.",
  );
  assert.match(config.system_prompt, /submit_title/);
  assert.doesNotMatch(config.system_prompt, /strict JSON/);
});

test("a story's title also picks one of its run configurations, by the schema", () => {
  const task = titleTask({
    context: "user-story",
    model,
    prompt: "Fix the checkout page",
    runConfigurations: [
      {
        id: "web",
        name: "Web",
        command: "pnpm dev",
        cwd: "apps/web",
        default: true,
        category: "web",
        services: ["web"],
        previewService: "web",
        scopes: ["web"],
      },
    ],
  });
  const result = task.config.contract!.result;
  assert.equal(result.source, "submit");
  if (result.source !== "submit") return;
  assert.deepEqual(result.input_schema, {
    type: "object",
    additionalProperties: false,
    required: ["title", "runConfigurationId"],
    properties: {
      title: { type: "string", minLength: 1, maxLength: 80 },
      runConfigurationId: { anyOf: [{ enum: ["web"] }, { type: "null" }] },
    },
  });
  assert.match(
    task.instruction,
    /Available run configurations:\n\[\{"id":"web"/,
  );
  assert.deepEqual(
    task.result({ title: "Fix checkout", runConfigurationId: "web" }),
    {
      title: "Fix checkout",
      runConfigurationId: "web",
    },
  );
  assert.deepEqual(
    task.result({ title: "Fix checkout", runConfigurationId: null }),
    {
      title: "Fix checkout",
      runConfigurationId: null,
    },
  );
});

test("a title is cleaned to one line of six words, and scaffolding is refused", () => {
  assert.deepEqual(
    titleResult(
      { title: "## Summarize the project README file for me." },
      false,
    ),
    {
      title: "Summarize the project README file for",
    },
  );
  assert.throws(
    () => titleResult({ title: '<invoke name="read">' }, false),
    /did not return a title/,
  );
});

test("a task without files works in a temporary folder when the project is in the VM", () => {
  const task = titleTask({
    context: "quick-chat",
    model,
    prompt: "Hello",
    workspace: { root: "/home/blame/app", inVm: true },
  });
  assert.notEqual(task.config.workspace_root, "/home/blame/app");
  assert.throws(
    () => titleTask({ context: "quick-chat", model, prompt: "  " }),
    /needs a prompt/,
  );
});

test("a rough user story comes back as the Markdown of submit_user_story", () => {
  const task = userStoryTask({
    model,
    prompt: "login broken pls fix",
    title: "Login",
    workspace: { root: "/projects/app" },
  });
  assert.equal(task.config.purpose, "user-story-optimization");
  assert.deepEqual(task.config.contract?.allowed, []);
  assert.equal(task.config.contract?.result.name, "submit_user_story");
  assert.equal(
    task.instruction,
    "Optimize this rough user story prompt.\n\nCurrent title: Login\n\nUser prompt:\nlogin broken pls fix",
  );
  assert.match(task.config.system_prompt, /submit_user_story/);
  assert.equal(
    userStoryMarkdown({ markdown: "```markdown\n# Fix login\n```" }),
    "# Fix login",
  );
  assert.throws(
    () => userStoryMarkdown({ markdown: "```\n```" }),
    /no Markdown/,
  );
});
