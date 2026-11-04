import type {
  PreviewEnvironmentServiceView,
  PreviewEnvironmentView,
  PreviewVariableRequest,
  PreviewVariableScope,
  PreviewVariableView,
} from "@blame/agent-runtime"
import {
  BotIcon,
  DatabaseIcon,
  LockIcon,
  PencilIcon,
  PlusIcon,
  RotateCwIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react"
import * as React from "react"
import { toast } from "sonner"

import {
  changedServices,
  databaseModeSummary,
  variableNeedsValue,
  variableSourceLabel,
  variableStatusLabel,
} from "@/components/backlog/drawer/preview-variables-labels"
import { readableFailure } from "@/components/backlog/drawer/preview-failure-message"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { usePlatform } from "@/context/platform"
import { cn } from "@/lib/utils"

// The Variables tab of a story preview: what each service receives and
// where it comes from, the keys still missing, the variables the agent asked
// for, and inline editing for this story or every story of the project.

const refreshIntervalMs = 10_000

export function usePreviewEnvironment(
  worktree: string | undefined,
  active: boolean
) {
  const client = usePlatform().previewEnvironment
  const [view, setView] = React.useState<PreviewEnvironmentView>()
  const [error, setError] = React.useState<string>()
  // The state updates run once describe settles, never synchronously, so the
  // polling effect below can call refresh directly.
  const refresh = React.useCallback(async () => {
    if (!client || !worktree) return
    await client.describe({ worktree }).then(
      (next) => {
        setView(next)
        setError(undefined)
      },
      (failure: unknown) =>
        setError(
          readableFailure(
            failure instanceof Error ? failure.message : String(failure)
          )
        )
    )
  }, [client, worktree])
  React.useEffect(() => {
    if (!active) return
    void refresh()
    // An edited .env shows up without leaving the tab.
    const timer = window.setInterval(() => void refresh(), refreshIntervalMs)
    return () => window.clearInterval(timer)
  }, [active, refresh])
  return { view, error, refresh, available: Boolean(client && worktree) }
}

type Editing = { serviceId: string; key: string; isNew?: boolean }

export function PreviewVariablesPanel({
  worktree,
  active,
  onApply,
}: {
  worktree?: string | null
  active: boolean
  /** Starts the preview again; Compose recreates only changed services. */
  onApply?: () => Promise<unknown> | void
}) {
  const client = usePlatform().previewEnvironment
  const { view, error, refresh, available } = usePreviewEnvironment(
    worktree ?? undefined,
    active
  )
  const [editing, setEditing] = React.useState<Editing>()
  const [applying, setApplying] = React.useState(false)

  const save = React.useCallback(
    async (input: {
      key: string
      value?: string
      scope: PreviewVariableScope
      serviceId?: string
    }) => {
      if (!client || !worktree) return false
      try {
        await client.set({ worktree, ...input })
        await refresh()
        return true
      } catch (failure) {
        toast.error("Unable to save the variable", {
          description: readableFailure(
            failure instanceof Error ? failure.message : String(failure)
          ),
        })
        return false
      }
    },
    [client, refresh, worktree]
  )

  const apply = async () => {
    if (!onApply) return
    setApplying(true)
    try {
      await onApply()
      await refresh()
    } finally {
      setApplying(false)
    }
  }

  if (!available)
    return (
      <PanelFrame>
        <p className="text-sm text-muted-foreground">
          Variables are available once this story has its own workspace.
        </p>
      </PanelFrame>
    )
  if (!view)
    return (
      <PanelFrame>
        <p className="text-sm text-muted-foreground">
          {error ?? "Reading the preview's variables…"}
        </p>
      </PanelFrame>
    )

  const changed = changedServices(view)
  const services = view.services.filter(({ kind }) => kind === "service")
  const setup = view.services.filter(({ kind }) => kind === "setup")
  const database = databaseModeSummary(view)
  return (
    <PanelFrame>
      <section className="flex items-start gap-3 rounded-xl border bg-background/60 px-4 py-3">
        <DatabaseIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="grid min-w-0 gap-0.5">
          <p className="truncate text-sm font-medium">{database.title}</p>
          <p className="text-xs text-muted-foreground">{database.detail}</p>
        </div>
        {!view.encrypted ? (
          <Badge
            variant="outline"
            className="ml-auto"
            title="Values you set cannot be stored without the system keychain."
          >
            Keychain unavailable
          </Badge>
        ) : null}
      </section>

      {changed.length ? (
        <Notice tone="info">
          <span className="min-w-0 flex-1">
            Variables of {changed.join(", ")} changed since{" "}
            {changed.length > 1 ? "they" : "it"} started, for example in your
            .env. Restart to apply.
          </span>
          {onApply ? (
            <Button
              size="sm"
              variant="outline"
              disabled={applying}
              onClick={() => void apply()}
            >
              <RotateCwIcon className={cn(applying && "animate-spin")} />
              {applying ? "Restarting" : "Restart to apply"}
            </Button>
          ) : null}
        </Notice>
      ) : null}

      {view.warnings.map((warning) => (
        <Notice key={warning} tone="warning">
          <span className="min-w-0 flex-1">{warning}</span>
        </Notice>
      ))}

      {view.requests.map((request) => (
        <AgentRequest
          key={request.key}
          request={request}
          onDismiss={() =>
            client && worktree
              ? void client
                  .dismissRequest({ worktree, key: request.key })
                  .then(refresh)
              : undefined
          }
          onSet={() =>
            setEditing({
              serviceId: request.serviceId ?? services[0]?.id ?? "",
              key: request.key,
              isNew: !view.services.some(({ variables }) =>
                variables.some(({ key }) => key === request.key)
              ),
            })
          }
        />
      ))}

      {[...services, ...setup].map((service) => (
        <ServiceVariables
          key={`${service.kind}:${service.id}`}
          service={service}
          editing={editing?.serviceId === service.id ? editing : undefined}
          onEdit={(key, isNew) =>
            setEditing({ serviceId: service.id, key, isNew })
          }
          onCancel={() => setEditing(undefined)}
          onSave={async (input) => {
            if (await save(input)) setEditing(undefined)
          }}
        />
      ))}
    </PanelFrame>
  )
}

function PanelFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full min-h-0 overflow-y-auto px-4 pt-16 pb-6">
      <div className="mx-auto grid w-full max-w-4xl gap-3">{children}</div>
    </div>
  )
}

