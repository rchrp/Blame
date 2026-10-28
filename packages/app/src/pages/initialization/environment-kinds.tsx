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

// One color per kind of container. It lights the top left corner of the
// container's card and its step in the start order, like the New project
// choices; icons stay neutral.

export type EnvironmentKind =
  "preview" | "dependency" | "worker" | "task" | "run"

export type CornerTone =
  EnvironmentKind | "ready" | "warning" | "failed" | "idle"

/** Hue and chroma of each tone's light, in OKLCH. */
const lights: Record<CornerTone, [number, number, number]> = {
  preview: [0.72, 0.16, 250],
  dependency: [0.72, 0.15, 295],
  worker: [0.78, 0.17, 55],
  task: [0.8, 0.14, 80],
  run: [0.75, 0.15, 165],
  ready: [0.75, 0.15, 165],
  warning: [0.8, 0.14, 80],
  failed: [0.7, 0.19, 18],
  idle: [0.7, 0, 0],
}

export const environmentKinds = {
  preview: { label: "Preview", text: "text-blue-600 dark:text-blue-300" },
  dependency: {
    label: "Dependency",
    text: "text-violet-600 dark:text-violet-300",
  },
  worker: { label: "Worker", text: "text-orange-600 dark:text-orange-300" },
  task: { label: "Setup task", text: "text-amber-700 dark:text-amber-300" },
  run: {
    label: "Run configuration",
    text: "text-emerald-700 dark:text-emerald-300",
  },
} satisfies Record<EnvironmentKind, { label: string; text: string }>

/**
 * The top left corner light of a card. Its parent needs `relative` and a
 * border radius.
 */
export function CornerLight({
  height,
  tone,
  width,
}: {
  /** Size of the light, as a share of the card; wide cards want less. */
  height?: string
  tone: CornerTone
  width?: string
}) {
  const [lightness, chroma, hue] = lights[tone]
  const style = {
    "--story-status-color": `oklch(${lightness} ${chroma} ${hue})`,
    "--story-status-glow-color": `oklch(${lightness - 0.06} ${chroma + 0.02} ${hue} / 28%)`,
    ...(width ? { "--corner-w": width } : {}),
    ...(height ? { "--corner-h": height } : {}),
  } as React.CSSProperties
  return (
    <span
      aria-hidden
      style={style}
      className="pointer-events-none absolute -inset-px rounded-[inherit]"
    >
      <span className="story-status-corner story-status-corner-glow" />
      <span className="story-status-corner" />
    </span>
  )
}

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
  return (
    <Icon
      aria-hidden
      className={cn("shrink-0 text-muted-foreground", className)}
    />
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
