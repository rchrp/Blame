import type {
  CloudMcpServerConfig,
  McpLocalParts,
  McpSecretValues,
} from "@blame/app";
import { createHash } from "node:crypto";

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
// The person also keeps this server's arguments and secrets in their account.
const SYNC_SECRETS = "blameSyncSecrets";
// A digest of those values when the account and this computer last agreed.
const SECRETS_BASE = "blameSecretsBase";
// What the account said still has to be added on this device (names only).
const CLOUD_MISSING = "blameCloudMissing";

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
    if (belongsToAnotherAccount(local, userId)) {
      // Set up under another account on this computer: it stays here, and
      // is never uploaded to this one.
      merged[name] = keptOnThisDevice(local);
      continue;
    }
    merged[name] = mergeCloudServer(local, cloud, userId);
  }
  for (const [name, local] of Object.entries(merged)) {
    if (belongsToAnotherAccount(local, userId) && !localSetupRequired(local)) {
      merged[name] = keptOnThisDevice(local);
      continue;
    }
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
      Object.entries(settings.mcpServers)
        .filter(
          ([, server]) =>
            !(cloudOwner(server) === userId && localSetupRequired(server)),
        )
        // What works here stays, and from now on stays on this device: the
        // next account to sign in never receives it.
        .map(([name, server]) => [
          name,
          cloudOwner(server) === userId ? keptOnThisDevice(server) : server,
        ]),
    ),
  };
}

function belongsToAnotherAccount(server: McpSettingsServer, userId: string) {
  const owner = cloudOwner(server);
  return owner !== undefined && owner !== userId;
}

function keptOnThisDevice(server: McpSettingsServer): McpSettingsServer {
  if (syncMode(server) === "device" && !syncsSecrets(server)) return server;
  return withMetadata(server, {
    [SYNC_MODE]: "device",
    [SYNC_SECRETS]: undefined,
    [SECRETS_BASE]: undefined,
  });
}

export function syncMode(server: McpSettingsServer): McpSyncMode {
  return serverMetadata(server)?.[SYNC_MODE] === "device"
    ? "device"
    : "account";
}

/** Whether the person chose to keep this server's secrets in their account. */
export function syncsSecrets(server: McpSettingsServer) {
  return serverMetadata(server)?.[SYNC_SECRETS] === true;
}

/** What the account said this server still needs on this device. */
export function missingLocalParts(
  server: McpSettingsServer,
): McpLocalParts | undefined {
  if (!localSetupRequired(server)) return undefined;
  const missing = serverMetadata(server)?.[CLOUD_MISSING];
  return isRecord(missing) ? (missing as McpLocalParts) : undefined;
}

/** The secret-bearing parts of a server, as this computer holds them. */
export function localSecrets(server: McpSettingsServer): McpSecretValues {
  const transport = isRecord(server.transport) ? server.transport : server;
  const remote =
    transport.type === "streamableHttp" || transport.type === "sse";
  const strings = (value: unknown) =>
    isRecord(value)
      ? Object.fromEntries(
          Object.entries(value).filter(([, item]) => typeof item === "string"),
        )
      : undefined;
  if (remote) {
    const headers = strings(transport.headers);
    return headers && Object.keys(headers).length
      ? { headers: headers as Record<string, string> }
      : {};
  }
  const env = strings(transport.env);
  return {
    ...(Array.isArray(transport.args) && transport.args.length
      ? { args: transport.args.filter((a) => typeof a === "string") }
      : {}),
    ...(typeof transport.cwd === "string" && transport.cwd
      ? { cwd: transport.cwd }
      : {}),
    ...(env && Object.keys(env).length
      ? { env: env as Record<string, string> }
      : {}),
  };
}

/** The names of what a synced server keeps only on this computer. */
export function localPartsOf(server: McpSettingsServer): McpLocalParts {
  const secrets = localSecrets(server);
  return {
    ...(secrets.args ? { args: true } : {}),
    ...(secrets.cwd ? { cwd: true } : {}),
    ...(secrets.env ? { env: Object.keys(secrets.env) } : {}),
    ...(secrets.headers ? { headers: Object.keys(secrets.headers) } : {}),
  };
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
  delete completedMetadata[CLOUD_MISSING];
  return Object.keys(completedMetadata).length ? completedMetadata : undefined;
}

/** Metadata with the person's sync choice applied. */
export function metadataWithSyncChoice(
  metadata: Record<string, unknown> | undefined,
  choice: { mode: McpSyncMode; secrets: boolean },
) {
  const next: Record<string, unknown> = {
    ...metadata,
    [SYNC_MODE]: choice.mode === "device" ? "device" : undefined,
    // Secrets only ever go with a server that syncs at all.
    [SYNC_SECRETS]:
      choice.mode === "account" && choice.secrets ? true : undefined,
  };
  if (!next[SYNC_SECRETS]) delete next[SECRETS_BASE];
  return Object.keys(next).length ? next : undefined;
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
  return applyCloudSecrets(
    withMetadata(next, {
      [CLOUD_USER_ID]: userId,
      [SYNC_BASE]: agreed ? there : base,
    }),
    cloud,
  );
}

