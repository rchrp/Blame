import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  sessionGithubMcpServer,
  type GithubMcpServer,
} from "./agent-github-access.ts";

// The agent's GitHub MCP server for a session with read-only GitHub access:
// a client kept in memory in this process, connected to GitHub's remote MCP
// server with the session's token. It is never registered in
// cline_mcp_settings.json, so it is not listed in Settings → MCP, and the
// token never reaches the agent process or its commands.

export type GithubMcpTool = {
  description?: string;
  inputSchema: Record<string, unknown>;
  name: string;
};

export type GithubMcpConnection = {
  callTool(
    name: string,
    argumentsValue: Record<string, unknown>,
    options: { signal?: AbortSignal; timeout: number },
  ): Promise<unknown>;
  close(): Promise<void>;
  listTools(): Promise<GithubMcpTool[]>;
};

type ConnectGithubMcp = (server: GithubMcpServer) => Promise<GithubMcpConnection>;

type SessionConnection = {
  authorization: string;
  connection: Promise<GithubMcpConnection>;
};

export type GithubMcpCall = {
  arguments?: Record<string, unknown>;
  sessionId?: string;
  signal?: AbortSignal;
  toolName: string;
};

const connectTimeoutMs = 15_000;
// Below the agent's own ceiling, so it reads this timeout's message.
const callTimeoutMs = 60_000;

export class GithubMcpService {
  private readonly connections = new Map<string, SessionConnection>();
  private readonly connect: ConnectGithubMcp;
  private readonly server: typeof sessionGithubMcpServer;

  constructor(
    connect: ConnectGithubMcp = connectGithubMcp,
    server: typeof sessionGithubMcpServer = sessionGithubMcpServer,
  ) {
    this.connect = connect;
    this.server = server;
  }

  /** The session's GitHub tools: none unless its access is read-only. */
  async listTools(sessionId: string | undefined) {
    const connection = this.connection(sessionId);
    return connection ? (await connection).listTools() : [];
  }

  async call(input: GithubMcpCall) {
    const connection = this.connection(input.sessionId);
    if (!connection)
      throw new Error("This session has no read-only GitHub access.");
    return (await connection).callTool(input.toolName, input.arguments ?? {}, {
      signal: input.signal,
      timeout: callTimeoutMs,
    });
  }

  async dispose() {
    const connections = [...this.connections.values()];
    this.connections.clear();
    await Promise.allSettled(connections.map(closeConnection));
  }

  // The session's connection, opened on first use and replaced when the
  // session was granted another token. A session whose access was revoked
  // or changed to read and write loses it.
  private connection(sessionId: string | undefined) {
    const server = this.server(sessionId);
    const current = sessionId ? this.connections.get(sessionId) : undefined;
    const authorization = server?.headers.Authorization;
    if (current && current.authorization === authorization)
      return current.connection;
    if (current && sessionId) {
      this.connections.delete(sessionId);
      void closeConnection(current);
    }
    if (!server || !sessionId || !authorization) return undefined;
    const connection = this.connect(server);
    this.connections.set(sessionId, { authorization, connection });
    // A failed connection is retried on the next call.
    connection.catch(() => {
      if (this.connections.get(sessionId)?.connection === connection)
        this.connections.delete(sessionId);
    });
    return connection;
  }
}

async function closeConnection(session: SessionConnection) {
  await (await session.connection.catch(() => undefined))?.close();
}

async function connectGithubMcp(
  server: GithubMcpServer,
): Promise<GithubMcpConnection> {
  const client = new Client({ name: "blame-desktop", version: "1.0.0" });
  // The SDK follows same-origin redirects only, so the token stays with
  // GitHub's MCP origin.
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: server.headers },
  });
  await client.connect(transport, { timeout: connectTimeoutMs });
  return {
    async listTools() {
      const tools: GithubMcpTool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined, {
          timeout: connectTimeoutMs,
        });
        tools.push(
          ...page.tools.map((tool) => ({
            name: tool.name,
            ...(tool.description ? { description: tool.description } : {}),
            inputSchema: tool.inputSchema as Record<string, unknown>,
          })),
        );
        cursor = page.nextCursor;
      } while (cursor);
      return tools;
    },
    callTool: (name, argumentsValue, options) =>
      client.callTool({ arguments: argumentsValue, name }, undefined, options),
    close: () => client.close(),
  };
}

export const githubMcpService = new GithubMcpService();

export function shutdownGithubMcp() {
  return githubMcpService.dispose();
}
