import assert from "node:assert/strict";
import test from "node:test";
import type { CoreSessionConfig } from "@cline/sdk";

import { mcpResultRedactionExtension } from "./mcp-result-redaction.js";
import { appendProductionConfig } from "./production.js";

const tokenBody = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0";
const mcpTool = { name: "github__get_issue", resultPolicy: "cache-oversized" };

type AfterTool = (context: {
  tool: { name: string; resultPolicy?: string };
  result: { output: unknown; isError?: boolean };
}) => { result?: { output: unknown; isError?: boolean } } | undefined;

function afterTool(): AfterTool {
  const hook = mcpResultRedactionExtension().hooks?.afterTool;
  assert.ok(hook);
  return hook as unknown as AfterTool;
}

test("masks GitHub tokens in the text and JSON of an MCP result, images untouched", () => {
  // Base64 may hold a token-shaped run after "/" or "+": it must survive.
  const image = { type: "image", data: `iVBORw0KGgo/ghp_${tokenBody}`, mimeType: "image/png" };
  const output = {
    content: [
      { type: "text", text: `CI log: git clone https://x-access-token:ghs_${tokenBody}@github.com/acme/app` },
      { type: "text", text: `{"GITHUB_TOKEN":"opaque-value-0123456789","body":"gho_${tokenBody}"}` },
      image,
      { type: "resource", resource: { uri: "file:///logo.png", mimeType: "image/png", blob: `ghp_${tokenBody}` } },
    ],
    structuredContent: { env: { GH_TOKEN: "short" }, issue: { body: `token github_pat_11ABCDEFG0${tokenBody}` } },
  };
  const redacted = afterTool()({ tool: mcpTool, result: { output, isError: false } })?.result;
  assert.ok(redacted);
  assert.equal(redacted.isError, false);
  assert.deepEqual(redacted.output, {
    content: [
      { type: "text", text: "CI log: git clone https://x-access-token:<REDACTED_SECRET:GITHUB_TOKEN>@github.com/acme/app" },
      { type: "text", text: '{"GITHUB_TOKEN":"<REDACTED_SECRET:GITHUB_TOKEN>","body":"<REDACTED_SECRET:GITHUB_TOKEN>"}' },
      image,
      { type: "resource", resource: { uri: "file:///logo.png", mimeType: "image/png", blob: `ghp_${tokenBody}` } },
    ],
    structuredContent: {
      env: { GH_TOKEN: "<REDACTED_SECRET:GH_TOKEN>" },
      issue: { body: "token <REDACTED_SECRET:GITHUB_TOKEN>" },
    },
  });
  assert.equal((redacted.output as typeof output).content[2], image);
});

test("an MCP result without a secret stays identical", () => {
  const output = {
    content: [
      { type: "text", text: "Issue #12: GH_TOKEN=$(gh auth token) fails on CI" },
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
    ],
    structuredContent: { number: 12, labels: ["bug"], token: null },
  };
  const before = structuredClone(output);
  const redacted = afterTool()({ tool: mcpTool, result: { output } })?.result;
  assert.deepEqual(redacted?.output, before);
  assert.deepEqual(output, before);
});

test("masks preview DevTools results built by createMcpTools, as content arrays", () => {
  const redacted = afterTool()({
    tool: { name: "preview_devtools__evaluate_script", resultPolicy: "cache-oversized" },
    result: { output: [{ type: "text", text: `localStorage: ghp_${tokenBody}` }] },
  })?.result;
  assert.deepEqual(redacted?.output, [{ type: "text", text: "localStorage: <REDACTED_SECRET:GITHUB_TOKEN>" }]);
});

test("leaves the results of Blame's own tools to their own masking", () => {
  assert.equal(
    afterTool()({ tool: { name: "read_code" }, result: { output: `ghp_${tokenBody}` } }),
    undefined,
  );
});

test("every production session config masks MCP results, after the caller's extensions", () => {
  const own = { name: "own", manifest: { capabilities: ["hooks" as const] } };
  const base: CoreSessionConfig = { providerId: "anthropic", modelId: "m", systemPrompt: "" };
  const names = (config: CoreSessionConfig) =>
    config.extensions?.map((extension: { name: string }) => extension.name);
  assert.deepEqual(
    names(appendProductionConfig({ ...base, extensions: [own] }, {})),
    ["own", "blame-mcp-result-redaction"],
  );
  assert.deepEqual(names(appendProductionConfig(base, {})), ["blame-mcp-result-redaction"]);
});
