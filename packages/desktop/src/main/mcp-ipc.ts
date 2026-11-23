import type { McpOAuthStatus } from "@blame/agent-runtime";
import type { CloudMcpServerConfig, McpServerConfig } from "@blame/app";
import {
  clearMcpSettingsRecovery,
  readMcpSettings,
  readMcpSettingsRecovery,
  updateMcpSettings,
  type McpSettingsUpdateOptions,
} from "@blame/agent-runtime/mcp-settings-store";
import { ipcMain } from "electron";
import { chmod } from "node:fs/promises";
import {
  cloudDisabled,
  completedCloudMetadata,
  detachCloudServers,
  localSetupRequired,
  mergeCloudServers,
  type McpSettings,
} from "./mcp-cloud-sync";
import { callEngineHost } from "./engine/engine-host-ipc";
import { mcpSettingsFile } from "./mcp-settings-file";

let settingsOperation: Promise<unknown> = Promise.resolve();
let authorizationRunning = false;

export function registerMcpIpcHandlers() {
  ipcMain.handle("mcp:list", () =>
    runSettingsOperation(async () => listServers()),
  );
  // The third argument older versions sent (adopt local servers) is ignored:
  // a server set up on this computer is never replaced by the account's copy.
  ipcMain.handle("mcp:merge-cloud", (_event, userIdInput, input) =>
    runSettingsOperation(async () => {
      const userId = validateUserId(userIdInput);
      const cloudServers = validateCloudServers(input);
      const merged = await changeSettings((settings) =>
        mergeCloudServers(settings, userId, cloudServers),
      );
      return listServers(merged);
    }),
  );
  ipcMain.handle("mcp:detach-cloud", (_event, userIdInput) =>
    runSettingsOperation(async () => {
      const userId = validateUserId(userIdInput);
      const settings = await changeSettings(
        (current) => detachCloudServers(current, userId),
        { allowEmpty: true },
      );
      return listServers(settings);
    }),
  );
  ipcMain.handle("mcp:recovery", () =>
    runSettingsOperation(() => readMcpSettingsRecovery(settingsPath())),
  );
  ipcMain.handle("mcp:dismiss-recovery", () =>
    runSettingsOperation(() => clearMcpSettingsRecovery(settingsPath())),
  );
  ipcMain.handle("mcp:save", (_event, input, previousName) =>
    runSettingsOperation(async () => {
      const server = validateServer(input);
      const originalName =
        typeof previousName === "string"
          ? validateName(previousName)
          : undefined;
      const settings = await changeSettings((current) => {
        const existing = current.mcpServers[originalName ?? server.name];
        if (originalName && !existing) throw new Error("MCP server not found");
        if (hasNameConflict(current, server.name, originalName)) {
          throw new Error("An MCP server with this name already exists");
        }
        if (originalName && originalName !== server.name) {
          delete current.mcpServers[originalName];
        }
        const preserveOAuth = existing && sameEndpoint(existing, server);
        current.mcpServers[server.name] = {
          ...(existing ?? {}),
          ...serializeServer(server),
          metadata: completedCloudMetadata(existing),
          ...(preserveOAuth && existing.oauth
            ? { oauth: existing.oauth }
            : { oauth: undefined }),
        };
      });
      return listServers(settings);
    }),
  );
  ipcMain.handle("mcp:remove", (_event, input) =>
    runSettingsOperation(async () => {
      const name = validateName(input);
      const settings = await changeSettings(
        (current) => {
          delete current.mcpServers[name];
        },
        { allowEmpty: true },
      );
      return listServers(settings);
    }),
  );
  ipcMain.handle("mcp:set-enabled", (_event, input, enabled) =>
    runSettingsOperation(async () => {
      const name = validateName(input);
      if (typeof enabled !== "boolean")
        throw new Error("Invalid enabled state");
      const settings = await changeSettings((current) => {
        const server = current.mcpServers[name];
        if (!server) throw new Error("MCP server not found");
        if (localSetupRequired(server))
          throw new Error("Complete this MCP server setup before enabling it");
        server.disabled = !enabled;
      });
      return listServers(settings);
    }),
  );
  ipcMain.handle("mcp:authorize", (_event, input) =>
    runSettingsOperation(async () => {
      const name = validateName(input);
      if (authorizationRunning)
        throw new Error("Another MCP authorization is already in progress");
      const settings = await readSettings();
      const server = settings.mcpServers[name];
      if (!server) throw new Error("MCP server not found");
      if (localSetupRequired(server))
        throw new Error("Complete this MCP server setup before authorizing it");
      authorizationRunning = true;
      try {
        await callEngineHost("mcpOAuthAuthorize", {
          filePath: settingsPath(),
          serverName: name,
        });
        return listServers();
      } finally {
        await protectSettingsFile();
        authorizationRunning = false;
      }
    }),
  );
  ipcMain.handle("mcp:disconnect-oauth", (_event, input) =>
    runSettingsOperation(async () => {
      await callEngineHost("mcpOAuthClear", {
        filePath: settingsPath(),
        serverName: validateName(input),
      });
      await protectSettingsFile();
      return listServers();
    }),
  );
}

