import * as React from "react"
import { ChevronDownIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import {
  containerAnchor,
  EnvironmentSection,
  environmentKinds,
  environmentSections,
  CornerLight,
  KindIcon,
  type EnvironmentKind,
} from "./environment-kinds"
import type { SavedSetup } from "./initialization-setup-draft"

// What Blame runs for the project, as cards. Each card leads with what
// people look for (the name, what it is, where it listens) and folds what
// they rarely read (long commands, environment variables).

type Manifest = SavedSetup["previewManifest"]
type Service = Manifest["services"][number]
type Container = Service["container"]

const kindOrder = { preview: 0, worker: 1, dependency: 2 } as const

/** Commands up to this length show in full; longer ones fold. */
const shortCommand = 72

export function EnvironmentSetupView({ setup }: { setup: SavedSetup }) {
  const manifest = setup.previewManifest
  const services = [...manifest.services].sort(
    (a, b) => kindOrder[a.kind] - kindOrder[b.kind]
  )
  return (
    <div className="grid gap-10">
      <EnvironmentSection
        {...environmentSections.runConfigurations}
        count={setup.runConfigurations.length}
      >
        <div className="grid gap-3 md:grid-cols-2">
          {setup.runConfigurations.map((configuration) => (
            <article
              key={configuration.id}
              className="relative flex items-start gap-3 rounded-xl border bg-card p-4"
            >
              <KindIcon kind="run" className="mt-1 size-4.5" />
              <div className="grid min-w-0 flex-1 gap-2">
                <div className="grid gap-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="text-base font-semibold">
                      {configuration.name}
                    </h4>
                    {configuration.default ? (
                      <span className="rounded-md border px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
                        Default
                      </span>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {runSummary(configuration)}
                  </p>
                </div>
                <CodeLine>{configuration.command}</CodeLine>
              </div>
            </article>
          ))}
        </div>
      </EnvironmentSection>
      <EnvironmentSection
        {...environmentSections.services}
        count={services.length}
      >
        <div className="grid items-start gap-3 md:grid-cols-2">
          {services.map((service) => (
            <ContainerCard
              key={service.id}
              anchor={containerAnchor("service", service.id)}
              name={service.id}
              kind={service.kind}
              container={service.container}
              command={service.command}
              environment={service.environment}
              ports={service.endpoints}
            />
          ))}
        </div>
      </EnvironmentSection>
      {manifest.setup.length ? (
        <EnvironmentSection
          {...environmentSections.setup}
          count={manifest.setup.length}
        >
          <div className="grid items-start gap-3 md:grid-cols-2">
            {manifest.setup.map((task) => (
              <ContainerCard
                key={task.id}
                anchor={containerAnchor("task", task.id)}
                name={task.id}
                kind="task"
                container={task.container}
                command={task.command}
                environment={task.environment}
                after={task.dependsOn}
              />
            ))}
          </div>
        </EnvironmentSection>
      ) : null}
    </div>
  )
}

function ContainerCard({
  after,
  anchor,
  command,
  container,
  environment,
  kind,
  name,
  ports = [],
}: {
  after?: string[]
  anchor: string
  command?: string
  container: Container
  environment?: Record<string, string>
  kind: EnvironmentKind
  name: string
  ports?: Service["endpoints"]
}) {
  const [open, setOpen] = React.useState<"command" | "environment">()
  const panelId = React.useId()
  const variables = Object.entries(environment ?? {})
  const folded = Boolean(
    command && (command.length > shortCommand || command.includes("\n"))
  )
  const toggle = (panel: "command" | "environment") =>
    setOpen((current) => (current === panel ? undefined : panel))

  return (
    <article
      id={anchor}
      tabIndex={-1}
      className={cn(
        "relative rounded-xl border bg-card transition-[border-color,box-shadow] duration-300 outline-none",
        "data-[pointed]:border-foreground/35 data-[pointed]:shadow-[0_0_0_3px] data-[pointed]:shadow-foreground/10"
      )}
    >
      {kind === "preview" ? <CornerLight tone="preview" /> : null}
      <div className="flex items-start gap-3 p-4">
        <KindIcon
          kind={kind}
          image={container.image}
          className="mt-1 size-4.5"
        />
        <div className="grid min-w-0 flex-1 gap-0.5">
          <h4 className="truncate text-base font-semibold">{name}</h4>
          <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span
              className={cn(
                "shrink-0 font-medium",
                environmentKinds[kind].text
              )}
            >
              {environmentKinds[kind].label}
            </span>
            <span aria-hidden>·</span>
            <span className="truncate font-mono" title={imageLabel(container)}>
              {imageLabel(container)}
            </span>
          </p>
        </div>
        {ports.length ? (
          <div className="flex shrink-0 flex-col items-end gap-1">
            {ports.map((port) => (
              <span
                key={port.id}
                className="inline-flex items-baseline gap-1 rounded-md border px-1.5 py-0.5 font-mono text-xs tabular-nums"
              >
                :{port.port}
                <span className="text-[0.6875rem] opacity-70">
                  {port.protocol}
                </span>
              </span>
            ))}
          </div>
        ) : null}
      </div>
      {command && !folded ? (
        <div className="px-4 pb-3">
          <CodeLine>{command}</CodeLine>
        </div>
      ) : null}
      {after?.length ? (
        <p className="px-4 pb-3 text-xs text-muted-foreground">
          Waits for {after.join(", ")}
        </p>
      ) : null}
      {folded || !command || variables.length ? (
        <div className="flex flex-wrap items-center gap-1 border-t px-2.5 py-1.5">
          {folded ? (
            <FoldButton
              open={open === "command"}
              controls={panelId}
              onClick={() => toggle("command")}
            >
              Command
            </FoldButton>
          ) : !command ? (
            <span className="px-1.5 py-1 text-xs text-muted-foreground">
              The image&apos;s own command
            </span>
          ) : null}
          {variables.length ? (
            <FoldButton
              open={open === "environment"}
              controls={panelId}
              onClick={() => toggle("environment")}
            >
              {variables.length === 1
                ? "1 variable"
                : `${variables.length} variables`}
            </FoldButton>
          ) : null}
        </div>
      ) : null}
      {open ? (
        <div id={panelId} className="px-4 pb-4">
          {open === "command" ? (
            <pre className="rounded-lg bg-muted/60 p-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-foreground/90 dark:bg-black/35">
              {command}
            </pre>
          ) : (
            <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-lg bg-muted/60 p-3 font-mono text-xs dark:bg-black/35">
              {variables.map(([key, value]) => (
                <React.Fragment key={key}>
                  <dt className="text-muted-foreground">{key}</dt>
                  <dd className="min-w-0 break-words text-foreground/90">
                    {value || (
                      <span className="text-muted-foreground">empty</span>
                    )}
                  </dd>
                </React.Fragment>
              ))}
            </dl>
          )}
        </div>
      ) : null}
    </article>
  )
}

function FoldButton({
  children,
  controls,
  onClick,
  open,
}: {
  children: React.ReactNode
  controls: string
  onClick(): void
  open: boolean
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={open ? controls : undefined}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
        open && "text-foreground"
      )}
    >
      {children}
      <ChevronDownIcon
        aria-hidden
        className={cn(
          "size-3.5 transition-transform duration-200",
          open && "rotate-180"
        )}
      />
    </button>
  )
}

export function CodeLine({ children }: { children: React.ReactNode }) {
  return (
    <code className="block w-fit max-w-full rounded-md bg-muted/60 px-2 py-1 font-mono text-xs break-words whitespace-pre-wrap text-foreground/90 dark:bg-black/35">
      {children}
    </code>
  )
}

function runSummary(configuration: SavedSetup["runConfigurations"][number]) {
  if (!configuration.services.length) return "Runs on this computer"
  const starts = `Starts ${configuration.services.join(", ")}`
  return configuration.previewService
    ? `${starts} · preview on ${configuration.previewService}`
    : starts
}

export function imageLabel(container: Container) {
  if (container.image) return container.image
  const build = container.build
  return build
    ? `${build.dockerfile ?? "Dockerfile"} in ${build.context}`
    : "No image"
}
