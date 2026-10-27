import * as React from "react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import {
  appliedSetup,
  setupDraft,
  setupFromJson,
  setupJson,
  type DraftContainer,
  type SavedSetup,
  type SetupDraft,
} from "./initialization-setup-draft"

// What Blame runs for this project, in three lists, and the same lists as
// fields when editing. The JSON view covers whatever the fields do not.

const kindLabels = {
  preview: "Preview",
  dependency: "Dependency",
  worker: "Worker",
} as const

export function InitializationSetupView({ setup }: { setup: SavedSetup }) {
  const manifest = setup.previewManifest
  return (
    <div className="grid gap-8">
      <SetupSection
        title="Run configurations"
        description="What a story can start, and where its preview opens."
      >
        {setup.runConfigurations.map((configuration) => (
          <li key={configuration.id} className="grid gap-1.5 px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{configuration.name}</span>
              {configuration.default ? (
                <Badge variant="secondary">Default</Badge>
              ) : null}
            </div>
            <Code>{configuration.command}</Code>
            <p className="text-xs text-muted-foreground">
              {configuration.services.length
                ? `Starts ${configuration.services.join(", ")}`
                : "Runs on this computer"}
              {configuration.previewService
                ? ` · preview from ${configuration.previewService}`
                : ""}
            </p>
          </li>
        ))}
      </SetupSection>
      <SetupSection
        title="Services"
        description="Containers that keep running while a preview is open."
      >
        {manifest.services.map((service) => (
          <li key={service.id} className="grid gap-2 px-4 py-3">
            <ItemHeading id={service.id} badge={kindLabels[service.kind]} />
            <Details>
              <Detail label="Image">
                <Code>{containerLabel(service.container)}</Code>
              </Detail>
              <Detail label="Command">
                {service.command ? (
                  <Code>{service.command}</Code>
                ) : (
                  <span>The image&apos;s own</span>
                )}
              </Detail>
              {service.endpoints.length ? (
                <Detail label="Ports">
                  <span className="tabular-nums">
                    {service.endpoints
                      .map(({ port, protocol }) => `${port} ${protocol}`)
                      .join(" · ")}
                  </span>
                </Detail>
              ) : null}
              <EnvironmentDetail environment={service.environment} />
            </Details>
          </li>
        ))}
      </SetupSection>
      {manifest.setup.length ? (
        <SetupSection
          title="Setup tasks"
          description="One-off steps before the services start: installs, migrations, builds. They rerun only when what they depend on changes."
        >
          {manifest.setup.map((task) => (
            <li key={task.id} className="grid gap-2 px-4 py-3">
              <ItemHeading
                id={task.id}
                badge={
                  task.dependsOn?.length
                    ? `After ${task.dependsOn.join(", ")}`
                    : undefined
                }
              />
              <Details>
                <Detail label="Image">
                  <Code>{containerLabel(task.container)}</Code>
                </Detail>
                <Detail label="Command">
                  <Code>{task.command}</Code>
                </Detail>
                <EnvironmentDetail environment={task.environment} />
              </Details>
            </li>
          ))}
        </SetupSection>
      ) : null}
    </div>
  )
}

export function InitializationSetupEditor({
  saved,
  onCancel,
  onSave,
}: {
  saved: SavedSetup
  onCancel(): void
  onSave(setup: SavedSetup): Promise<void>
}) {
  const [base, setBase] = React.useState(saved)
  const [draft, setDraft] = React.useState(() => setupDraft(saved))
  const [view, setView] = React.useState<"form" | "json">("form")
  const [json, setJson] = React.useState("")
  const [error, setError] = React.useState<string>()
  const [saving, setSaving] = React.useState(false)

  const current = () =>
    view === "json" ? setupFromJson(json) : appliedSetup(base, draft)

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
      setView(next as "form" | "json")
    } catch (cause) {
      setError(messageOf(cause))
    }
  }

  const save = async () => {
    let setup: SavedSetup
    try {
      setup = current()
    } catch (cause) {
      setError(messageOf(cause))
      return
    }
    setSaving(true)
    setError(undefined)
    try {
      await onSave(setup)
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3">
        <div className="grid gap-0.5">
          <span className="text-sm font-medium">Editing the setup</span>
          <span className="text-xs text-muted-foreground">
            Stories started from now on use it. Blame checks it before saving.
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Tabs value={view} onValueChange={switchView}>
            <TabsList>
              <TabsTrigger value="form">Fields</TabsTrigger>
              <TabsTrigger value="json">JSON</TabsTrigger>
            </TabsList>
          </Tabs>
          <Button variant="ghost" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? "Saving…" : "Save setup"}
          </Button>
        </div>
      </div>
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
            onChange={(event) => setJson(event.target.value)}
            spellCheck={false}
            className="min-h-[32rem] font-mono text-xs leading-relaxed"
          />
        </div>
      ) : (
        <SetupForm saved={base} draft={draft} onChange={setDraft} />
      )}
    </div>
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
      <SetupSection title="Run configurations">
        {draft.runConfigurations.map((configuration, index) => (
          <li key={configuration.id} className="grid gap-3 px-4 py-3">
            <ItemHeading id={configuration.id} />
            <div className="grid gap-3 sm:grid-cols-[minmax(0,14rem)_1fr]">
              <TextField
                id={`run-${configuration.id}-name`}
                label="Name"
                value={configuration.name}
                onChange={(name) =>
                  update({
                    runConfigurations: replace(draft.runConfigurations, index, {
                      ...configuration,
                      name,
                    }),
                  })
                }
              />
              <TextField
                id={`run-${configuration.id}-command`}
                label="Command"
                code
                value={configuration.command}
                onChange={(command) =>
                  update({
                    runConfigurations: replace(draft.runConfigurations, index, {
                      ...configuration,
                      command,
                    }),
                  })
                }
              />
            </div>
          </li>
        ))}
      </SetupSection>
      <SetupSection title="Services">
        {draft.services.map((service, index) => {
          const original = manifest.services.find(({ id }) => id === service.id)
          return (
            <ContainerFields
              key={service.id}
              container={service}
              badge={original ? kindLabels[original.kind] : undefined}
              built={Boolean(original?.container.build)}
              commandHint="Leave empty to run the image's own command."
              onChange={(next) =>
                update({ services: replace(draft.services, index, next) })
              }
            />
          )
        })}
      </SetupSection>
      {draft.setup.length ? (
        <SetupSection title="Setup tasks">
          {draft.setup.map((task, index) => (
            <ContainerFields
              key={task.id}
              container={task}
              built={Boolean(
                manifest.setup.find(({ id }) => id === task.id)?.container.build
              )}
              onChange={(next) =>
                update({ setup: replace(draft.setup, index, next) })
              }
            />
          ))}
        </SetupSection>
      ) : null}
    </div>
  )
}