async function runSettingsOperation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const result = settingsOperation.then(operation, operation);
  settingsOperation = result.catch(() => undefined);
  return result;
}

function settingsPath() {
  return mcpSettingsFile();
}

/**
 * The file as it is. One that cannot be read is moved aside (and the person
 * told, see `mcp:recovery`), never replaced by an empty list.
 */
function readSettings(): Promise<McpSettings> {
  return readMcpSettings(settingsPath(), {
    unreadable: "quarantine",
  }) as Promise<McpSettings>;
}

/** One change, read and written under the lock the engine host shares. */
function changeSettings(
  mutate: (settings: McpSettings) => McpSettings | void,
  options?: McpSettingsUpdateOptions,
): Promise<McpSettings> {
  return updateMcpSettings(settingsPath(), mutate, {
    unreadable: "quarantine",
    ...options,
  }) as Promise<McpSettings>;
}

/** Replaces the content with `settings` (atomic, backed up, never empty). */
function writeSettings(settings: McpSettings) {
  return changeSettings(() => settings);
}

async function protectSettingsFile() {
  if (process.platform !== "win32") await chmod(settingsPath(), 0o600);
}

async function listServers(settings?: McpSettings): Promise<McpServerConfig[]> {
  const servers = settings ?? (await readSettings());
  const statuses = new Map(
    (await safeOAuthStatuses()).map((status) => [status.serverName, status]),
  );
  return Object.entries(servers.mcpServers).map(([name, value]) =>
    deserializeServer(name, value, statuses.get(name)),
  );
}

function safeOAuthStatuses() {
  return callEngineHost("mcpOAuthStatuses", {
    filePath: settingsPath(),
  }).catch((): McpOAuthStatus[] => []);
}

function deserializeServer(
  name: string,
  value: Record<string, unknown>,
  oauth?: McpOAuthStatus,
): McpServerConfig {
  const nested = isRecord(value.transport) ? value.transport : value;
  const transport =
    nested.type === "streamableHttp" || nested.type === "sse"
      ? nested.type
      : "stdio";
  return validateServer({
    ...nested,
    disabled: cloudDisabled(value) ?? value.disabled === true,
    name,
    oauth: oauth ?? { configured: false, supported: transport !== "stdio" },
    requiresLocalSetup: localSetupRequired(value),
    timeout: value.timeout ?? nested.timeout,
    transport,
  });
}

function serializeServer(server: McpServerConfig): Record<string, unknown> {
  const common = { disabled: server.disabled, timeout: server.timeout };
  if (server.transport === "stdio") {
    return {
      ...common,
      type: "stdio",
      command: server.command,
      args: server.args,
      cwd: server.cwd,
      env: server.env,
    };
  }
  return {
    ...common,
    type: server.transport,
    url: server.url,
    headers: server.headers,
  };
}