function Notice({
  children,
  tone,
}: {
  children: React.ReactNode
  tone: "info" | "warning"
}) {
  return (
    <div
      role={tone === "warning" ? "alert" : "status"}
      className={cn(
        "flex items-center gap-3 rounded-xl border px-4 py-2.5 text-sm",
        tone === "warning"
          ? "border-amber-500/30 bg-amber-500/10 text-amber-950 dark:text-amber-100"
          : "border-sky-500/30 bg-sky-500/10 text-sky-950 dark:text-sky-100"
      )}
    >
      {tone === "warning" ? (
        <TriangleAlertIcon className="size-4 shrink-0" />
      ) : (
        <RotateCwIcon className="size-4 shrink-0" />
      )}
      {children}
    </div>
  )
}

function AgentRequest({
  request,
  onDismiss,
  onSet,
}: {
  request: PreviewVariableRequest
  onDismiss(): void
  onSet(): void
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-violet-500/30 bg-violet-500/10 px-4 py-2.5 text-sm">
      <BotIcon className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">
        The agent needs{" "}
        <code className="font-mono font-medium">{request.key}</code>
        {request.serviceId ? ` for ${request.serviceId}` : ""}: {request.reason}
      </span>
      <Button size="sm" onClick={onSet}>
        Set value
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        <XIcon />
      </Button>
    </div>
  )
}

function ServiceVariables({
  service,
  editing,
  onEdit,
  onCancel,
  onSave,
}: {
  service: PreviewEnvironmentServiceView
  editing?: Editing
  onEdit(key: string, isNew?: boolean): void
  onCancel(): void
  onSave(input: {
    key: string
    value?: string
    scope: PreviewVariableScope
    serviceId?: string
  }): Promise<void>
}) {
  const needs = service.variables.filter(variableNeedsValue).length
  return (
    <section className="overflow-hidden rounded-xl border bg-background/60">
      <header className="flex items-center gap-2 border-b px-4 py-2.5">
        <h3 className="truncate text-sm font-semibold">{service.id}</h3>
        <span className="truncate font-mono text-xs text-muted-foreground">
          {service.kind === "setup" ? "setup task" : "service"}
          {service.directory && service.directory !== "."
            ? ` · ${service.directory}`
            : ""}
        </span>
        {needs ? (
          <Badge
            variant="outline"
            className="border-amber-500/40 text-amber-700 dark:text-amber-300"
          >
            {needs} to fill in
          </Badge>
        ) : null}
        <Button
          size="xs"
          variant="ghost"
          className="ml-auto"
          onClick={() => onEdit("", true)}
        >
          <PlusIcon />
          Add
        </Button>
      </header>
      <ul className="divide-y">
        {editing?.isNew &&
        !service.variables.some(({ key }) => key === editing.key) ? (
          <li>
            <VariableEditor
              serviceId={service.id}
              initialKey={editing.key}
              onCancel={onCancel}
              onSave={onSave}
            />
          </li>
        ) : null}
        {service.variables.map((variable) =>
          editing && !editing.isNew && editing.key === variable.key ? (
            <li key={variable.key}>
              <VariableEditor
                serviceId={service.id}
                initialKey={variable.key}
                variable={variable}
                onCancel={onCancel}
                onSave={onSave}
              />
            </li>
          ) : (
            <VariableRow
              key={variable.key}
              variable={variable}
              onEdit={() => onEdit(variable.key)}
              onRemove={
                variable.source === "story" || variable.source === "project"
                  ? () =>
                      void onSave({
                        key: variable.key,
                        scope: variable.source as PreviewVariableScope,
                      })
                  : undefined
              }
            />
          )
        )}
        {!service.variables.length && !editing ? (
          <li className="px-4 py-3 text-xs text-muted-foreground">
            No variables.
          </li>
        ) : null}
      </ul>
    </section>
  )
}