function ContainerFields({
  badge,
  built,
  commandHint,
  container,
  onChange,
}: {
  badge?: string
  built: boolean
  commandHint?: string
  container: DraftContainer
  onChange(container: DraftContainer): void
}) {
  const id = `container-${container.id}`
  return (
    <li className="grid gap-3 px-4 py-3">
      <ItemHeading id={container.id} badge={badge} />
      {built ? (
        <p className="text-xs text-muted-foreground">
          Built from the project&apos;s Dockerfile. Change the build in the JSON
          view.
        </p>
      ) : (
        <TextField
          id={`${id}-image`}
          label="Image"
          code
          value={container.image}
          onChange={(image) => onChange({ ...container, image })}
        />
      )}
      <TextAreaField
        id={`${id}-command`}
        label="Command"
        hint={commandHint}
        value={container.command}
        onChange={(command) => onChange({ ...container, command })}
      />
      {container.ports.length ? (
        <div className="flex flex-wrap gap-3">
          {container.ports.map((port, index) => (
            <div key={port.endpointId} className="grid w-28 gap-1.5">
              <Label htmlFor={`${id}-port-${port.endpointId}`}>
                Port · {port.endpointId}
              </Label>
              <Input
                id={`${id}-port-${port.endpointId}`}
                inputMode="numeric"
                value={port.port}
                className="font-mono tabular-nums"
                onChange={(event) =>
                  onChange({
                    ...container,
                    ports: container.ports.map((current, position) =>
                      position === index
                        ? { ...current, port: event.target.value }
                        : current
                    ),
                  })
                }
              />
            </div>
          ))}
        </div>
      ) : null}
      <TextAreaField
        id={`${id}-environment`}
        label="Environment"
        hint="One KEY=value per line."
        value={container.environment}
        onChange={(environment) => onChange({ ...container, environment })}
      />
    </li>
  )
}

function TextField({
  code,
  id,
  label,
  onChange,
  value,
}: {
  code?: boolean
  id: string
  label: string
  onChange(value: string): void
  value: string
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        spellCheck={false}
        className={code ? "font-mono text-xs" : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
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
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        id={id}
        value={value}
        spellCheck={false}
        rows={Math.min(8, Math.max(2, value.split("\n").length))}
        className="font-mono text-xs leading-relaxed"
        onChange={(event) => onChange(event.target.value)}
        aria-describedby={hint ? `${id}-hint` : undefined}
      />
      {hint ? (
        <span id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </span>
      ) : null}
    </div>
  )
}

function SetupSection({
  children,
  description,
  title,
}: {
  children: React.ReactNode
  description?: string
  title: string
}) {
  return (
    <section className="grid gap-3">
      <div className="grid gap-0.5">
        <h3 className="text-sm font-medium">{title}</h3>
        {description ? (
          <p className="text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <ul className="divide-y rounded-lg border bg-card">{children}</ul>
    </section>
  )
}

function ItemHeading({ badge, id }: { badge?: string; id: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-mono text-sm font-medium">{id}</span>
      {badge ? <Badge variant="outline">{badge}</Badge> : null}
    </div>
  )
}

function Details({ children }: { children: React.ReactNode }) {
  return (
    <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
      {children}
    </dl>
  )
}

function Detail({
  children,
  label,
}: {
  children: React.ReactNode
  label: string
}) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  )
}

function EnvironmentDetail({
  environment,
}: {
  environment?: Record<string, string>
}) {
  const entries = Object.entries(environment ?? {})
  if (!entries.length) return null
  return (
    <Detail label="Environment">
      <details className="group">
        <summary className="cursor-pointer text-muted-foreground select-none hover:text-foreground">
          {entries.length === 1 ? "1 variable" : `${entries.length} variables`}
        </summary>
        <div className="mt-1.5 grid gap-0.5">
          {entries.map(([key, value]) => (
            <Code key={key}>{`${key}=${value}`}</Code>
          ))}
        </div>
      </details>
    </Detail>
  )
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="font-mono text-xs break-words whitespace-pre-wrap text-foreground/90">
      {children}
    </code>
  )
}

function containerLabel(
  container: SavedSetup["previewManifest"]["services"][number]["container"]
) {
  if (container.image) return container.image
  const build = container.build
  return build
    ? `Dockerfile ${build.dockerfile ?? "Dockerfile"} in ${build.context}`
    : "—"
}

function messageOf(cause: unknown) {
  return cause instanceof Error ? cause.message : "The setup is not valid."
}
