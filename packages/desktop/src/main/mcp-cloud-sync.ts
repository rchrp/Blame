import type { CloudMcpServerConfig } from "@blame/app";

export type McpSettingsServer = Record<string, unknown>;
export type McpSettings = {
  mcpServers: Record<string, McpSettingsServer>;
};

// What a server's `metadata` may hold. Older versions wrote the first three;
// they are read as they were and never dropped.
const CLOUD_USER_ID = "blameCloudUserId";
const LOCAL_SETUP_REQUIRED = "blameCloudLocalSetupRequired";
const CLOUD_DISABLED = "blameCloudDisabled";
// The person's choice for this server: "account" (its shape is saved to the
// account) or "device" (it never leaves this computer). Without it, the server
// follows what it always did: it syncs when signed in.
const SYNC_MODE = "blameSync";
// The shape the account and this computer last agreed on: tells a change made
// here from a change made on another device.
const SYNC_BASE = "blameSyncBase";

export type McpSyncMode = "account" | "device";

/**
 * Brings the account's servers to this computer, and never takes anything
 * away from it: a server configured here keeps its arguments, environment,
 * headers, working directory, OAuth state and enabled flag whatever the
 * account holds, whoever signed in before, and whether or not the server was
 * tagged as synced. Only what the person never set up here (a server that
 * came from the account and was not completed) follows the account.
 */
export function mergeCloudServers(
  settings: McpSettings,
  userId: string,
  cloudServers: CloudMcpServerConfig[],
): McpSettings {
  const merged: Record<string, McpSettingsServer> = {
    ...settings.mcpServers,
  };
  const inCloud = new Set<string>();
  for (const cloud of cloudServers) {
    const name = localName(merged, cloud.name);
    inCloud.add(name);
    const local = merged[name];
    if (!local) {
      merged[cloud.name] = placeholder(cloud, userId);
      continue;
    }
    if (syncMode(local) === "device") continue;
    merged[name] = mergeCloudServer(local, cloud, userId);
  }
  for (const [name, local] of Object.entries(merged)) {
    if (inCloud.has(name) || !wasSynced(local)) continue;
    // Gone from the account. Nothing set up here is lost with it: a server
    // that was never completed goes, one that works here stays on this device.
    if (localSetupRequired(local)) delete merged[name];
    else merged[name] = withMetadata(local, { [SYNC_MODE]: "device" });
  }
  return { ...settings, mcpServers: merged };
}

/**
 * Signing out of an account removes what the account put here and the person
 * never set up. A configured server stays: it is theirs, on this computer.
 */
export function detachCloudServers(
  settings: McpSettings,
  userId: string,
): McpSettings {
  return {
    ...settings,
    mcpServers: Object.fromEntries(
      Object.entries(settings.mcpServers).filter(
        ([, server]) =>
          !(cloudOwner(server) === userId && localSetupRequired(server)),
      ),
    ),
  };
}

export function syncMode(server: McpSettingsServer): McpSyncMode {
  return serverMetadata(server)?.[SYNC_MODE] === "device"
    ? "device"
    : "account";
}

export function cloudOwner(server: McpSettingsServer) {
  const metadata = serverMetadata(server);
  return typeof metadata?.[CLOUD_USER_ID] === "string"
    ? metadata[CLOUD_USER_ID]
    : undefined;
}

export function localSetupRequired(server: McpSettingsServer) {
  return serverMetadata(server)?.[LOCAL_SETUP_REQUIRED] === true;
}

export function cloudDisabled(server: McpSettingsServer) {
  if (!localSetupRequired(server)) return undefined;
  const disabled = serverMetadata(server)?.[CLOUD_DISABLED];
  return typeof disabled === "boolean" ? disabled : true;
}

/** Metadata after the person completed or edited a server here. */
export function completedCloudMetadata(server?: McpSettingsServer) {
  const metadata = server ? serverMetadata(server) : undefined;
  if (!metadata) return undefined;
  const completedMetadata = { ...metadata };
  delete completedMetadata[LOCAL_SETUP_REQUIRED];
  delete completedMetadata[CLOUD_DISABLED];
  return Object.keys(completedMetadata).length ? completedMetadata : undefined;
}

/** Metadata with the person's sync choice applied. */
export function metadataWithSyncMode(
  metadata: Record<string, unknown> | undefined,
  mode: McpSyncMode,
) {
  return { ...metadata, [SYNC_MODE]: mode === "device" ? "device" : undefined };
}

type Shape = {
  command?: string;
  disabled: boolean;
  timeout?: number;
  transport: "stdio" | "streamableHttp" | "sse";
  url?: string;
};

