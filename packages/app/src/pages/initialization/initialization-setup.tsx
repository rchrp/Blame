import { DeviceTargetFields } from "./environment-devices"
import * as React from "react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import {
  appliedSetup,
  containerFieldId,
  runFieldId,
  SetupFieldError,
  setupDraft,
  setupFromJson,
  setupJson,
  type DraftContainer,
  type SavedSetup,
  type SetupDraft,
} from "./initialization-setup-draft"
import {
  EnvironmentSection,
  environmentKinds,
  environmentSections,
  KindIcon,
  type EnvironmentKind,
} from "./environment-kinds"

// The setup as fields, and as JSON for whatever the fields do not cover.

type FieldError = { fieldId: string; message: string }

const FieldErrorContext = React.createContext<FieldError | undefined>(undefined)

export function InitializationSetupEditor({
  locked,
  saved,
  onCancel,
  onSave,
}: {
  /** Why saving waits, such as an analysis running. */
  locked?: string
  saved: SavedSetup
  onCancel(): void
  onSave(setup: SavedSetup): Promise<void>
}) {
  const [base, setBase] = React.useState(saved)
  const [draft, setDraft] = React.useState(() => setupDraft(saved))
  const [view, setView] = React.useState<"form" | "json">("form")
  const [json, setJson] = React.useState("")
  const [error, setError] = React.useState<string>()
  const [fieldError, setFieldError] = React.useState<FieldError>()
  const [changed, setChanged] = React.useState(false)
  const [confirmDiscard, setConfirmDiscard] = React.useState(false)
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    if (!fieldError) return
    const field = document.getElementById(fieldError.fieldId)
    field?.scrollIntoView({ block: "center", behavior: "smooth" })
    field?.focus({ preventScroll: true })
  }, [fieldError])

  const current = () =>
    view === "json" ? setupFromJson(json) : appliedSetup(base, draft)

  const showError = (cause: unknown) => {
    if (cause instanceof SetupFieldError && cause.fieldId && view === "form") {
      setError(undefined)
      // Under its field, the message needs no "Service web, port http:".
      const message = cause.message.replace(/^[^:]*:\s*/, "")
      setFieldError({
        fieldId: cause.fieldId,
        message: message.charAt(0).toUpperCase() + message.slice(1),
      })
      return
    }
    setFieldError(undefined)
    setError(messageOf(cause))
  }

  const editDraft = (next: SetupDraft) => {
    setDraft(next)
    setChanged(true)
    setFieldError(undefined)
  }

  const switchView = (next: string) => {
    if (next === view) return
    try {
      const setup = current()
      if (next === "json") setJson(setupJson(setup))
      else {
        setBase(setup)
        setDraft(setupDraft(setup))
      }
      setError(undefined)
      setFieldError(undefined)
      setView(next as "form" | "json")
    } catch (cause) {
      showError(cause)
    }
  }

  const save = async () => {
    let setup: SavedSetup
    try {
      setup = current()
    } catch (cause) {
      showError(cause)
      return
    }
    setSaving(true)
    setError(undefined)
    setFieldError(undefined)
    try {
      await onSave(setup)
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setSaving(false)
    }
  }

  const cancel = () => {
    if (changed) setConfirmDiscard(true)
    else onCancel()
  }

  return (
    <FieldErrorContext.Provider value={fieldError}>
      <div className="grid gap-6">
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>The setup can&apos;t be saved yet</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {view === "json" ? (
          <div className="grid gap-2">
            <Label htmlFor="initialization-json">
              Preview manifest and run configurations
            </Label>
            <Textarea
              id="initialization-json"
              value={json}
              onChange={(event) => {
                setJson(event.target.value)
                setChanged(true)
              }}
              spellCheck={false}
              className="min-h-[32rem] font-mono text-xs leading-relaxed md:text-xs"
            />
          </div>
        ) : (
          <SetupForm saved={base} draft={draft} onChange={editDraft} />
        )}
      </div>
      <div className="sticky bottom-4 z-10 mt-auto flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-popover px-4 py-3">
        <div className="grid gap-0.5">
          <span className="text-sm font-medium">Editing the setup</span>
          <span className="text-xs text-muted-foreground">
            {locked ??
              "Stories started from now on use it. Blame checks it before saving."}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Tabs value={view} onValueChange={switchView}>
            <TabsList>
              <TabsTrigger value="form">Fields</TabsTrigger>
              <TabsTrigger value="json">JSON</TabsTrigger>
            </TabsList>
          </Tabs>
          <Button variant="ghost" onClick={cancel} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={() => void save()}
            disabled={saving || Boolean(locked)}
          >
            {saving ? "Saving…" : "Save setup"}
          </Button>
        </div>
      </div>
      <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard your changes?</AlertDialogTitle>
            <AlertDialogDescription>
              The setup stays as it was saved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={onCancel}>
              Discard changes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </FieldErrorContext.Provider>
  )
}

