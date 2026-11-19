import type { McpOAuthStatus } from "@blame/agent-runtime";
import type { CloudMcpServerConfig, McpServerConfig } from "@blame/app";
import { ipcMain } from "electron";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  cloudDisabled,
  cloudOwner,
  completedCloudMetadata,
  localSetupRequired,
  mergeCloudServers,
  type McpSettings,
} from "./mcp-cloud-sync";
import { runOnAgentRuntime } from "./agent-ipc";

let settingsOperation: Promise<unknown> = Promise.resolve();
let authorizationRunning = false;

export function registerMcpIpcHandlers() {
  ipcMain.handle("mcp:list", () =>
    runSettingsOperation(async () => listServers()),
  );
  ipcMain.handle(
    "mcp:merge-cloud",
    (_event, userIdInput, input, adoptLocalInput) =>
      runSettingsOperation(async () => {
        const userId = validateUserId(userIdInput);
        const adoptLocal = adoptLocalInput === true;
        const cloudServers = validateCloudServers(input);
        const settings = await readSettings();
        const merged = mergeCloudServers(
          settings,
          userId,
          cloudServers,
          adoptLocal,
        );
        await writeSettings(merged);
        return listServers(merged);
      }),
  );
  ipcMain.handle("mcp:detach-cloud", (_event, userIdInput) =>
    runSettingsOperation(async () => {
      const userId = validateUserId(userIdInput);
      const settings = await readSettings();
      settings.mcpServers = Object.fromEntries(
        Object.entries(settings.mcpServers).filter(
          ([, server]) => cloudOwner(server) !== userId,
        ),
      );
      await writeSettings(settings);
      return listServers(settings);
    }),
  );
  ipcMain.handle("mcp:save", (_event, input, previousName) =>
    runSettingsOperation(async () => {
      const server = validateServer(input);
      const settings = await readSettings();
      const originalName =
        typeof previousName === "string"
          ? validateName(previousName)
          : undefined;
      const existing = settings.mcpServers[originalName ?? server.name];
      if (originalName && !existing) throw new Error("MCP server not found");
      if (hasNameConflict(settings, server.name, originalName)) {
        throw new Error("An MCP server with this name already exists");
      }
      if (originalName && originalName !== server.name) {
        delete settings.mcpServers[originalName];
      }
      const preserveOAuth = existing && sameEndpoint(existing, server);
      settings.mcpServers[server.name] = {
        ...(existing ?? {}),
        ...serializeServer(server),
        metadata: completedCloudMetadata(existing),
        ...(preserveOAuth && existing.oauth
          ? { oauth: existing.oauth }
          : { oauth: undefined }),
      };
      await writeSettings(settings);
      return listServers(settings);
    }),
  );
  ipcMain.handle("mcp:remove", (_event, input) =>
    runSettingsOperation(async () => {
      const name = validateName(input);
      const settings = await readSettings();
      delete settings.mcpServers[name];
      await writeSettings(settings);
      return listServers(settings);
    }),
  );
  ipcMain.handle("mcp:set-enabled", (_event, input, enabled) =>
    runSettingsOperation(async () => {
      const name = validateName(input);
      if (typeof enabled !== "boolean")
        throw new Error("Invalid enabled state");
      const settings = await readSettings();
      const server = settings.mcpServers[name];
      if (!server) throw new Error("MCP server not found");
      if (localSetupRequired(server))
        throw new Error("Complete this MCP server setup before enabling it");
      server.disabled = !enabled;
      await writeSettings(settings);
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
        await runOnAgentRuntime("mcpOAuth.authorize", {
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
      await runOnAgentRuntime("mcpOAuth.clear", {
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
  const explicit = process.env.CLINE_MCP_SETTINGS_PATH?.trim();
  if (explicit) return explicit;
  const dataDir =
    process.env.CLINE_DATA_DIR?.trim() || join(homedir(), ".cline", "data");
  return join(dataDir, "settings", "cline_mcp_settings.json");
}

async function readSettings(): Promise<McpSettings> {
  try {
    const parsed: unknown = JSON.parse(await readFile(settingsPath(), "utf8"));
    if (!isRecord(parsed) || !isRecord(parsed.mcpServers))
      throw new Error("Invalid MCP settings file");
    return { ...parsed, mcpServers: { ...parsed.mcpServers } } as McpSettings;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT")
      return { mcpServers: {} };
    throw error;
  }
}

async function writeSettings(settings: McpSettings) {
  const path = settingsPath();
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
  await protectSettingsFile();
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
  return runOnAgentRuntime<McpOAuthStatus[]>("mcpOAuth.statuses", {
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
function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
