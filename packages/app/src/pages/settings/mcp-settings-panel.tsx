import * as React from "react"
import {
  KeyRoundIcon,
  PencilIcon,
  PlusIcon,
  ServerIcon,
  Trash2Icon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { SyncBadge } from "@/components/sync-choice"
import { useCloudAuth } from "@/context/cloud-auth"
import {
  usePlatform,
  type McpServerConfig,
  type McpSettingsRecovery,
  type McpTransport,
} from "@/context/platform"
import { canSync, describeMissing, nextCloudServers } from "./mcp-cloud-servers"
import { McpServerForm, Notice, errorMessage } from "./mcp-server-form"

export function McpSettingsPanel() {
  const client = usePlatform().mcp
  const cloud = useCloudAuth()
  const cloudMcpConfiguration = cloud.mcpConfiguration
  const cloudStatus = cloud.status
  const cloudUserId = cloud.user?.id
  // Without an account there is nothing to choose: everything stays here.
  const syncAvailable = cloud.mode === "account"
  const updateCloudMcpConfiguration = cloud.updateMcpConfiguration
  const [servers, setServers] = React.useState<McpServerConfig[]>([])
  const [adding, setAdding] = React.useState(false)
  const [editingName, setEditingName] = React.useState<string>()
  const [loading, setLoading] = React.useState(Boolean(client))
  const [error, setError] = React.useState<string>()
  const [recovery, setRecovery] = React.useState<McpSettingsRecovery | null>()

  React.useEffect(() => {
    if (!client) return
    void client
      .list()
      .then(async (localServers) => {
        if (
          !syncAvailable ||
          cloudStatus !== "authenticated" ||
          !cloudUserId ||
          cloudMcpConfiguration === undefined
        ) {
          return setServers(localServers)
        }
        if (cloudMcpConfiguration) {
          return setServers(
            await client.mergeCloud(cloudUserId, cloudMcpConfiguration.servers)
          )
        }
        const first = await updateCloudMcpConfiguration((current) =>
          nextCloudServers({ current, local: localServers })
        )
        setServers(await client.mergeCloud(cloudUserId, first))
      })
      .then(() => client.recovery())
      .then((notice) => setRecovery(notice ?? null))
      .catch((reason) => setError(errorMessage(reason)))
      .finally(() => setLoading(false))
  }, [
    client,
    cloudMcpConfiguration,
    cloudStatus,
    cloudUserId,
    updateCloudMcpConfiguration,
    syncAvailable,
  ])

  /**
   * Runs a change on this device, then tells the account: its own entries stay
   * unless the change removed, renamed or switched them.
   */
  async function update(
    action: () => Promise<McpServerConfig[]>,
    cloudChange: { dropped?: string[]; forgetSecrets?: string[] } = {}
  ) {
    setError(undefined)
    let updated: McpServerConfig[]
    try {
      updated = await action()
    } catch (reason) {
      setError(errorMessage(reason))
      return false
    }
    setServers(updated)
    if (
      syncAvailable &&
      cloud.status === "authenticated" &&
      cloudMcpConfiguration !== undefined
    ) {
      try {
        await cloud.updateMcpConfiguration((current) =>
          nextCloudServers({ ...cloudChange, current, local: updated })
        )
      } catch (reason) {
        setError(
          `Saved on this device. Cloud sync failed: ${errorMessage(reason)}`
        )
      }
    }
    return true
  }

  return (
    <div className="flex flex-col gap-5 py-6">
      <section>
        <div className="mb-3">
          <h3 className="text-sm font-semibold">Server connections</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Give Blame agents access to external tools and context.
          </p>
        </div>
        <div className="flex flex-col gap-3 border-b py-4 sm:flex-row sm:items-center sm:justify-between">
          <McpServerSummary
            available={Boolean(client)}
            loading={loading}
            servers={servers}
          />
          <Button
            type="button"
            disabled={!client || adding || Boolean(editingName)}
            onClick={() => {
              setEditingName(undefined)
              setAdding(true)
            }}
          >
            <PlusIcon />
            Add server
          </Button>
        </div>

        {!client && (
          <Notice>
            Server connections are available in the Blame desktop app.
          </Notice>
        )}
        {error && <Notice error>{error}</Notice>}
        {recovery && client && (
          <Notice>
            <span className="flex-1">
              {recovery.restoredFrom
                ? "Your saved servers file could not be read, so Blame brought back the last good copy."
                : "Your saved servers file could not be read, so Blame set it aside and started a new list."}{" "}
              The original is kept next to it, named{" "}
              <code className="break-all">
                {recovery.movedTo.split(/[\\/]/).pop()}
              </code>
              .
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setRecovery(null)
                void client.dismissRecovery()
              }}
            >
              Got it
            </Button>
          </Notice>
        )}
        {adding && client && (
          <McpServerForm
            syncAvailable={syncAvailable}
            onCancel={() => setAdding(false)}
            onSave={async (server) => {
              const saved = await update(() => client.save(server))
              if (saved) setAdding(false)
              return saved
            }}
          />
        )}

        <div>
          {!loading && client && servers.length === 0 && !adding && (
            <div className="border-b py-10 text-center">
              <ServerIcon className="mx-auto size-6 text-muted-foreground" />
              <p className="mt-3 text-sm font-medium">No MCP servers added</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Connect one to make its tools available during agent work.
              </p>
            </div>
          )}
          {servers.map((server) =>
            editingName === server.name && client ? (
              <McpServerForm
                key={server.name}
                server={server}
                syncAvailable={syncAvailable}
                onCancel={() => setEditingName(undefined)}
                onSave={async (updatedServer) => {
                  const saved = await update(
                    () => client.save(updatedServer, server.name),
                    {
                      // Renamed or switched to this device: the account's
                      // copy under the old name goes.
                      dropped: [server.name],
                      forgetSecrets:
                        server.syncSecrets && !updatedServer.syncSecrets
                          ? [updatedServer.name]
                          : [],
                    }
                  )
                  if (saved) setEditingName(undefined)
                  return saved
                }}
              />
            ) : (
              <McpServerRow
                key={server.name}
                server={server}
                syncAvailable={syncAvailable}
                onEdit={() => {
                  setAdding(false)
                  setEditingName(server.name)
                }}
                onToggle={(enabled) =>
                  client &&
                  void update(() => client.setEnabled(server.name, enabled))
                }
                onRemove={() =>
                  client &&
                  void update(() => client.remove(server.name), {
                    dropped: [server.name],
                  })
                }
                onAuthorize={() =>
                  client
                    ? update(() => client.authorize(server.name))
                    : Promise.resolve(false)
                }
                onDisconnectOAuth={() =>
                  client
                    ? update(() => client.disconnectOAuth(server.name))
                    : Promise.resolve(false)
                }
              />
            )
          )}
        </div>
      </section>
    </div>
  )
}