function SetupForm({
  draft,
  onChange,
  saved,
}: {
  draft: SetupDraft
  onChange(draft: SetupDraft): void
  saved: SavedSetup
}) {
  const manifest = saved.previewManifest
  const update = (patch: Partial<SetupDraft>) =>
    onChange({ ...draft, ...patch })
  const replace = <T,>(items: T[], index: number, item: T) =>
    items.map((current, position) => (position === index ? item : current))

  return (
    <div className="grid gap-8">
      <EnvironmentSection {...environmentSections.runConfigurations}>
        <EditList>
          {draft.runConfigurations.map((configuration, index) => {
            const original = saved.runConfigurations.find(
              ({ id }) => id === configuration.id
            )
            const edit = (patch: Partial<typeof configuration>) =>
              update({
                runConfigurations: replace(draft.runConfigurations, index, {
                  ...configuration,
                  ...patch,
                }),
              })
            return (
              <li key={configuration.id} className="grid gap-3 p-4">
                <ItemHeading
                  kind="run"
                  name={original?.name ?? configuration.id}
                />
                <div className="grid gap-3 sm:grid-cols-[minmax(0,14rem)_1fr]">
                  <TextField
                    id={runFieldId(configuration.id, "name")}
                    label="Name"
                    value={configuration.name}
                    onChange={(name) => edit({ name })}
                  />
                  <TextField
                    id={runFieldId(configuration.id, "command")}
                    label="Command"
                    code
                    value={configuration.command}
                    onChange={(command) => edit({ command })}
                  />
                </div>
              </li>
            )
          })}
        </EditList>
      </EnvironmentSection>
      <EnvironmentSection {...environmentSections.services}>
        <EditList>
          {draft.services.map((service, index) => {
            const original = manifest.services.find(
              ({ id }) => id === service.id
            )
            return (
              <ContainerFields
                key={service.id}
                scope="service"
                container={service}
                kind={original?.kind ?? "dependency"}
                image={original?.container.image}
                built={Boolean(original?.container.build)}
                commandHint="Leave empty to run the image's own command."
                onChange={(next) =>
                  update({ services: replace(draft.services, index, next) })
                }
              />
            )
          })}
        </EditList>
      </EnvironmentSection>
      {draft.devices?.length ? <EnvironmentSection title="Devices" description="Build commands and app identifiers for local devices."><div className="grid gap-4">{draft.devices.map((target, index) => <DeviceTargetFields key={target.id} target={target} onChange={(next) => update({ devices: replace(draft.devices!, index, next) })} />)}</div></EnvironmentSection> : null}
      {draft.setup.length ? (
        <EnvironmentSection {...environmentSections.setup}>
          <EditList>
            {draft.setup.map((task, index) => {
              const original = manifest.setup.find(({ id }) => id === task.id)
              return (
                <ContainerFields
                  key={task.id}
                  scope="task"
                  container={task}
                  kind="task"
                  image={original?.container.image}
                  built={Boolean(original?.container.build)}
                  onChange={(next) =>
                    update({ setup: replace(draft.setup, index, next) })
                  }
                />
              )
            })}
          </EditList>
        </EnvironmentSection>
      ) : null}
    </div>
  )
}