function VariableRow({
  variable,
  onEdit,
  onRemove,
}: {
  variable: PreviewVariableView
  onEdit(): void
  onRemove?: () => void
}) {
  const status = variableStatusLabel(variable)
  const attention = variableNeedsValue(variable)
  return (
    <li className="group grid grid-cols-[minmax(8rem,14rem)_minmax(0,1fr)_auto] items-start gap-x-3 px-4 py-2">
      <span className="flex min-w-0 items-center gap-1.5 pt-0.5">
        <code
          className={cn(
            "truncate font-mono text-xs font-medium",
            variable.status === "removed" &&
              "text-muted-foreground line-through"
          )}
          title={variable.key}
        >
          {variable.key}
        </code>
        {variable.required ? (
          <span className="text-[0.625rem] text-muted-foreground uppercase">
            required
          </span>
        ) : null}
      </span>
      <span className="grid min-w-0 gap-1">
        <code
          className={cn(
            "font-mono text-xs break-all",
            variable.status === "removed" || !variable.value
              ? "text-muted-foreground"
              : "text-foreground/90"
          )}
        >
          {variable.value || "—"}
        </code>
        {variable.note ? (
          <span className="text-xs text-muted-foreground">{variable.note}</span>
        ) : null}
      </span>
      <span className="flex items-center gap-1.5">
        {status ? (
          <Badge
            variant="outline"
            className={cn(
              attention &&
                "border-amber-500/40 text-amber-700 dark:text-amber-300"
            )}
          >
            {status}
          </Badge>
        ) : null}
        <Badge
          variant="secondary"
          title={variable.file}
          className={cn(variable.source.startsWith("blame-") && "gap-1")}
        >
          {variable.locked ? <LockIcon /> : null}
          {variableSourceLabel(variable)}
        </Badge>
        {variable.locked ? (
          <span className="size-6" aria-hidden />
        ) : (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Edit ${variable.key}`}
            className="opacity-60 group-hover:opacity-100 focus-visible:opacity-100"
            onClick={onEdit}
          >
            <PencilIcon />
          </Button>
        )}
        {onRemove ? (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Remove the ${variableSourceLabel(variable)} ${variable.key}`}
            className="opacity-60 group-hover:opacity-100 focus-visible:opacity-100"
            onClick={onRemove}
          >
            <XIcon />
          </Button>
        ) : null}
      </span>
    </li>
  )
}

function VariableEditor({
  serviceId,
  initialKey,
  variable,
  onCancel,
  onSave,
}: {
  serviceId: string
  initialKey: string
  variable?: PreviewVariableView
  onCancel(): void
  onSave(input: {
    key: string
    value?: string
    scope: PreviewVariableScope
    serviceId?: string
  }): Promise<void>
}) {
  const [key, setKey] = React.useState(initialKey)
  const [value, setValue] = React.useState(
    variable && !variable.masked && variable.status !== "removed"
      ? variable.value
      : ""
  )
  const [scope, setScope] = React.useState<PreviewVariableScope>(
    variable?.source === "project" ? "project" : "story"
  )
  const [onlyThisService, setOnlyThisService] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const validKey = /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!validKey) return
    setSaving(true)
    await onSave({
      key,
      value,
      scope,
      ...(onlyThisService ? { serviceId } : {}),
    })
    setSaving(false)
  }
  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="grid gap-2 bg-muted/40 px-4 py-3"
      onKeyDown={(event) => {
        if (event.key === "Escape") onCancel()
      }}
    >
      <div className="grid grid-cols-[minmax(8rem,14rem)_minmax(0,1fr)] gap-2">
        <Input
          aria-label="Name"
          value={key}
          readOnly={Boolean(variable)}
          autoFocus={!variable && !initialKey}
          placeholder="NAME"
          className="h-8 font-mono text-xs"
          onChange={(event) => setKey(event.target.value.trim())}
        />
        <Input
          aria-label={`Value of ${key || "the variable"}`}
          value={value}
          autoFocus={Boolean(variable || initialKey)}
          autoComplete="off"
          spellCheck={false}
          placeholder={
            variable?.masked
              ? "New value (the current one stays hidden)"
              : "Value"
          }
          className="h-8 font-mono text-xs"
          onChange={(event) => setValue(event.target.value)}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={scope}
          onValueChange={(next) => setScope(next as PreviewVariableScope)}
        >
          <SelectTrigger size="sm" aria-label="Applies to">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="story">This story</SelectItem>
            <SelectItem value="project">All stories</SelectItem>
          </SelectContent>
        </Select>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch
            size="sm"
            checked={onlyThisService}
            onCheckedChange={setOnlyThisService}
          />
          Only {serviceId}
        </label>
        <span className="flex-1" />
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!validKey || saving}>
          {saving ? "Saving" : "Save"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Stored encrypted on this computer, never in your project. It applies at
        the next start of the preview.
      </p>
    </form>
  )
}
