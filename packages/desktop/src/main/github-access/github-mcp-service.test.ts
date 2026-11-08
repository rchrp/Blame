import assert from "node:assert/strict";
import test from "node:test";
import type { GithubMcpServer } from "./agent-github-access.ts";
import { GithubMcpService, type GithubMcpConnection } from "./github-mcp-service.ts";

const readOnlyServer = (token: string): GithubMcpServer => ({
  url: "https://api.githubcopilot.com/mcp/",
  headers: {
    Authorization: `Bearer ${token}`,
    "X-MCP-Readonly": "true",
    "X-MCP-Toolsets": "context,repos,issues,pull_requests,actions",
  },
});

function fakeService(servers: Map<string, GithubMcpServer>) {
  const connected: GithubMcpServer[] = [];
  const calls: { name: string; arguments: Record<string, unknown> }[] = [];
  let closed = 0;
  const service = new GithubMcpService(
    async (server): Promise<GithubMcpConnection> => {
      connected.push(server);
      return {
        listTools: async () => [{ name: "get_issue", inputSchema: { type: "object" } }],
        callTool: async (name, argumentsValue) => {
          calls.push({ name, arguments: argumentsValue });
          return { content: [{ type: "text", text: "issue" }] };
        },
        close: async () => {
          closed += 1;
        },
      };
    },
    (sessionId) => (sessionId ? servers.get(sessionId) : undefined),
  );
  return { calls, closed: () => closed, connected, service };
}

test("a read-only session connects to GitHub's MCP server with its token and read-only headers", async () => {
  const servers = new Map([["session-read", readOnlyServer("gho_session")]]);
  const { calls, connected, service } = fakeService(servers);

  assert.deepEqual(await service.listTools("session-read"), [
    { name: "get_issue", inputSchema: { type: "object" } },
  ]);
  assert.deepEqual(
    await service.call({ sessionId: "session-read", toolName: "get_issue", arguments: { issue_number: 1 } }),
    { content: [{ type: "text", text: "issue" }] },
  );
  assert.deepEqual(calls, [{ name: "get_issue", arguments: { issue_number: 1 } }]);
  // One connection for the session, with the headers the remote server needs.
  assert.deepEqual(connected, [readOnlyServer("gho_session")]);
});

test("a session without read-only access gets no GitHub tools and never connects", async () => {
  const { connected, service } = fakeService(new Map());
  assert.deepEqual(await service.listTools("session-write"), []);
  assert.deepEqual(await service.listTools(undefined), []);
  await assert.rejects(
    service.call({ sessionId: "session-write", toolName: "get_issue" }),
    /no read-only GitHub access/u,
  );
  assert.deepEqual(connected, []);
});

test("a session's connection closes when its access is revoked and reopens with a new token", async () => {
  const servers = new Map([["session-read", readOnlyServer("gho_first")]]);
  const { closed, connected, service } = fakeService(servers);
  await service.listTools("session-read");

  servers.set("session-read", readOnlyServer("gho_second"));
  await service.listTools("session-read");
  assert.deepEqual(
    connected.map(({ headers }) => headers.Authorization),
    ["Bearer gho_first", "Bearer gho_second"],
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed(), 1);

  servers.delete("session-read");
  assert.deepEqual(await service.listTools("session-read"), []);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed(), 2);
  assert.equal(connected.length, 2);
});
