import assert from "node:assert/strict";
import test from "node:test";
import { githubMcpTools, type GithubMcpToolOptions } from "./github-mcp-tools.js";

const logger = { log() {} };
// Built at run time so the source holds no token-shaped literal.
const leakedToken = `ghp_${"A1b2".repeat(9)}`;

test("a session without read-only GitHub access registers no GitHub MCP tool", async () => {
  assert.deepEqual(await githubMcpTools({}, "session-write", logger), []);
  let calls = 0;
  const options: GithubMcpToolOptions = {
    // What the desktop answers for a read and write (or off) session.
    githubMcpTools: async () => [],
    githubMcpCall: async () => {
      calls += 1;
      return {};
    },
  };
  assert.deepEqual(await githubMcpTools(options, "session-write", logger), []);
  assert.equal(calls, 0);
});

test("a read-only session gets GitHub tools that call the desktop for its own session", async () => {
  const listed: unknown[] = [];
  const called: unknown[] = [];
  const image = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
  const tools = await githubMcpTools(
    {
      githubMcpTools: async (input) => {
        listed.push(input);
        return [{ name: "get_issue", description: "Get an issue", inputSchema: { type: "object", properties: {} } }];
      },
      githubMcpCall: async ({ signal, ...input }) => {
        void signal;
        called.push(input);
        return {
          content: [{ type: "text", text: `CI printed ${leakedToken}` }, image],
        };
      },
    },
    "session-read",
    logger,
  );
  assert.deepEqual(listed, [{ sessionId: "session-read" }]);
  assert.deepEqual(tools.map(({ name }) => name), ["github__get_issue"]);

  const result = (await tools[0]!.execute(
    { owner: "blame", repo: "app", issue_number: 7 },
    { sessionId: "session-read", conversationId: "session-read", toolCallId: "t1" } as never,
  )) as { content: unknown[] };
  assert.deepEqual(called, [
    {
      arguments: { owner: "blame", repo: "app", issue_number: 7 },
      sessionId: "session-read",
      toolName: "get_issue",
    },
  ]);
  const [text, binary] = result.content as [{ text: string }, unknown];
  assert.doesNotMatch(text.text, /ghp_/u);
  assert.match(text.text, /^CI printed <REDACTED_SECRET:/u);
  assert.deepEqual(binary, image);
});

test("GitHub tools are left out, not the session, when GitHub cannot be reached", async () => {
  const logged: string[] = [];
  const tools = await githubMcpTools(
    {
      githubMcpTools: async () => {
        throw new Error("fetch failed");
      },
      githubMcpCall: async () => ({}),
    },
    "session-read",
    { log: (message) => logged.push(message) },
  );
  assert.deepEqual(tools, []);
  assert.deepEqual(logged, ["GitHub MCP tools unavailable"]);
});
