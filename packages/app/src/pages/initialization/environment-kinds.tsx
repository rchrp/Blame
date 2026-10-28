import * as React from "react"
import {
  CogIcon,
  DatabaseIcon,
  MonitorIcon,
  PlayIcon,
  ServerIcon,
  SquareTerminalIcon,
} from "lucide-react"

import { cn } from "@/lib/utils"

// One color per kind of container, for its label. The corner light, as on
// the New project choices, is kept for what matters most: the status and
// the service the preview opens. Icons stay neutral.

export type EnvironmentKind =
  "preview" | "dependency" | "worker" | "task" | "run"

export type CornerTone = "preview" | "ready" | "warning" | "failed" | "idle"

/** Lightness, chroma and hue of each light: Tailwind's 500 shades. */
const lights: Record<CornerTone, [number, number, number]> = {
  preview: [0.623, 0.214, 259.8],
  ready: [0.696, 0.17, 162.5],
  warning: [0.769, 0.188, 70.1],
  failed: [0.645, 0.246, 16.4],
  idle: [0.65, 0, 0],
}

export const environmentKinds = {
  preview: { label: "Preview", text: "text-blue-600 dark:text-blue-400" },
  dependency: {
    label: "Dependency",
    text: "text-violet-600 dark:text-violet-400",
  },
  worker: { label: "Worker", text: "text-orange-600 dark:text-orange-400" },
  task: { label: "Setup task", text: "text-amber-600 dark:text-amber-400" },
  run: {
    label: "Run configuration",
    text: "text-emerald-600 dark:text-emerald-400",
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
    "--story-status-glow-color": `oklch(${lightness} ${chroma} ${hue} / 35%)`,
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

/**
 * A part of the environment: its title and what it is on the left, its
 * items on the right, under a rule that marks where it starts.
 */
export function EnvironmentSection({
  children,
  description,
  title,
}: {
  children: React.ReactNode
  description: string
  title: string
}) {
  const id = React.useId()
  return (
    <section
      aria-labelledby={id}
      className="grid gap-4 border-t pt-8 md:grid-cols-[13rem_minmax(0,1fr)] md:gap-10"
    >
      <header className="grid content-start gap-1.5">
        <h3 id={id} className="font-heading text-lg font-semibold">
          {title}
        </h3>
        <p className="text-sm text-pretty text-muted-foreground">
          {description}
        </p>
      </header>
      <div className="min-w-0">{children}</div>
    </section>
  )
}

/** The id of a container's card, so the start order can point at it. */
export function containerAnchor(type: "service" | "task", id: string) {
  return `environment-${type}-${id}`
}
