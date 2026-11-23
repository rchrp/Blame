// The user's MCP servers, as Settings → MCP saves them
// (`packages/desktop/src/main/mcp-ipc.ts`): one JSON file of `mcpServers`,
// each a command (stdio) or a URL (Streamable HTTP or SSE), with the OAuth
// state of the servers the user authorized kept next to it.

import { homedir } from "node:os";
import { join } from "node:path";

import {
  readMcpSettings,
  updateMcpSettings,
} from "../../mcp-settings-store.js";

export type McpTransport =
  | {
      type: "stdio";
      command: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
    }
  | {
      type: "streamableHttp" | "sse";
      url: string;
      headers?: Record<string, string>;
    };

export type McpServer = {
  name: string;
  transport: McpTransport;
  /** Seconds a call may take; 60 by default. */
  timeoutSeconds?: number;
};

/** What OAuth leaves in the file for one server (the MCP SDK's own shapes). */
export type McpOAuthState = {
  clientInformation?: Record<string, unknown>;
  tokens?: Record<string, unknown>;
  codeVerifier?: string;
  discoveryState?: Record<string, unknown>;
  redirectUrl?: string;
  lastError?: string;
  lastAuthenticatedAt?: number;
  authorizationRequired?: boolean;
};

/**
 * Where the file is: `BLAME_MCP_SETTINGS_PATH` (the desktop app sets it to
 * its data folder's `mcp-settings.json`), else `~/.blame/mcp-settings.json`.
 */
export function mcpSettingsPath() {
  const explicit = process.env.BLAME_MCP_SETTINGS_PATH?.trim();
  if (explicit) return explicit;
  return join(homedir(), ".blame", "mcp-settings.json");
}

/** The servers the user enabled, in the file's order. */
export async function enabledMcpServers(
  path = mcpSettingsPath(),
): Promise<McpServer[]> {
  const settings = await readMcpSettings(path);
  return Object.entries(settings.mcpServers).flatMap(([name, value]) => {
    const server = mcpServer(name, value);
    return server && !disabled(value) ? [server] : [];
  });
}

/** Every configured server, enabled or not. */
export async function configuredMcpServers(path = mcpSettingsPath()) {
  const settings = await readMcpSettings(path);
  return Object.entries(settings.mcpServers).flatMap(([name, value]) => {
    const server = mcpServer(name, value);
    return server ? [{ server, oauth: oauthState(value) }] : [];
  });
}

export async function readMcpOAuthState(
  serverName: string,
  path = mcpSettingsPath(),
): Promise<McpOAuthState> {
  const settings = await readMcpSettings(path);
  return oauthState(settings.mcpServers[serverName]);
}

/**
 * Changes one server's OAuth state, under the lock the desktop's Settings
 * share, so a token refreshed here and a server saved there never overwrite
 * each other. The file is never replaced when it cannot be read.
 */
export async function updateMcpOAuthState(
  serverName: string,
  update: (state: McpOAuthState) => McpOAuthState,
  path = mcpSettingsPath(),
): Promise<McpOAuthState> {
  let state: McpOAuthState = {};
  await updateMcpSettings(path, (settings) => {
    const server = settings.mcpServers[serverName];
    if (!server)
      throw new Error(`MCP server "${serverName}" is not configured.`);
    state = update(oauthState(server));
    settings.mcpServers[serverName] = {
      ...server,
      oauth: Object.keys(state).length ? state : undefined,
    };
  });
  return state;
}

function mcpServer(
  name: string,
  value: Record<string, unknown> | undefined,
): McpServer | undefined {
  const entry = record(value);
  const nested = record(entry.transport);
  const transport = Object.keys(nested).length ? nested : entry;
  const timeout = entry.timeout ?? transport.timeout;
  const timeoutSeconds =
    typeof timeout === "number" && timeout > 0 ? timeout : undefined;
  if (transport.type === "streamableHttp" || transport.type === "sse") {
    if (typeof transport.url !== "string" || !transport.url) return undefined;
    return {
      name,
      transport: {
        type: transport.type,
        url: transport.url,
        ...(strings(transport.headers)
          ? { headers: strings(transport.headers) }
          : {}),
      },
      ...(timeoutSeconds ? { timeoutSeconds } : {}),
    };
  }
  if (typeof transport.command !== "string" || !transport.command)
    return undefined;
  return {
    name,
    transport: {
      type: "stdio",
      command: transport.command,
      ...(Array.isArray(transport.args)
        ? { args: transport.args.filter((arg) => typeof arg === "string") }
        : {}),
      ...(typeof transport.cwd === "string" && transport.cwd
        ? { cwd: transport.cwd }
        : {}),
      ...(strings(transport.env) ? { env: strings(transport.env) } : {}),
    },
    ...(timeoutSeconds ? { timeoutSeconds } : {}),
  };
}

// Disabled by the user, or synced from Blame's cloud and not set up here yet.
function disabled(value: Record<string, unknown>) {
  const metadata = record(value.metadata);
  return (
    value.disabled === true || metadata.blameCloudLocalSetupRequired === true
  );
}

function oauthState(value: Record<string, unknown> | undefined): McpOAuthState {
  return record(record(value).oauth) as McpOAuthState;
}

function strings(value: unknown): Record<string, string> | undefined {
  const entries = Object.entries(record(value)).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
