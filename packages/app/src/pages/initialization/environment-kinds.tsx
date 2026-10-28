import * as React from "react"
import {
  CogIcon,
  DatabaseIcon,
  MonitorIcon,
  PlayIcon,
  ServerIcon,
  SquareTerminalIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

// The colors and icons the Preview Environment page gives each kind of
// container, taken from the backlog's palette: blue is where the preview
// opens, like the stories that run.

export type EnvironmentKind =
  "preview" | "dependency" | "worker" | "task" | "run"

export const environmentKinds = {
  preview: {
    label: "Preview",
    text: "text-blue-600 dark:text-blue-300",
    tile: "bg-blue-500/12 text-blue-600 ring-blue-500/25 dark:text-blue-300",
  },
  dependency: {
    label: "Dependency",
    text: "text-violet-600 dark:text-violet-300",
    tile: "bg-violet-500/12 text-violet-600 ring-violet-500/25 dark:text-violet-300",
  },
  worker: {
    label: "Worker",
    text: "text-orange-600 dark:text-orange-300",
    tile: "bg-orange-500/12 text-orange-600 ring-orange-500/25 dark:text-orange-300",
  },
  task: {
    label: "Setup task",
    text: "text-amber-700 dark:text-amber-300",
    tile: "bg-amber-500/12 text-amber-700 ring-amber-500/25 dark:text-amber-300",
  },
  run: {
    label: "Run configuration",
    text: "text-emerald-700 dark:text-emerald-300",
    tile: "bg-emerald-500/12 text-emerald-700 ring-emerald-500/25 dark:text-emerald-300",
  },
} satisfies Record<EnvironmentKind, unknown>

const databaseImage =
  /postgres|mysql|maria|mongo|redis|valkey|clickhouse|elastic|opensearch|meili|couch|cassandra|neo4j|surreal/i

export function KindIcon({
  className,
  image,
  kind,
}: {
  className?: string
  image?: string
  kind: EnvironmentKind
}) {
  const Icon =
    kind === "preview"
      ? MonitorIcon
      : kind === "worker"
        ? CogIcon
        : kind === "task"
          ? SquareTerminalIcon
          : kind === "run"
            ? PlayIcon
            : image && databaseImage.test(image)
              ? DatabaseIcon
              : ServerIcon
  return <Icon aria-hidden className={className} />
}

export function KindTile({
  image,
  kind,
  size = "md",
}: {
  image?: string
  kind: EnvironmentKind
  size?: "sm" | "md"
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center ring-1 ring-inset",
        size === "md"
          ? "size-9 rounded-lg [&_svg]:size-4"
          : "size-6 rounded-md [&_svg]:size-3.5",
        environmentKinds[kind].tile
      )}
    >
      <KindIcon kind={kind} image={image} />
    </span>
  )
}

export const environmentSections = {
  runConfigurations: {
    title: "Run configurations",
    description: "What a story can start.",
  },
  services: {
    title: "Services",
    description: "Containers that run while a preview is open.",
  },
  setup: {
    title: "Setup tasks",
    description: "Run before the services, again when their inputs change.",
  },
}

export function EnvironmentSection({
  children,
  count,
  description,
  title,
}: {
  children: React.ReactNode
  count?: number
  description: string
  title: string
}) {
  const id = React.useId()
  return (
    <section aria-labelledby={id} className="grid gap-3">
      <header className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <h3 id={id} className="text-base font-semibold">
          {title}
        </h3>
        {count !== undefined ? (
          <Badge variant="secondary" className="tabular-nums">
            {count}
          </Badge>
        ) : null}
        <p className="text-xs text-muted-foreground">{description}</p>
      </header>
      {children}
    </section>
  )
}

/** The id of a container's card, so the start order can point at it. */
export function containerAnchor(type: "service" | "task", id: string) {
  return `environment-${type}-${id}`
}
