import * as React from "react"
import {
  AlertCircleIcon,
  ChevronDownIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { SyncChoice } from "@/components/sync-choice"
import type {
  McpServerConfig,
  McpSyncMode,
  McpTransport,
} from "@/context/platform"
import { formatArguments, parseArguments } from "./mcp-arguments"
import { canSync } from "./mcp-cloud-servers"

type Entry = { id: string; key: string; value: string }
type FormState = {
  args: string
  command: string
  cwd: string
  entries: Entry[]
  name: string
  sync: McpSyncMode
  syncSecrets: boolean
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
  sync: server?.sync ?? "account",
  syncSecrets: server?.syncSecrets ?? false,
  timeout: server?.timeout ? String(server.timeout) : "",
  transport: server?.transport ?? "stdio",
  url: server?.url ?? "",
})

export function McpServerForm({
  onCancel,
  onSave,
  server,
  syncAvailable,
}: {
  onCancel(): void
  onSave(server: McpServerConfig): Promise<boolean>
  server?: McpServerConfig
  syncAvailable: boolean
}) {
  const [form, setForm] = React.useState(() => formState(server))
  const [confirmingLeave, setConfirmingLeave] = React.useState(false)
  const syncProblem = canSync({ transport: form.transport, url: form.url })
  const leavingAccount =
    syncAvailable &&
    Boolean(server) &&
    !server?.requiresLocalSetup &&
    server?.sync !== "device" &&
    (form.sync === "device" || !syncProblem.ok)
  const [advanced, setAdvanced] = React.useState(Boolean(server))
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string>()
  const firstInput = React.useRef<HTMLInputElement>(null)
  React.useEffect(() => firstInput.current?.focus(), [])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setError(undefined)
    if (leavingAccount && !confirmingLeave) {
      setConfirmingLeave(true)
      return
    }
    setSaving(true)
    try {
      const saved = await onSave(
        serverFromForm(form, server?.disabled ?? false, syncAvailable)
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
          This server came from your account without its arguments, working
          directory, environment variables or headers, which stay on each
          device. Add what it needs here and save; connect OAuth again if it
          uses it.
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
      {syncAvailable && (
        <div className="mt-4 grid gap-3 border-t pt-4">
          <SyncChoice
            label="Where to keep this server"
            accountLabel="Sync to my account"
            accountHint="Saved in your Blame account, so your other devices get it too. Passwords and keys stay on this device unless you choose otherwise below."
            deviceHint="Stays on this computer. Nothing about it is uploaded."
            disabled={!syncProblem.ok}
            value={syncProblem.ok ? form.sync : "device"}
            onChange={(sync) => {
              setConfirmingLeave(false)
              setForm({ ...form, sync })
            }}
          />
          {!syncProblem.ok && (
            <p className="text-xs text-muted-foreground">
              {syncProblem.reason}
            </p>
          )}
          {syncProblem.ok && form.sync === "account" && (
            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                className="mt-0.5"
                checked={form.syncSecrets}
                onCheckedChange={(checked) =>
                  setForm({ ...form, syncSecrets: checked === true })
                }
              />
              <span>
                Also sync its arguments and secrets
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Arguments, environment variables and headers are stored
                  encrypted in your account, so this server works on your other
                  devices without setting it up again. Off by default.
                </span>
              </span>
            </label>
          )}
        </div>
      )}
      {error && <Notice error>{error}</Notice>}
      {confirmingLeave && (
        <Notice>
          This removes “{form.name || server?.name}” from your account. Your
          other devices keep the copy they already have, and this device keeps
          all its settings.
        </Notice>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() =>
            confirmingLeave ? setConfirmingLeave(false) : onCancel()
          }
        >
          {confirmingLeave ? "Back" : "Cancel"}
        </Button>
        <Button type="submit" disabled={saving}>
          {saving
            ? server
              ? "Saving…"
              : "Adding…"
            : confirmingLeave
              ? "Remove from account and save"
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
export function Notice({
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
export function errorMessage(reason: unknown) {
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

function serverFromForm(
  form: FormState,
  disabled: boolean,
  syncAvailable: boolean
): McpServerConfig {
  const values = entryValues(form.entries)
  // Without an account there is no choice: the server's sync state is left
  // as it is.
  const syncs =
    form.sync === "account" &&
    canSync({ transport: form.transport, url: form.url }).ok
  const common = {
    disabled,
    name: form.name,
    requiresLocalSetup: false,
    ...(syncAvailable
      ? {
          sync: syncs ? ("account" as const) : ("device" as const),
          syncSecrets: syncs && form.syncSecrets,
        }
      : {}),
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
