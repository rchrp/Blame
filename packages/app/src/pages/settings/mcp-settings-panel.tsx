import * as React from "react"
import {
  AlertCircleIcon,
  ChevronDownIcon,
  KeyRoundIcon,
  PencilIcon,
  PlusIcon,
  ServerIcon,
  Trash2Icon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { useCloudAuth, type CloudMcpServer } from "@/context/cloud-auth"
import {
  usePlatform,
  type McpServerConfig,
  type McpTransport,
} from "@/context/platform"
import { formatArguments, parseArguments } from "./mcp-arguments"
import { AgentImportButton } from "./agent-import-dialog"

type Entry = { id: string; key: string; value: string }
type FormState = {
  args: string
  command: string
  cwd: string
  entries: Entry[]
  name: string
  timeout: string
  transport: McpTransport
  url: string
}

const formState = (server?: McpServerConfig): FormState => ({
  args: formatArguments(server?.args ?? []),
  command: server?.command ?? "",
  cwd: server?.cwd ?? "",
  entries: localEntries(server),
  name: server?.name ?? "",
  timeout: server?.timeout ? String(server.timeout) : "",
  transport: server?.transport ?? "stdio",
  url: server?.url ?? "",
})

export function McpSettingsPanel() {
  const client = usePlatform().mcp
  const cloud = useCloudAuth()
  const cloudMcpConfiguration = cloud.mcpConfiguration
  const cloudStatus = cloud.status
  const cloudUserId = cloud.user?.id
  const saveCloudMcpConfiguration = cloud.saveMcpConfiguration
  const [servers, setServers] = React.useState<McpServerConfig[]>([])
  const [adding, setAdding] = React.useState(false)
  const [editingName, setEditingName] = React.useState<string>()
  const [loading, setLoading] = React.useState(Boolean(client))
  const [error, setError] = React.useState<string>()

  React.useEffect(() => {
    if (!client) return
    void client
      .list()
      .then(async (localServers) => {
        if (cloudStatus !== "authenticated" || !cloudUserId) {
          return setServers(localServers)
        }
        if (cloudMcpConfiguration) {
          return setServers(
            await client.mergeCloud(cloudUserId, cloudMcpConfiguration.servers)
          )
        }
        await saveCloudMcpConfiguration(toCloudServers(localServers))
        setServers(
          await client.mergeCloud(
            cloudUserId,
            toCloudServers(localServers),
            true
          )
        )
      })
      .catch((reason) => setError(errorMessage(reason)))
      .finally(() => setLoading(false))
  }, [
    client,
    cloudMcpConfiguration,
    cloudStatus,
    cloudUserId,
    saveCloudMcpConfiguration,
  ])

  async function update(action: () => Promise<McpServerConfig[]>) {
    setError(undefined)
    let updated: McpServerConfig[]
    try {
      updated = await action()
    } catch (reason) {
      setError(errorMessage(reason))
      return false
    }
    setServers(updated)
    if (cloud.status === "authenticated") {
      try {
        await cloud.saveMcpConfiguration(toCloudServers(updated))
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
          <div className="flex flex-wrap gap-2">
            <AgentImportButton
              onImported={() => void update(() => client!.list())}
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
        </div>

        {!client && (
          <Notice>
            Server connections are available in the Blame desktop app.
          </Notice>
        )}
        {error && <Notice error>{error}</Notice>}
        {adding && client && (
          <McpServerForm
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
                onCancel={() => setEditingName(undefined)}
                onSave={async (updatedServer) => {
                  const saved = await update(() =>
                    client.save(updatedServer, server.name)
                  )
                  if (saved) setEditingName(undefined)
                  return saved
                }}
              />
            ) : (
              <McpServerRow
                key={server.name}
                server={server}
                onEdit={() => {
                  setAdding(false)
                  setEditingName(server.name)
                }}
                onToggle={(enabled) =>
                  client &&
                  void update(() => client.setEnabled(server.name, enabled))
                }
                onRemove={() =>
                  client && void update(() => client.remove(server.name))
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

function toCloudServers(servers: McpServerConfig[]): CloudMcpServer[] {
  return servers.map((server) => ({
    command: server.transport === "stdio" ? server.command : undefined,
    disabled: server.disabled,
    name: server.name,
    timeout: server.timeout,
    transport: server.transport,
    url: server.transport === "stdio" ? undefined : safeCloudUrl(server.url),
  }))
}

function safeCloudUrl(value: string | undefined) {
  if (!value) return undefined
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "Remove credentials and parameters from the MCP URL before syncing it."
    )
  }
  return url.toString()
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
    setupRequired ? `${setupRequired} setup required` : undefined,
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
  onAuthorize,
  onDisconnectOAuth,
  onEdit,
  onRemove,
  onToggle,
}: {
  server: McpServerConfig
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
          <div className="truncate text-sm font-medium">{server.name}</div>
          <p
            className="truncate text-sm text-muted-foreground"
            title={endpoint}
          >
            {server.requiresLocalSetup
              ? "Setup required"
              : server.disabled
                ? "Disabled"
                : transportLabel(server.transport)}{" "}
            · {endpoint}
          </p>
          {server.requiresLocalSetup && (
            <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
              Local arguments and credentials are not synced. Review this server
              on this device.
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
              ? `Complete ${server.name} setup`
              : `Edit ${server.name}`
          }
          onClick={onEdit}
        >
          <PencilIcon />
          {server.requiresLocalSetup && "Complete setup"}
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

function McpServerForm({
  onCancel,
  onSave,
  server,
}: {
  onCancel(): void
  onSave(server: McpServerConfig): Promise<boolean>
  server?: McpServerConfig
}) {
  const [form, setForm] = React.useState(() => formState(server))
  const [advanced, setAdvanced] = React.useState(Boolean(server))
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string>()
  const firstInput = React.useRef<HTMLInputElement>(null)
  React.useEffect(() => firstInput.current?.focus(), [])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setError(undefined)
    setSaving(true)
    try {
      const saved = await onSave(
        serverFromForm(form, server?.disabled ?? false)
      )
      if (!saved) setSaving(false)
    } catch (reason) {
      setError(errorMessage(reason))
      setSaving(false)
    }
  }

  return (
    <form className="mt-5 rounded-xl border bg-muted/20 p-4" onSubmit={submit}>
      <div className="mb-4">
        <h4 className="text-sm font-semibold">
          {server ? `Edit ${server.name}` : "Add an MCP server"}
        </h4>
        <p className="mt-1 text-xs text-muted-foreground">
          {server
            ? "Update how Blame connects on this device."
            : "Choose how Blame should connect."}
        </p>
      </div>
      {server?.requiresLocalSetup && (
        <Notice>
          This server was synced without its local arguments, working directory,
          environment variables, headers, or OAuth credentials. Re-enter what it
          needs, save, then reconnect OAuth if applicable.
        </Notice>
      )}
      <div
        className={
          server?.requiresLocalSetup
            ? "mt-4 grid gap-4 sm:grid-cols-2"
            : "grid gap-4 sm:grid-cols-2"
        }
      >
        <Field label="Name">
          <Input
            ref={firstInput}
            required
            maxLength={80}
            placeholder="GitHub"
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
        </Field>
        <Field label="Connection">
          <Select
            value={form.transport}
            onValueChange={(value) =>
              setForm({ ...form, transport: value as McpTransport })
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="stdio">Local command</SelectItem>
              <SelectItem value="streamableHttp">HTTP server</SelectItem>
              <SelectItem value="sse">SSE server (legacy)</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        {form.transport === "stdio" ? (
          <Field label="Command" className="sm:col-span-2">
            <Input
              required
              placeholder="npx"
              value={form.command}
              onChange={(event) =>
                setForm({ ...form, command: event.target.value })
              }
            />
          </Field>
        ) : (
          <Field label="Server URL" className="sm:col-span-2">
            <Input
              required
              type="url"
              placeholder="https://mcp.example.com"
              value={form.url}
              onChange={(event) =>
                setForm({ ...form, url: event.target.value })
              }
            />
          </Field>
        )}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="mt-3 -ml-2"
        aria-expanded={advanced}
        onClick={() => setAdvanced(!advanced)}
      >
        Advanced options
        <ChevronDownIcon className={advanced ? "rotate-180" : ""} />
      </Button>
      {advanced && (
        <div className="mt-2 grid gap-4 border-t pt-4">
          <Field
            label="Timeout"
            hint="Optional connection timeout in seconds (1–3600)."
          >
            <Input
              inputMode="numeric"
              min={1}
              max={3600}
              placeholder="60"
              step={1}
              type="number"
              value={form.timeout}
              onChange={(event) =>
                setForm({ ...form, timeout: event.target.value })
              }
            />
          </Field>
          {form.transport === "stdio" && (
            <>
              <Field
                label="Arguments"
                hint="Separate arguments with spaces. Use quotes around values containing spaces."
              >
                <Input
                  placeholder="-y @modelcontextprotocol/server-github"
                  value={form.args}
                  onChange={(event) =>
                    setForm({ ...form, args: event.target.value })
                  }
                />
              </Field>
              <Field label="Working directory">
                <Input
                  placeholder="/path/to/project"
                  value={form.cwd}
                  onChange={(event) =>
                    setForm({ ...form, cwd: event.target.value })
                  }
                />
              </Field>
            </>
          )}
          <KeyValueFields
            label={
              form.transport === "stdio"
                ? "Environment variables"
                : "Request headers"
            }
            entries={form.entries}
            onChange={(entries) => setForm({ ...form, entries })}
          />
        </div>
      )}
      {error && <Notice error>{error}</Notice>}
      <div className="mt-5 flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {saving
            ? server
              ? "Saving…"
              : "Adding…"
            : server
              ? "Save changes"
              : "Add server"}
        </Button>
      </div>
    </form>
  )
}

function KeyValueFields({
  entries,
  label,
  onChange,
}: {
  entries: Entry[]
  label: string
  onChange(entries: Entry[]): void
}) {
  return (
    <div>
      <Label>{label}</Label>
      <div className="mt-2 grid gap-2">
        {entries.map((entry, index) => (
          <div className="flex gap-2" key={entry.id}>
            <Input
              aria-label={`${label} key ${index + 1}`}
              placeholder="Key"
              value={entry.key}
              onChange={(event) =>
                onChange(
                  entries.map((item) =>
                    item.id === entry.id
                      ? { ...item, key: event.target.value }
                      : item
                  )
                )
              }
            />
            <Input
              aria-label={`${label} value ${index + 1}`}
              placeholder="Value"
              type={label === "Environment variables" ? "password" : "text"}
              value={entry.value}
              onChange={(event) =>
                onChange(
                  entries.map((item) =>
                    item.id === entry.id
                      ? { ...item, value: event.target.value }
                      : item
                  )
                )
              }
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Remove entry"
              onClick={() =>
                onChange(entries.filter((item) => item.id !== entry.id))
              }
            >
              <Trash2Icon />
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-fit"
          onClick={() =>
            onChange([
              ...entries,
              { id: crypto.randomUUID(), key: "", value: "" },
            ])
          }
        >
          <PlusIcon />
          Add {entries.length ? "another" : "entry"}
        </Button>
      </div>
    </div>
  )
}

function Field({
  children,
  className,
  hint,
  label,
}: {
  children: React.ReactNode
  className?: string
  hint?: string
  label: string
}) {
  return (
    <div className={className}>
      <Label className="mb-2">{label}</Label>
      {children}
      {hint && <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}
function Notice({
  children,
  error,
}: {
  children: React.ReactNode
  error?: boolean
}) {
  return (
    <div
      className={`mt-4 flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${error ? "border-destructive/30 text-destructive" : "text-muted-foreground"}`}
    >
      {error && <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />}
      {children}
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
function errorMessage(reason: unknown) {
  return reason instanceof Error
    ? reason.message
    : "Could not update MCP servers."
}

function localEntries(server?: McpServerConfig): Entry[] {
  const values = server?.transport === "stdio" ? server.env : server?.headers
  return Object.entries(values ?? {}).map(([key, value]) => ({
    id: crypto.randomUUID(),
    key,
    value,
  }))
}

function serverFromForm(form: FormState, disabled: boolean): McpServerConfig {
  const values = entryValues(form.entries)
  const common = {
    disabled,
    name: form.name,
    requiresLocalSetup: false,
    timeout: timeoutSeconds(form.timeout),
  }
  return form.transport === "stdio"
    ? {
        ...common,
        args: parseArguments(form.args),
        command: form.command,
        cwd: form.cwd || undefined,
        env: values,
        oauth: { configured: false, supported: false },
        transport: "stdio",
      }
    : {
        ...common,
        headers: values,
        oauth: { configured: false, supported: true },
        transport: form.transport,
        url: form.url,
      }
}

function timeoutSeconds(value: string) {
  if (!value.trim()) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3600) {
    throw new Error(
      "Timeout must be a whole number between 1 and 3600 seconds."
    )
  }
  return parsed
}

function entryValues(entries: Entry[]) {
  return Object.fromEntries(
    entries
      .filter((entry) => entry.key.trim())
      .map((entry) => [entry.key.trim(), entry.value])
  )
}
