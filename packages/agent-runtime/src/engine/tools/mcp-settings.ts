// The user's MCP servers, as Settings → MCP saves them
// (`packages/desktop/src/main/mcp-ipc.ts`): one JSON file of `mcpServers`,
// each a command (stdio) or a URL (Streamable HTTP or SSE), with the OAuth
// state of the servers the user authorized kept next to it.

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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

type Settings = { mcpServers: Record<string, Record<string, unknown>> };

/** Where the file is: `CLINE_MCP_SETTINGS_PATH`, else in the agents' data folder. */
export function mcpSettingsPath() {
  const explicit = process.env.CLINE_MCP_SETTINGS_PATH?.trim();
  if (explicit) return explicit;
  const dataDir =
    process.env.CLINE_DATA_DIR?.trim() || join(homedir(), ".cline", "data");
  return join(dataDir, "settings", "cline_mcp_settings.json");
}

async function readSettings(path: string): Promise<Settings> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    const servers = record(record(parsed).mcpServers);
    return { ...record(parsed), mcpServers: { ...servers } } as Settings;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { mcpServers: {} };
    throw error;
  }
}

/** The servers the user enabled, in the file's order. */
export async function enabledMcpServers(
  path = mcpSettingsPath(),
): Promise<McpServer[]> {
  const settings = await readSettings(path);
  return Object.entries(settings.mcpServers).flatMap(([name, value]) => {
    const server = mcpServer(name, value);
    return server && !disabled(value) ? [server] : [];
  });
}

/** Every configured server, enabled or not. */
export async function configuredMcpServers(path = mcpSettingsPath()) {
  const settings = await readSettings(path);
  return Object.entries(settings.mcpServers).flatMap(([name, value]) => {
    const server = mcpServer(name, value);
    return server ? [{ server, oauth: oauthState(value) }] : [];
  });
}

export async function readMcpOAuthState(
  serverName: string,
  path = mcpSettingsPath(),
): Promise<McpOAuthState> {
  const settings = await readSettings(path);
  return oauthState(settings.mcpServers[serverName]);
}

let writing: Promise<unknown> = Promise.resolve();

/** Changes one server's OAuth state; the file is rewritten whole, mode 600. */
export function updateMcpOAuthState(
  serverName: string,
  update: (state: McpOAuthState) => McpOAuthState,
  path = mcpSettingsPath(),
): Promise<McpOAuthState> {
  const next = writing.then(async () => {
    const settings = await readSettings(path);
    const server = settings.mcpServers[serverName];
    if (!server)
      throw new Error(`MCP server "${serverName}" is not configured.`);
    const state = update(oauthState(server));
    settings.mcpServers[serverName] = {
      ...server,
      oauth: Object.keys(state).length ? state : undefined,
    };
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, path);
    if (process.platform !== "win32") await chmod(path, 0o600);
    return state;
  });
  writing = next.catch(() => undefined);
  return next;
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