function validateCloudServers(input: unknown): CloudMcpServerConfig[] {
  if (!Array.isArray(input) || input.length > 100)
    throw new Error("Invalid cloud MCP configuration");
  const names = new Set<string>();
  return input.map((value) => {
    if (!isRecord(value)) throw new Error("Invalid cloud MCP server");
    const name = validateName(value.name);
    if (names.has(name.toLocaleLowerCase()))
      throw new Error("Cloud MCP server names must be unique");
    names.add(name.toLocaleLowerCase());
    const transport = value.transport;
    const timeout = optionalTimeout(value.timeout);
    if (transport === "stdio") {
      const command = requiredString(value.command, "Command");
      if (/\s/.test(command))
        throw new Error("Cloud MCP commands cannot contain arguments");
      return {
        command,
        disabled: value.disabled === true,
        name,
        timeout,
        transport,
      };
    }
    if (transport !== "streamableHttp" && transport !== "sse")
      throw new Error("Invalid cloud MCP transport");
    const url = safeCloudUrl(requiredString(value.url, "URL"));
    return {
      disabled: value.disabled === true,
      name,
      timeout,
      transport,
      url,
    };
  });
}

function safeCloudUrl(value: string) {
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Cloud MCP URLs cannot contain credentials or parameters");
  }
  return url.toString();
}

function validateUserId(input: unknown) {
  if (typeof input !== "string" || !/^[0-9a-f-]{20,80}$/i.test(input))
    throw new Error("Invalid cloud user");
  return input;
}

function validateServer(input: unknown): McpServerConfig {
  if (!isRecord(input)) throw new Error("Invalid MCP server");
  const name = validateName(input.name);
  const transport = input.transport;
  if (
    transport !== "stdio" &&
    transport !== "streamableHttp" &&
    transport !== "sse"
  )
    throw new Error("Invalid MCP transport");
  const disabled = input.disabled === true;
  const oauth = validateOAuthStatus(input.oauth, transport !== "stdio");
  const requiresLocalSetup = input.requiresLocalSetup === true;
  const timeout = optionalTimeout(input.timeout);
  if (transport === "stdio") {
    const command = requiredString(input.command, "Command");
    return {
      name,
      oauth,
      requiresLocalSetup,
      timeout,
      transport,
      disabled,
      command,
      args: stringArray(input.args),
      cwd: optionalString(input.cwd),
      env: stringRecord(input.env),
    };
  }
  const url = requiredString(input.url, "URL");
  try {
    new URL(url);
  } catch {
    throw new Error("Enter a valid server URL");
  }
  return {
    name,
    oauth,
    requiresLocalSetup,
    timeout,
    transport,
    disabled,
    url,
    headers: stringRecord(input.headers),
  };
}

function validateOAuthStatus(input: unknown, supported: boolean) {
  if (!isRecord(input)) return { configured: false, supported };
  return {
    configured: supported && input.configured === true,
    lastAuthenticatedAt:
      typeof input.lastAuthenticatedAt === "number"
        ? input.lastAuthenticatedAt
        : undefined,
    lastError:
      typeof input.lastError === "string" ? input.lastError : undefined,
    supported,
  };
}

function sameEndpoint(
  existing: Record<string, unknown>,
  server: McpServerConfig,
) {
  const transport = isRecord(existing.transport)
    ? existing.transport
    : existing;
  if (server.transport === "stdio") return false;
  return transport.type === server.transport && transport.url === server.url;
}

function validateName(value: unknown) {
  const name = requiredString(value, "Name");
  if (name.length > 80) throw new Error("Name is too long");
  return name;
}
function hasNameConflict(
  settings: McpSettings,
  name: string,
  originalName?: string,
) {
  const normalizedName = name.toLocaleLowerCase();
  return Object.keys(settings.mcpServers).some(
    (existingName) =>
      existingName !== originalName &&
      existingName.toLocaleLowerCase() === normalizedName,
  );
}
function requiredString(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label} is required`);
  return value.trim();
}
function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function optionalTimeout(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 3600
  ) {
    throw new Error(
      "MCP timeout must be a whole number between 1 and 3600 seconds",
    );
  }
  return value;
}
function stringArray(value: unknown) {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}
function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (!entries.every(([key, item]) => key.trim() && typeof item === "string"))
    throw new Error("Invalid key/value entry");
  return Object.fromEntries(entries) as Record<string, string>;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
