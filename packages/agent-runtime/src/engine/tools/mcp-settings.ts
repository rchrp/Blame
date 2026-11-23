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

/**
 * Where the file is: `BLAME_MCP_SETTINGS_PATH` (the desktop app sets it to
 * its data folder's `mcp-settings.json`), else `~/.blame/mcp-settings.json`.
 */
export function mcpSettingsPath() {
  const explicit = process.env.BLAME_MCP_SETTINGS_PATH?.trim();
  if (explicit) return explicit;
  return join(homedir(), ".blame", "mcp-settings.json");
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

// Every change goes through this one chain: read the file, change it, write
// it whole (mode 600) next to a temporary file.
function changeSettings<T>(
  path: string,
  change: (settings: Settings) => T,
): Promise<T> {
  const next = writing.then(async () => {
    const settings = await readSettings(path);
    const result = change(settings);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, path);
    if (process.platform !== "win32") await chmod(path, 0o600);
    return result;
  });
  writing = next.catch(() => undefined);
  return next;
}

/** Changes one server's OAuth state; the file is rewritten whole, mode 600. */
export function updateMcpOAuthState(
  serverName: string,
  update: (state: McpOAuthState) => McpOAuthState,
  path = mcpSettingsPath(),
): Promise<McpOAuthState> {
  return changeSettings(path, (settings) => {
    const server = settings.mcpServers[serverName];
    if (!server)
      throw new Error(`MCP server "${serverName}" is not configured.`);
    const state = update(oauthState(server));
    settings.mcpServers[serverName] = {
      ...server,
      oauth: Object.keys(state).length ? state : undefined,
    };
    return state;
  });
}

/** One configured server as the settings file holds it, enabled or not. */
export type McpServerEntry = {
  server: McpServer;
  disabled: boolean;
  /** Synced from Blame's cloud and not set up on this computer yet. */
  needsLocalSetup: boolean;
  /** The names of its environment variables that have no value yet. */
  emptyEnv: string[];
  oauth: McpOAuthState;
};

/** Every configured server with what its entry says of it. */
export async function mcpServerEntries(
  path = mcpSettingsPath(),
): Promise<McpServerEntry[]> {
  const settings = await readSettings(path);
  return Object.entries(settings.mcpServers).flatMap(([name, value]) => {
    const server = mcpServer(name, value);
    if (!server) return [];
    const metadata = record(value.metadata);
    const env =
      server.transport.type === "stdio" ? (server.transport.env ?? {}) : {};
    return [
      {
        server,
        disabled: value.disabled === true,
        needsLocalSetup: metadata.blameCloudLocalSetupRequired === true,
        emptyEnv: Object.entries(env)
          .filter(([, entry]) => !entry)
          .map(([key]) => key),
        oauth: oauthState(value),
      },
    ];
  });
}

/** What a new server is made of: the person fills secrets in, never the agent. */
export type NewMcpServer = {
  name: string;
  transport: McpTransport;
  /** Saved turned off, until the person sets what it still needs. */
  disabled?: boolean;
};

/** Adds a server in the format Settings → MCP writes; never replaces one. */
export function addMcpServer(
  server: NewMcpServer,
  path = mcpSettingsPath(),
): Promise<void> {
  return changeSettings(path, (settings) => {
    const taken = Object.keys(settings.mcpServers).some(
      (name) => name.toLowerCase() === server.name.toLowerCase(),
    );
    if (taken)
      throw new Error(`An MCP server named "${server.name}" already exists.`);
    const transport = server.transport;
    settings.mcpServers[server.name] =
      transport.type === "stdio"
        ? {
            disabled: server.disabled === true,
            type: "stdio",
            command: transport.command,
            args: transport.args ?? [],
            ...(transport.cwd ? { cwd: transport.cwd } : {}),
            ...(transport.env ? { env: transport.env } : {}),
          }
        : {
            disabled: server.disabled === true,
            type: transport.type,
            url: transport.url,
          };
  });
}

/** Removes a server and its saved sign-in; false when it was not there. */
export function removeMcpServer(
  name: string,
  path = mcpSettingsPath(),
): Promise<boolean> {
  return changeSettings(path, (settings) => {
    if (!settings.mcpServers[name]) return false;
    delete settings.mcpServers[name];
    return true;
  });
}

/** Turns a server on or off, as its switch in Settings → MCP does. */
export function setMcpServerDisabled(
  name: string,
  disabled: boolean,
  path = mcpSettingsPath(),
): Promise<void> {
  return changeSettings(path, (settings) => {
    const server = settings.mcpServers[name];
    if (!server) throw new Error(`MCP server "${name}" is not configured.`);
    if (!disabled && record(server.metadata).blameCloudLocalSetupRequired)
      throw new Error(
        `MCP server "${name}" needs its setup finished in Settings → MCP first.`,
      );
    server.disabled = disabled;
  });
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