function mergeCloudServer(
  local: McpSettingsServer,
  cloud: CloudMcpServerConfig,
  userId: string,
): McpSettingsServer {
  if (localSetupRequired(local)) {
    // Still what the account sent: it follows the account.
    return placeholder(cloud, userId, local);
  }
  const here = localShape(local);
  const there = cloudShape(cloud);
  const base = baseShape(local);
  let next = local;
  if (!sameShape(here, there) && base && sameShape(here, base)) {
    // Changed on another device, not here: take the change, keep the rest of
    // what is set up here. A change of kind (command to URL) cannot keep it.
    if ((here.transport === "stdio") === (there.transport === "stdio")) {
      next = { ...local, ...serializeShape(there) };
    }
  }
  const agreed = sameShape(localShape(next), there);
  return withMetadata(next, {
    [CLOUD_USER_ID]: userId,
    [SYNC_BASE]: agreed ? there : base,
  });
}

function placeholder(
  cloud: CloudMcpServerConfig,
  userId: string,
  previous?: McpSettingsServer,
): McpSettingsServer {
  return {
    ...serializeShape({ ...cloudShape(cloud), disabled: true }),
    metadata: {
      ...(previous ? serverMetadata(previous) : {}),
      [CLOUD_USER_ID]: userId,
      [LOCAL_SETUP_REQUIRED]: true,
      [CLOUD_DISABLED]: cloud.disabled,
      [SYNC_BASE]: cloudShape(cloud),
    },
  };
}

function withMetadata(
  server: McpSettingsServer,
  changes: Record<string, unknown>,
): McpSettingsServer {
  return {
    ...server,
    metadata: { ...serverMetadata(server), ...changes },
  };
}

/** Synced before: tagged for an account, or marked as account-synced. */
function wasSynced(server: McpSettingsServer) {
  const metadata = serverMetadata(server);
  return (
    syncMode(server) === "account" &&
    (typeof metadata?.[CLOUD_USER_ID] === "string" ||
      isRecord(metadata?.[SYNC_BASE]))
  );
}

function localName(servers: Record<string, McpSettingsServer>, name: string) {
  if (servers[name]) return name;
  const lower = name.toLocaleLowerCase();
  return (
    Object.keys(servers).find((key) => key.toLocaleLowerCase() === lower) ??
    name
  );
}

function localShape(server: McpSettingsServer): Shape {
  const transport = isRecord(server.transport) ? server.transport : server;
  const kind =
    transport.type === "streamableHttp" || transport.type === "sse"
      ? transport.type
      : "stdio";
  const timeout = server.timeout ?? transport.timeout;
  return {
    disabled: server.disabled === true,
    ...(typeof timeout === "number" ? { timeout } : {}),
    transport: kind,
    ...(kind === "stdio"
      ? typeof transport.command === "string"
        ? { command: transport.command }
        : {}
      : { url: normalizedUrl(transport.url) }),
  };
}

function cloudShape(cloud: CloudMcpServerConfig): Shape {
  return {
    disabled: cloud.disabled,
    ...(cloud.timeout ? { timeout: cloud.timeout } : {}),
    transport: cloud.transport,
    ...(cloud.transport === "stdio"
      ? { command: cloud.command }
      : { url: normalizedUrl(cloud.url) }),
  };
}

function baseShape(server: McpSettingsServer): Shape | undefined {
  const base = serverMetadata(server)?.[SYNC_BASE];
  if (!isRecord(base)) return undefined;
  const transport = base.transport;
  if (
    transport !== "stdio" &&
    transport !== "streamableHttp" &&
    transport !== "sse"
  )
    return undefined;
  return {
    disabled: base.disabled === true,
    transport,
    ...(typeof base.command === "string" ? { command: base.command } : {}),
    ...(typeof base.url === "string" ? { url: base.url } : {}),
    ...(typeof base.timeout === "number" ? { timeout: base.timeout } : {}),
  };
}

function sameShape(left: Shape, right: Shape) {
  return (
    left.transport === right.transport &&
    left.disabled === right.disabled &&
    (left.timeout ?? undefined) === (right.timeout ?? undefined) &&
    (left.transport === "stdio"
      ? left.command === right.command
      : left.url === right.url)
  );
}

function serializeShape(shape: Shape): McpSettingsServer {
  const common = { disabled: shape.disabled, timeout: shape.timeout };
  return shape.transport === "stdio"
    ? { ...common, command: shape.command, type: "stdio" }
    : { ...common, type: shape.transport, url: shape.url };
}

function normalizedUrl(value: unknown) {
  if (typeof value !== "string") return undefined;
  try {
    return new URL(value).toString();
  } catch {
    return undefined;
  }
}

function serverMetadata(server: McpSettingsServer) {
  return isRecord(server.metadata) ? server.metadata : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