/**
 * The account's synced secrets reach a server only where this computer has
 * none (or has not changed them since they last agreed): what is set up here
 * is never replaced by a different value.
 */
function applyCloudSecrets(
  local: McpSettingsServer,
  cloud: CloudMcpServerConfig,
): McpSettingsServer {
  const secrets = cloud.secrets;
  const here = localSecrets(local);
  const unchangedHere =
    syncsSecrets(local) &&
    serverMetadata(local)?.[SECRETS_BASE] === digest(here);
  if (!secrets) {
    // The account holds none any more: another device turned the sharing
    // off. This one agreed to it before and has not changed them since, so it
    // stops sharing too (its own values stay); otherwise its next upload
    // would put them back.
    if (!unchangedHere) return local;
    return withMetadata(local, {
      [SYNC_SECRETS]: undefined,
      [SECRETS_BASE]: undefined,
    });
  }
  const next: McpSettingsServer = { ...local };
  let changed = false;
  if (!here.args || unchangedHere) {
    if (secrets.args) next.args = secrets.args;
    else if (here.args) delete next.args;
    changed = changed || Boolean(secrets.args) || Boolean(here.args);
  }
  if (!here.cwd || unchangedHere) {
    if (secrets.cwd) next.cwd = secrets.cwd;
    else if (here.cwd) delete next.cwd;
    changed = changed || Boolean(secrets.cwd) || Boolean(here.cwd);
  }
  for (const key of ["env", "headers"] as const) {
    if (here[key] && !unchangedHere) continue;
    const given = secrets[key];
    if (given) next[key] = given;
    else if (here[key]) delete next[key];
    changed = changed || Boolean(given) || Boolean(here[key]);
  }
  const agreed = digest(localSecrets(next)) === digest(secrets);
  // Sharing starts here only once both sides hold the same values: a device
  // with its own different secrets never uploads them by accident.
  if (!agreed) return changed ? { ...next } : local;
  return withMetadata(next, {
    [SYNC_SECRETS]: true,
    [SECRETS_BASE]: digest(secrets),
  });
}

function digest(secrets: McpSecretValues) {
  const sorted = (record?: Record<string, string>) =>
    record
      ? Object.fromEntries(
          Object.entries(record).sort(([a], [b]) => a.localeCompare(b)),
        )
      : undefined;
  return createHash("sha256")
    .update(
      JSON.stringify({
        args: secrets.args?.length ? secrets.args : undefined,
        cwd: secrets.cwd || undefined,
        env: sorted(secrets.env),
        headers: sorted(secrets.headers),
      }),
    )
    .digest("hex");
}

/**
 * A server the account has and this computer does not. It is usable at once
 * when the account holds everything it needs (its secrets, or nothing needed
 * outside the shape); otherwise it waits, turned off, for the person to add
 * what only the other device had.
 */
function placeholder(
  cloud: CloudMcpServerConfig,
  userId: string,
  previous?: McpSettingsServer,
): McpSettingsServer {
  const metadata: Record<string, unknown> = {
    ...(previous ? serverMetadata(previous) : {}),
    [CLOUD_USER_ID]: userId,
    [SYNC_BASE]: cloudShape(cloud),
  };
  const usable = () => {
    delete metadata[LOCAL_SETUP_REQUIRED];
    delete metadata[CLOUD_DISABLED];
    delete metadata[CLOUD_MISSING];
  };
  if (cloud.secrets) {
    usable();
    return {
      ...serializeShape(cloudShape(cloud)),
      ...cloud.secrets,
      metadata: {
        ...metadata,
        [SYNC_SECRETS]: true,
        [SECRETS_BASE]: digest(cloud.secrets),
      },
    };
  }
  const missing = cloud.localParts;
  if (missing && !needsSomething(missing)) {
    usable();
    return { ...serializeShape(cloudShape(cloud)), metadata };
  }
  return {
    ...serializeShape({ ...cloudShape(cloud), disabled: true }),
    metadata: {
      ...metadata,
      [LOCAL_SETUP_REQUIRED]: true,
      [CLOUD_DISABLED]: cloud.disabled,
      ...(missing ? { [CLOUD_MISSING]: missing } : {}),
    },
  };
}

function needsSomething(parts: McpLocalParts) {
  return Boolean(
    parts.args || parts.cwd || parts.env?.length || parts.headers?.length,
  );
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