function ContainerFields({
  built,
  commandHint,
  container,
  onChange,
  scope,
  image,
  kind,
}: {
  built: boolean
  commandHint?: string
  container: DraftContainer
  onChange(container: DraftContainer): void
  scope: "service" | "task"
  image?: string
  kind: EnvironmentKind
}) {
  const field = (name: string) => containerFieldId(scope, container.id, name)
  return (
    <li className="grid gap-3 p-4">
      <ItemHeading kind={kind} name={container.id} image={image} />
      {built ? (
        <p className="text-xs text-muted-foreground">
          Built from the project&apos;s Dockerfile. Change the build in the JSON
          view.
        </p>
      ) : (
        <TextField
          id={field("image")}
          label="Image"
          code
          value={container.image}
          onChange={(image) => onChange({ ...container, image })}
        />
      )}
      <TextAreaField
        id={field("command")}
        label="Command"
        hint={commandHint}
        value={container.command}
        onChange={(command) => onChange({ ...container, command })}
      />
      {container.ports.length ? (
        <div className="flex flex-wrap gap-3">
          {container.ports.map((port, index) => (
            <TextField
              key={port.endpointId}
              id={field(`port-${port.endpointId}`)}
              label="Port"
              labelHint={port.endpointId}
              code
              numeric
              className="w-32"
              value={port.port}
              onChange={(value) =>
                onChange({
                  ...container,
                  ports: container.ports.map((current, position) =>
                    position === index ? { ...current, port: value } : current
                  ),
                })
              }
            />
          ))}
        </div>
      ) : null}
      <TextAreaField
        id={field("environment")}
        label="Environment"
        hint="One KEY=value per line."
        value={container.environment}
        onChange={(environment) => onChange({ ...container, environment })}
      />
    </li>
  )
}

function useFieldError(id: string) {
  const error = React.useContext(FieldErrorContext)
  return error?.fieldId === id ? error.message : undefined
}

function TextField({
  className,
  code,
  id,
  label,
  labelHint,
  numeric,
  onChange,
  value,
}: {
  className?: string
  code?: boolean
  id: string
  label: string
  labelHint?: string
  numeric?: boolean
  onChange(value: string): void
  value: string
}) {
  const error = useFieldError(id)
  return (
    <div className={cn("grid content-start gap-1.5", className)}>
      <Label htmlFor={id}>
        {label}
        {labelHint ? (
          <span className="font-normal text-muted-foreground">{labelHint}</span>
        ) : null}
      </Label>
      <Input
        id={id}
        value={value}
        spellCheck={false}
        inputMode={numeric ? "numeric" : undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        className={cn(code && "font-mono text-xs tabular-nums md:text-xs")}
        onChange={(event) => onChange(event.target.value)}
      />
      <FieldMessage id={id} error={error} />
    </div>
  )
}

function TextAreaField({
  hint,
  id,
  label,
  onChange,
  value,
}: {
  hint?: string
  id: string
  label: string
  onChange(value: string): void
  value: string
}) {
  const error = useFieldError(id)
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        id={id}
        value={value}
        spellCheck={false}
        rows={Math.min(8, Math.max(2, value.split("\n").length))}
        className="font-mono text-xs leading-relaxed md:text-xs"
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={
          error ? `${id}-error` : hint ? `${id}-hint` : undefined
        }
      />
      <FieldMessage id={id} error={error} hint={hint} />
    </div>
  )
}

function FieldMessage({
  error,
  hint,
  id,
}: {
  error?: string
  hint?: string
  id: string
}) {
  if (error)
    return (
      <span id={`${id}-error`} className="text-xs text-destructive">
        {error}
      </span>
    )
  if (!hint) return null
  return (
    <span id={`${id}-hint`} className="text-xs text-muted-foreground">
      {hint}
    </span>
  )
}

function EditList({ children }: { children: React.ReactNode }) {
  return <ul className="divide-y rounded-xl border bg-card">{children}</ul>
}

function ItemHeading({
  image,
  kind,
  name,
}: {
  image?: string
  kind: EnvironmentKind
  name: string
}) {
  return (
    <div className="flex items-center gap-3">
      <KindIcon kind={kind} image={image} className="size-4" />
      <span className="text-sm font-semibold">{name}</span>
      <span className={cn("text-xs font-medium", environmentKinds[kind].text)}>
        {environmentKinds[kind].label}
      </span>
    </div>
  )
}

function messageOf(cause: unknown) {
  return cause instanceof Error ? cause.message : "The setup is not valid."
}
