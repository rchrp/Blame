import assert from "node:assert/strict";
import test from "node:test";
import { defineTool } from "../tool.js";
import { developerEnvFile, envFileRefusal } from "./guards.js";
import { clientToolPolicy } from "./policy.js";
import { callThroughToolSet } from "./testing.js";

const tokenBody = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0";

test("keeps every client tool out of the developer's env files, not the examples", async () => {
  assert.equal(developerEnvFile("/repo/.env"), true);
  assert.equal(developerEnvFile("/repo/apps/api/.env.local"), true);
  assert.equal(developerEnvFile("C:\\repo\\.env.production"), true);
  assert.equal(developerEnvFile("/repo/.env.example"), false);
  assert.equal(developerEnvFile("/repo/src/env.ts"), false);
  assert.match(
    envFileRefusal({
      files: [{ path: "/repo/package.json" }, { path: "/repo/.env" }],
    })!,
    /\/repo\/\.env out of this analysis/,
  );
  assert.match(
    envFileRefusal({ uri: "file:///repo/.env.local" })!,
    /\/repo\/\.env\.local/,
  );
  assert.equal(
    envFileRefusal({ files: [{ path: "/repo/.env.example" }] }),
    undefined,
  );
  assert.equal(envFileRefusal({ query: ".env" }), undefined);

  let ran = 0;
  const reader = defineTool<Record<string, unknown>>({
    name: "fs__read_file",
    description: "",
    inputSchema: {},
    effect: "read_only",
    source: { kind: "mcp", server: "fs", readOnly: true },
    run: () => {
      ran += 1;
      return "SECRET=1";
    },
  });
  const refused = await callThroughToolSet([reader], "fs__read_file", {
    path: "/repo/.env",
  });
  assert.equal(refused.outcome, "failed");
  assert.match(
    JSON.stringify(refused.content),
    /\.env\.example for the expected keys/,
  );
  assert.equal(ran, 0);
});

test("masks what MCP servers answer, images untouched, and leaves Blame's own tools alone", async () => {
  const image = {
    type: "image" as const,
    data: `iVBORw0KGgo/ghp_${tokenBody}`,
    mediaType: "image/png",
  };
  const answer = {
    content: [
      {
        type: "text" as const,
        text: `CI log: git clone https://x-access-token:ghs_${tokenBody}@github.com/acme/app`,
      },
      {
        type: "text" as const,
        text: `{"GITHUB_TOKEN":"opaque-value-0123456789","body":"gho_${tokenBody}"}`,
      },
      image,
    ],
  };
  const tool = (name: string, mcp: boolean) =>
    defineTool<Record<string, unknown>>({
      name,
      description: "",
      inputSchema: {},
      effect: "read_only",
      ...(mcp ? { source: { kind: "mcp" as const, server: "github" } } : {}),
      run: () => structuredClone(answer),
    });
  const masked = await callThroughToolSet(
    [tool("github__get_job_logs", true)],
    "github__get_job_logs",
    {},
  );
  assert.deepEqual(masked.content.slice(0, 2), [
    {
      type: "text",
      text: "CI log: git clone https://x-access-token:<REDACTED_SECRET:GITHUB_TOKEN>@github.com/acme/app",
    },
    {
      type: "text",
      text: '{"GITHUB_TOKEN":"<REDACTED_SECRET:GITHUB_TOKEN>","body":"<REDACTED_SECRET:GITHUB_TOKEN>"}',
    },
  ]);
  // Base64 may hold a token-shaped run: the image reaches the blob store intact.
  assert.deepEqual(masked.blobs, [
    { media_type: "image/png", data: image.data },
  ]);
  const own = await callThroughToolSet(
    [tool("read_user_story", false)],
    "read_user_story",
    {},
  );
  assert.match(JSON.stringify(own.content), /ghs_/);
});

test("the policy gives each tool its effect, from its name or its MCP server", () => {
  const tool = (
    name: string,
    source?: { server: string; readOnly?: boolean },
  ) =>
    clientToolPolicy(
      defineTool({
        name,
        description: "",
        inputSchema: {},
        effect: "workspace_write",
        ...(source ? { source: { kind: "mcp" as const, ...source } } : {}),
        run: () => "",
      }),
    );
  assert.deepEqual(tool("get_preview_devtools"), {
    effect: "read_only",
    needsApproval: false,
  });
  assert.deepEqual(tool("open_component_preview"), {
    effect: "command",
    needsApproval: false,
  });
  assert.deepEqual(tool("preview_environment"), {
    effect: "external",
    needsApproval: false,
  });
  assert.deepEqual(tool("github__get_issue", { server: "github" }), {
    effect: "read_only",
    needsApproval: false,
  });
  assert.deepEqual(
    tool("preview_devtools__click", { server: "preview_devtools" }),
    { effect: "command", needsApproval: false },
  );
  assert.deepEqual(tool("notes__search", { server: "notes", readOnly: true }), {
    effect: "read_only",
    needsApproval: false,
  });
  assert.deepEqual(tool("notes__write", { server: "notes" }), {
    effect: "external",
    needsApproval: false,
  });
  // A tool the table does not know keeps its own.
  assert.deepEqual(tool("something_new"), {
    effect: "workspace_write",
    needsApproval: false,
  });
});
