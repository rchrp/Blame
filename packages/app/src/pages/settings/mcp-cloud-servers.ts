import type { CloudMcpServer } from "@/context/cloud-auth"
import type { McpLocalParts, McpServerConfig } from "@/context/platform"

/**
 * What goes to the person's account for the MCP servers they keep there.
 *
 * - A server marked "this device only" is never in the list.
 * - A server that came from the account and was not completed here
 *   (`requiresLocalSetup`) is not rebuilt from this device: the account's own
 *   entry stays as it is.
 * - Arguments, environment variables and headers go only for a server the
 *   person chose to sync with its secrets; otherwise only their names do, so
 *   another device can say what it still needs.
 */
export function cloudServerFor(
  server: McpServerConfig,
  options: { forgetSecrets?: boolean } = {}
): CloudMcpServer {
  const shape = {
    disabled: server.disabled,
    name: server.name,
    timeout: server.timeout,
    transport: server.transport,
  }
  const base: CloudMcpServer =
    server.transport === "stdio"
      ? { ...shape, command: server.command }
      : { ...shape, url: syncableUrl(server.url) }
  if (server.syncSecrets) {
    return {
      ...base,
      localParts: {},
      secrets: secretsOf(server),
      secretsSynced: true,
    }
  }
  return {
    ...base,
    localParts: localPartsOf(server),
    ...(options.forgetSecrets ? { secretsSynced: false } : {}),
  }
}

/**
 * The list to save to the account after a change made here: the account's own
 * entries stay unless this change removed, renamed or switched them, and the
 * servers that sync from this device replace their entries.
 */
export function nextCloudServers(input: {
  current: CloudMcpServer[]
  local: McpServerConfig[]
  /** Names removed, renamed or switched to "this device only" by the change. */
  dropped?: string[]
  /** Names whose "sync secrets" choice the person turned off. */
  forgetSecrets?: string[]
}): CloudMcpServer[] {
  const key = (name: string) => name.toLocaleLowerCase()
  const dropped = new Set((input.dropped ?? []).map(key))
  const forget = new Set((input.forgetSecrets ?? []).map(key))
  const syncing = input.local.filter(
    (server) =>
      server.sync !== "device" &&
      canSync(server).ok &&
      !server.requiresLocalSetup
  )
  const syncingNames = new Set(syncing.map((server) => key(server.name)))
  return [
    ...input.current.filter(
      (entry) =>
        !dropped.has(key(entry.name)) && !syncingNames.has(key(entry.name))
    ),
    ...syncing.map((server) =>
      cloudServerFor(server, { forgetSecrets: forget.has(key(server.name)) })
    ),
  ]
}

/** Whether a server may leave this device at all, and why not. */
export function canSync(
  server: Pick<McpServerConfig, "transport" | "url">
): { ok: true } | { ok: false; reason: string } {
  if (server.transport === "stdio") return { ok: true }
  if (!syncableUrl(server.url)) {
    return {
      ok: false,
      reason:
        "Its address contains a key or parameters, so it stays on this device.",
    }
  }
  return { ok: true }
}

/** What the person sees for a server from their account that needs more here. */
export function describeMissing(parts?: McpLocalParts) {
  if (!parts) return "its arguments and secrets"
  const items = [
    parts.args ? "its arguments" : undefined,
    parts.cwd ? "its working directory" : undefined,
    ...(parts.env ?? []),
    ...(parts.headers ?? []),
  ].filter(Boolean)
  return items.length ? items.join(", ") : "its arguments and secrets"
}

function secretsOf(server: McpServerConfig) {
  return {
    ...(server.args?.length ? { args: server.args } : {}),
    ...(server.cwd ? { cwd: server.cwd } : {}),
    ...(server.env && Object.keys(server.env).length
      ? { env: server.env }
      : {}),
    ...(server.headers && Object.keys(server.headers).length
      ? { headers: server.headers }
      : {}),
  }
}

function localPartsOf(server: McpServerConfig): McpLocalParts {
  return {
    ...(server.args?.length ? { args: true } : {}),
    ...(server.cwd ? { cwd: true } : {}),
    ...(server.env && Object.keys(server.env).length
      ? { env: Object.keys(server.env) }
      : {}),
    ...(server.headers && Object.keys(server.headers).length
      ? { headers: Object.keys(server.headers) }
      : {}),
  }
}

function syncableUrl(value: string | undefined) {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if (url.username || url.password || url.search || url.hash) return undefined
    return url.toString()
  } catch {
    return undefined
  }
}
