import assert from "node:assert/strict";
import test from "node:test";
import { githubClientTools } from "./github.js";
import { callThroughToolSet } from "./testing.js";

// Built at run time so the source holds no token-shaped literal.
const leakedToken = `ghp_${"A1b2".repeat(9)}`;

test("a session without read-only GitHub access gets no GitHub tool", async () => {
  assert.deepEqual(await githubClientTools({}, "session-write"), []);
  let calls = 0;
  const tools = await githubClientTools(
    {
      // What the desktop answers for a read and write (or off) session.
      githubMcpTools: async () => [],
      githubMcpCall: async () => {
        calls += 1;
        return {};
      },
    },
    "session-write",
  );
  assert.deepEqual(tools, []);
  assert.equal(calls, 0);
});

test("a read-only session gets GitHub tools that call the desktop for its own session, masked", async () => {
  const listed: unknown[] = [];
  const called: unknown[] = [];
  const tools = await githubClientTools(
    {
      githubMcpTools: async (input) => {
        listed.push(input);
        return [
          {
            name: "get_issue",
            description: "Get an issue",
            inputSchema: { type: "object", properties: {} },
          },
        ];
      },
      githubMcpCall: async ({ signal, ...input }) => {
        void signal;
        called.push(input);
        return {
          content: [
            { type: "text", text: `CI printed ${leakedToken}` },
            { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
          ],
        };
      },
    },
    "session-read",
  );
  assert.deepEqual(listed, [{ sessionId: "session-read" }]);
  assert.deepEqual(
    tools.map(({ name }) => name),
    ["github__get_issue"],
  );

  const result = await callThroughToolSet(
    tools,
    "github__get_issue",
    { owner: "blame", repo: "app", issue_number: 7 },
    "session-read",
  );
  assert.deepEqual(called, [
    {
      arguments: { owner: "blame", repo: "app", issue_number: 7 },
      sessionId: "session-read",
      toolName: "get_issue",
    },
  ]);
  assert.equal(result.outcome, "completed");
  const [text, image] = result.content as [
    { type: "text"; text: string },
    { type: "image"; blob: { media_type: string } },
  ];
  assert.doesNotMatch(text.text, /ghp_/u);
  assert.match(text.text, /^CI printed <REDACTED_SECRET:/u);
  // The image reaches the model as an image, stored as a blob.
  assert.equal(image.type, "image");
  assert.equal(image.blob.media_type, "image/png");
  assert.deepEqual(result.blobs, [
    { media_type: "image/png", data: "aW1hZ2U=" },
  ]);
});

test("GitHub tools are left out, not the session, when GitHub cannot be reached", async () => {
  const logged: string[] = [];
  const tools = await githubClientTools(
    {
      githubMcpTools: async () => {
        throw new Error("fetch failed");
      },
      githubMcpCall: async () => ({}),
      log: (message) => logged.push(message),
    },
    "session-read",
  );
  assert.deepEqual(tools, []);
  assert.deepEqual(logged, ["GitHub MCP tools unavailable"]);
});
