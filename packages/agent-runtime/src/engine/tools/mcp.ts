// The user's own MCP servers (Settings → MCP), connected with the MCP SDK.
// One connection per server serves every conversation of the engine host;
// it opens on first use and closes with the host. Each server's tools become
// client tools named `<server>__<tool>` (made safe for every provider), with
// the effect the server declares (`readOnlyHint`) and the redaction of the
// tool set's guards.
//
// A conversation's tools are listed once, when the host first gives it its
// tools, and stay as they were for the whole conversation in this host: its
// tool list is part of its config and of the provider's prompt cache. A tool
// the server dropped since fails with the server's message; a new one shows
// in new conversations, or in this one after the app restarts.

import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { toolOutputLimits } from "../../tool-output-limit.js";
import { defineTool, type ClientTool } from "../tool.js";
import { remoteTransport, SettingsOAuthProvider } from "./mcp-oauth.js";
import {
  enabledMcpServers,
  mcpServerEntries,
  mcpSettingsPath,
  type McpServer,
} from "./mcp-settings.js";
import { errorMessage, mcpOutput } from "./output.js";

const defaultTimeoutSeconds = 60;
const connectTimeoutMs = 30_000;
// Names Blame gives its own MCP tools; a user's server cannot take them.
const reservedServers = new Set(["github", "preview_devtools"]);

/** Whether Blame's own MCP tools hold this server name. */
export function reservedMcpName(name: string) {
  return reservedServers.has(serverPrefix(name));
}

type Connection = { client: Client; key: string };

export type McpTool = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
};

/** What the host knows of one configured server (`blame_inspect`, `blame_repair`). */
export type McpServerStatus = {
  name: string;
  /** The command line or the URL, without credentials. */
  target: string;
  state:
    | "connected"
    | "failed"
    | "idle"
    | "disabled"
    | "needs_setup"
    | "needs_authorization";
  tools?: number;
  /** Why the last connection failed, as the server or the system said. */
  error?: string;
  /** Environment variables that still have no value: the person fills them in. */
  missingEnv?: string[];
};

export class McpConnections {
  private readonly connections = new Map<string, Promise<Connection>>();
  private readonly failures = new Map<string, string>();
  private readonly toolCounts = new Map<string, number>();
  private readonly settingsPath: () => string;
  private readonly log: (
    message: string,
    payload?: Record<string, unknown>,
  ) => void;

  constructor(
    options: {
      settingsPath?: () => string;
      log?(message: string, payload?: Record<string, unknown>): void;
    } = {},
  ) {
    this.settingsPath = options.settingsPath ?? mcpSettingsPath;
    this.log = options.log ?? (() => undefined);
  }

  /** The enabled servers' tools, as client tools; a server that fails is left out. */
  async clientTools(signal?: AbortSignal): Promise<ClientTool<never>[]> {
    const servers = (
      await enabledMcpServers(this.settingsPath()).catch((error: unknown) => {
        this.log("MCP settings unreadable", { error: errorMessage(error) });
        return [];
      })
    ).filter((server) => !reservedServers.has(serverPrefix(server.name)));
    const listed = await Promise.all(
      servers.map(async (server) => {
        try {
          const tools = await this.listTools(server, signal);
          return tools.map((tool) => mcpClientTool(this, server, tool));
        } catch (error) {
          this.log("MCP server unavailable", {
            server: server.name,
            error: errorMessage(error),
          });
          return [];
        }
      }),
    );
    const seen = new Set<string>();
    return listed.flat().filter((tool) => {
      if (seen.has(tool.name)) return false;
      seen.add(tool.name);
      return true;
    });
  }

  /**
   * Every configured server with its connection as this host has it. It
   * connects to nothing: a server no conversation used yet is `idle`.
   */
  async status(): Promise<McpServerStatus[]> {
    const entries = await mcpServerEntries(this.settingsPath());
    return Promise.all(
      entries.map(
        async ({ server, disabled, needsLocalSetup, emptyEnv, oauth }) => {
          const failure = this.failures.get(server.name);
          const open = this.connections.get(server.name);
          const connected = open
            ? await open.then(
                () => true,
                () => false,
              )
            : false;
          const state: McpServerStatus["state"] = needsLocalSetup
            ? "needs_setup"
            : disabled
              ? "disabled"
              : oauth.authorizationRequired
                ? "needs_authorization"
                : connected
                  ? "connected"
                  : failure
                    ? "failed"
                    : "idle";
          const tools = this.toolCounts.get(server.name);
          return {
            name: server.name,
            target: describeTarget(server),
            state,
            ...(connected && tools !== undefined ? { tools } : {}),
            ...(state === "failed" || oauth.lastError
              ? { error: failure ?? oauth.lastError }
              : {}),
            ...(emptyEnv.length ? { missingEnv: emptyEnv } : {}),
          };
        },
      ),
    );
  }

  /**
   * Drops the server's connection and opens it again, which starts a stdio
   * server's process anew; the answer is its status and what went wrong.
   */
  async reconnect(name: string, signal?: AbortSignal) {
    const entry = (await mcpServerEntries(this.settingsPath())).find(
      (candidate) => candidate.server.name === name,
    );
    if (!entry) throw new Error(`MCP server "${name}" is not configured.`);
    if (entry.disabled)
      throw new Error(`MCP server "${name}" is turned off in Settings → MCP.`);
    this.forget(name);
    try {
      await this.listTools(entry.server, signal);
    } catch {
      // The failure is recorded; the status says it.
    }
    return (await this.status()).find((status) => status.name === name)!;
  }