function McpServerSummary({
  available,
  loading,
  servers,
}: {
  available: boolean
  loading: boolean
  servers: McpServerConfig[]
}) {
  if (!available) return <McpStatusText title="Desktop app required" />
  if (loading) return <McpStatusText title="Loading servers" />
  const connected = servers.filter(
    (server) => !server.disabled && !server.requiresLocalSetup
  ).length
  const setupRequired = servers.filter(
    (server) => server.requiresLocalSetup
  ).length
  const status = [
    `${connected} connected server${connected === 1 ? "" : "s"}`,
    setupRequired
      ? `${setupRequired} to finish setting up on this device`
      : undefined,
  ]
    .filter(Boolean)
    .join(" · ")
  return <McpStatusText title={status} success={connected > 0} />
}

function McpStatusText({
  success = false,
  title,
}: {
  success?: boolean
  title: string
}) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span
        className={`size-2 rounded-full ${success ? "bg-emerald-500" : "bg-muted-foreground"}`}
      />
      <span className="font-medium">{title}</span>
    </div>
  )
}

function McpServerRow({
  server,
  syncAvailable,
  onAuthorize,
  onDisconnectOAuth,
  onEdit,
  onRemove,
  onToggle,
}: {
  server: McpServerConfig
  syncAvailable: boolean
  onAuthorize(): Promise<boolean>
  onDisconnectOAuth(): Promise<boolean>
  onEdit(): void
  onRemove(): void
  onToggle(enabled: boolean): void
}) {
  const [authorizing, setAuthorizing] = React.useState(false)
  const endpoint =
    server.transport === "stdio"
      ? [server.command, ...(server.args ?? [])].join(" ")
      : server.url
  return (
    <div className="flex flex-col gap-3 border-b py-4 last:border-b-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
          <ServerIcon className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{server.name}</span>
            {syncAvailable && !server.requiresLocalSetup && (
              <SyncBadge
                mode={
                  server.sync === "device" || !canSync(server).ok
                    ? "device"
                    : "account"
                }
                title={
                  server.syncSecrets && server.sync !== "device"
                    ? "Saved in your account, with its arguments and secrets."
                    : undefined
                }
                onClick={onEdit}
              />
            )}
          </div>
          <p
            className="truncate text-sm text-muted-foreground"
            title={endpoint}
          >
            {server.requiresLocalSetup
              ? "From your account"
              : server.disabled
                ? "Disabled"
                : transportLabel(server.transport)}{" "}
            · {endpoint}
          </p>
          {server.requiresLocalSetup && (
            <p className="mt-1 text-xs text-muted-foreground">
              To use it on this device, add{" "}
              {describeMissing(server.missingLocal)}. These stay on the device
              that has them.
            </p>
          )}
          {server.oauth.supported && !server.requiresLocalSetup && (
            <p className="text-sm text-muted-foreground">
              {server.oauth.configured ? "OAuth connected" : "OAuth available"}
            </p>
          )}
          {server.oauth.lastError && (
            <p className="mt-1 text-xs break-all text-destructive">
              {server.oauth.lastError}
            </p>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 self-end sm:self-auto">
        {server.oauth.supported && !server.requiresLocalSetup && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={server.disabled || authorizing}
            onClick={async () => {
              setAuthorizing(true)
              try {
                if (server.oauth.configured) await onDisconnectOAuth()
                else await onAuthorize()
              } finally {
                setAuthorizing(false)
              }
            }}
          >
            <KeyRoundIcon />
            {authorizing
              ? "Waiting…"
              : server.oauth.configured
                ? "Disconnect"
                : "Connect"}
          </Button>
        )}
        <Button
          type="button"
          variant={server.requiresLocalSetup ? "outline" : "ghost"}
          size={server.requiresLocalSetup ? "sm" : "icon-sm"}
          aria-label={
            server.requiresLocalSetup
              ? `Add details for ${server.name} on this device`
              : `Edit ${server.name}`
          }
          onClick={onEdit}
        >
          <PencilIcon />
          {server.requiresLocalSetup && "Add on this device"}
        </Button>
        <Switch
          checked={!server.disabled && !server.requiresLocalSetup}
          disabled={server.requiresLocalSetup}
          aria-label={`Enable ${server.name} MCP server`}
          onCheckedChange={onToggle}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Remove ${server.name}`}
          onClick={onRemove}
        >
          <Trash2Icon />
        </Button>
      </div>
    </div>
  )
}

function transportLabel(value: McpTransport) {
  return value === "stdio"
    ? "Local command"
    : value === "sse"
      ? "SSE · legacy"
      : "Streamable HTTP"
}
