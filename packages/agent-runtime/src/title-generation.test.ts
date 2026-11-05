import assert from "node:assert/strict";
import test from "node:test";

import { generatedTitle } from "./title-generation.js";

const configurations = [
  {
    id: "customer-app",
    name: "Customer app",
    command: "pnpm dev",
    cwd: "apps/customer",
    default: true,
    category: "web" as const,
    services: ["customer"],
    previewService: "customer",
    scopes: ["customer", "backend"],
  },
];

test("parses a title and selected run configuration", () => {
  assert.deepEqual(
    generatedTitle(
      JSON.stringify({
        title: "Improve customer billing flow",
        runConfigurationId: "customer-app",
      }),
      { runConfigurations: configurations },
    ),
    {
      title: "Improve customer billing flow",
      runConfigurationId: "customer-app",
    },
  );
});

test("drops unknown run configuration selections", () => {
  assert.deepEqual(
    generatedTitle(
      JSON.stringify({ title: "Improve API", runConfigurationId: "unknown" }),
      { runConfigurations: configurations },
    ),
    { title: "Improve API", runConfigurationId: null },
  );
});

test("preserves an explicit no-preview decision", () => {
  assert.deepEqual(
    generatedTitle(
      JSON.stringify({
        title: "Update documentation",
        runConfigurationId: null,
      }),
      { runConfigurations: configurations },
    ),
    { title: "Update documentation", runConfigurationId: null },
  );
});

test("keeps legacy plain title responses compatible", () => {
  assert.deepEqual(generatedTitle("Improve the customer dashboard"), {
    title: "Improve the customer dashboard",
  });
});

test("rejects tool-call markup and other scaffolding instead of a title", () => {
  const toolCall = [
    "",
    '<invoke name="mcp__blame__read_code">',
    '<parameter name="path">README.md</parameter>',
    "</invoke>",
    "══════ Tool error ══════",
    "Error: Unknown tool: mcp__blame__read_code",
  ].join("\n");
  assert.equal(generatedTitle(toolCall), undefined);
  assert.equal(
    generatedTitle(JSON.stringify({ title: "<function_calls>" })),
    undefined,
  );
  assert.equal(generatedTitle('{"title": "Read the README'), undefined);
  assert.equal(generatedTitle("[tool call t1: read_code] {}"), undefined);
  assert.equal(generatedTitle("  \n "), undefined);
});