  async listTools(server: McpServer, signal?: AbortSignal): Promise<McpTool[]> {
    const { client } = await this.connection(server);
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, {
        signal,
        timeout: timeoutMs(server),
      });
      for (const tool of page.tools)
        tools.push({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema as Record<string, unknown>,
          ...(tool.annotations?.readOnlyHint !== undefined
            ? { annotations: { readOnlyHint: tool.annotations.readOnlyHint } }
            : {}),
        });
      cursor = page.nextCursor;
    } while (cursor);
    this.toolCounts.set(server.name, tools.length);
    return tools;
  }

  async callTool(
    server: McpServer,
    name: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const { client } = await this.connection(server);
    try {
      return await client.callTool({ name, arguments: input }, undefined, {
        signal,
        timeout: timeoutMs(server),
        resetTimeoutOnProgress: true,
      });
    } catch (error) {
      // A dropped connection opens again on the next call.
      if (!signal.aborted) this.forget(server.name);
      throw error;
    }
  }

  async close() {
    const connections = [...this.connections.values()];
    this.connections.clear();
    await Promise.allSettled(
      connections.map(async (connection) => (await connection).client.close()),
    );
  }

  private connection(server: McpServer): Promise<Connection> {
    const key = JSON.stringify(server);
    const known = this.connections.get(server.name);
    if (known)
      return known.then((connection): Promise<Connection> | Connection => {
        if (connection.key === key) return connection;
        // The user changed the server since: connect to the new one.
        void connection.client.close().catch(() => undefined);
        this.connections.delete(server.name);
        return this.connection(server);
      });
    const opened = connect(server, this.settingsPath(), key);
    this.connections.set(server.name, opened);
    opened.then(
      () => this.failures.delete(server.name),
      (error: unknown) => {
        this.failures.set(server.name, errorMessage(error));
        if (this.connections.get(server.name) === opened)
          this.connections.delete(server.name);
      },
    );
    return opened;
  }

  /** Closes a server's connection (it was removed or turned off). */
  disconnect(name: string) {
    this.forget(name);
  }

  private forget(name: string) {
    const known = this.connections.get(name);
    this.connections.delete(name);
    this.failures.delete(name);
    this.toolCounts.delete(name);
    void known
      ?.then((connection) => connection.client.close())
      .catch(() => undefined);
  }
}

async function connect(
  server: McpServer,
  settingsPath: string,
  key: string,
): Promise<Connection> {
  const client = new Client({ name: "Blame", version: "1.0.0" });
  const transport: Transport =
    server.transport.type === "stdio"
      ? new StdioClientTransport({
          command: server.transport.command,
          args: server.transport.args ?? [],
          ...(server.transport.cwd ? { cwd: server.transport.cwd } : {}),
          env: {
            ...(process.env as Record<string, string>),
            ...server.transport.env,
          },
          stderr: "ignore",
        })
      : remoteTransport(
          server,
          new SettingsOAuthProvider({
            serverName: server.name,
            path: settingsPath,
          }),
        );
  await client.connect(transport, { timeout: connectTimeoutMs });
  return { client, key };
}

function describeTarget(server: McpServer) {
  const transport = server.transport;
  if (transport.type === "stdio")
    return [transport.command, ...(transport.args ?? [])]
      .join(" ")
      .slice(0, 200);
  try {
    const url = new URL(transport.url);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "(invalid URL)";
  }
}

function timeoutMs(server: McpServer) {
  return (server.timeoutSeconds ?? defaultTimeoutSeconds) * 1000;
}

const maximumName = 64;
const unsafe = /[^a-zA-Z0-9_-]+/g;

function serverPrefix(server: string) {
  return server.replace(unsafe, "_");
}

/** `<server>__<tool>`, safe for every provider: at most 64 characters of [a-zA-Z0-9_-]. */
export function mcpToolName(server: string, tool: string) {
  const name = `${server}__${tool}`;
  const safe = name.replace(unsafe, "_");
  if (safe === name && name.length <= maximumName) return name;
  const hash = createHash("sha1").update(name).digest("hex").slice(0, 8);
  return `${safe.slice(0, maximumName - 9) || "mcp_tool"}_${hash}`;
}

function mcpClientTool(
  connections: McpConnections,
  server: McpServer,
  tool: McpTool,
): ClientTool<never> {
  const readOnly = tool.annotations?.readOnlyHint === true;
  return defineTool<Record<string, unknown>>({
    name: mcpToolName(server.name, tool.name),
    description:
      tool.description?.trim() ||
      `Execute MCP tool "${tool.name}" from server "${server.name}".`,
    inputSchema: tool.inputSchema,
    effect: readOnly ? "read_only" : "external",
    source: { kind: "mcp", server: server.name, readOnly },
    // The server's own timeout ends the call first, with its message.
    timeoutMs: timeoutMs(server) + 5_000,
    async run(input, { signal }) {
      return mcpOutput(
        await connections.callTool(server, tool.name, input, signal),
        toolOutputLimits.userMcp,
      );
    },
  });
}
