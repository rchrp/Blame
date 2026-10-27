import {
  ChevronRightIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  TriangleAlertIcon,
} from "lucide-react"

import { navigate } from "@/components/navigation/navigation"
import type { ProjectInitializationAvailability } from "@/components/project-initialization/project-initialization-availability"
import type { ProjectInitializationProgress } from "@/components/project-initialization/project-initialization-progress"
import { ProgressNotificationBody } from "@/components/shared/progress-notification"
import type { CloudProjectInitialization } from "@/context/cloud-auth"
import { cn } from "@/lib/utils"
import {
  manualEditReason,
  readableInitializationError,
} from "./initialization-setup-draft"

// One block that says where the project's setup stands and what to do
// next. Its tone follows the state; the actions live in the page header.

export function InitializationStatus({
  availability,
  initialization,
  progress,
}: {
  availability: ProjectInitializationAvailability
  initialization?: CloudProjectInitialization
  progress?: ProjectInitializationProgress
}) {
  if (availability === "running")
    return <RunningStatus progress={progress} initialization={initialization} />
  if (availability === "ready" && initialization)
    return <ReadyStatus initialization={initialization} />
  if (initialization?.status === "error")
    return <FailedStatus initialization={initialization} />
  if (initialization?.status === "running")
    return (
      <StatusBlock
        icon={<CircleAlertIcon />}
        tone="warning"
        title="The last analysis stopped before it finished"
      >
        <p>
          Blame was probably closed while it ran. Run it again to give this
          project a preview setup. Until then, stories run in Direct mode, in
          your project folder.
        </p>
      </StatusBlock>
    )
  return (
    <StatusBlock
      icon={<CircleDashedIcon />}
      tone="neutral"
      title="This project has not been analyzed yet"
    >
      <p>
        The analysis reads the repository and writes a setup: what to install,
        which services to start, and where each story&apos;s preview opens.
        Stories need it to run in containers; without it they run in Direct
        mode, in your project folder.
      </p>
    </StatusBlock>
  )
}

function RunningStatus({
  initialization,
  progress,
}: {
  initialization?: CloudProjectInitialization
  progress?: ProjectInitializationProgress
}) {
  const startedAt = progress
    ? new Date(progress.startedAt).toISOString()
    : (initialization?.updatedAt ?? initialization?.createdAt)
  return (
    <StatusBlock
      icon={
        <CircleDashedIcon className="animate-spin [animation-duration:3s]" />
      }
      tone="neutral"
      title="Analyzing the project"
      meta={startedAt ? `Started ${relativeDate(startedAt)}` : undefined}
    >
      <ProgressNotificationBody
        label={progress?.label ?? "Running in another Blame window"}
        percent={progress?.percent}
        detail={progress?.detail}
      />
      <p>
        Stories in Direct mode can start now. The others wait for the setup.
      </p>
    </StatusBlock>
  )
}

function ReadyStatus({
  initialization,
}: {
  initialization: CloudProjectInitialization
}) {
  const risks = initialization.previewManifest?.risks ?? []
  const savedAt = initialization.updatedAt ?? initialization.createdAt
  const edited = initialization.repairReason === manualEditReason
  const meta = [
    edited
      ? `Edited by hand ${relativeDate(savedAt)}`
      : `Saved ${relativeDate(savedAt)}`,
    initialization.agentModelId
      ? `analyzed with ${initialization.agentModelId}`
      : undefined,
  ]
    .filter(Boolean)
    .join(" · ")
  const repaired =
    initialization.repairReason && !edited ? initialization.repairReason : null
  if (!risks.length)
    return (
      <StatusBlock
        icon={<CircleCheckIcon />}
        tone="success"
        title="Ready"
        meta={meta}
      >
        <p>
          Stories run in containers with a live preview, using the setup below.
        </p>
        {repaired ? <p>Last repaired by Blame: {repaired}</p> : null}
      </StatusBlock>
    )
  return (
    <StatusBlock
      icon={<TriangleAlertIcon />}
      tone="warning"
      title={
        risks.length === 1
          ? "Ready, with one point to check"
          : `Ready, with ${risks.length} points to check`
      }
      meta={meta}
    >
      <ul className="grid gap-1.5">
        {risks.map((risk) => (
          <li key={risk.message} className="flex gap-2">
            <span
              aria-hidden
              className="mt-[0.55em] size-1 shrink-0 rounded-full bg-current opacity-70"
            />
            <span className="text-foreground">{risk.message}</span>
          </li>
        ))}
      </ul>
      <p>
        Stories still run. If a preview misbehaves, fix the setup below or run
        the analysis again.
      </p>
      {repaired ? <p>Last repaired by Blame: {repaired}</p> : null}
    </StatusBlock>
  )
}

function FailedStatus({
  initialization,
}: {
  initialization: CloudProjectInitialization
}) {
  const failedAt = initialization.updatedAt ?? initialization.createdAt
  return (
    <StatusBlock
      icon={<CircleAlertIcon />}
      tone="danger"
      title="The last analysis failed"
      meta={`Failed ${relativeDate(failedAt)}`}
    >
      <p className="text-foreground">
        {readableInitializationError(initialization.error)}
      </p>
      <p>
        Stories run in Direct mode, in your project folder, until an analysis
        succeeds. Run it again: a second try often succeeds. If it keeps
        failing, try another model in{" "}
        <button
          type="button"
          className="text-foreground underline underline-offset-3 hover:text-foreground/80"
          onClick={() => navigate("/settings")}
        >
          Settings
        </button>
        .
      </p>
      {initialization.error ? (
        <details className="group">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-xs select-none hover:text-foreground [&::-webkit-details-marker]:hidden">
            <ChevronRightIcon
              aria-hidden
              className="size-3.5 transition-transform duration-150 group-open:rotate-90"
            />
            Error details
          </summary>
          <pre className="mt-1.5 font-mono text-xs break-words whitespace-pre-wrap text-foreground/80">
            {initialization.error}
          </pre>
        </details>
      ) : null}
    </StatusBlock>
  )
}

const tones = {
  neutral: "border-border",
  success: "border-border [&_[data-slot=status-icon]]:text-emerald-500",
  warning:
    "border-amber-500/30 bg-amber-500/[0.06] [&_[data-slot=status-icon]]:text-amber-600 dark:[&_[data-slot=status-icon]]:text-amber-400",
  danger:
    "border-destructive/30 bg-destructive/[0.06] [&_[data-slot=status-icon]]:text-destructive",
}

function StatusBlock({
  children,
  icon,
  meta,
  title,
  tone,
}: {
  children: React.ReactNode
  icon: React.ReactNode
  meta?: string
  title: string
  tone: keyof typeof tones
}) {
  return (
    <section
      aria-label="Initialization status"
      className={cn(
        "grid grid-cols-[auto_1fr] gap-x-3 rounded-lg border bg-card px-4 py-3.5",
        tones[tone]
      )}
    >
      <span
        data-slot="status-icon"
        className="mt-0.5 text-muted-foreground [&_svg]:size-4"
      >
        {icon}
      </span>
      <div className="grid min-w-0 gap-2.5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
          <h3 className="text-sm font-medium">{title}</h3>
          {meta ? (
            <span className="text-xs text-muted-foreground tabular-nums">
              {meta}
            </span>
          ) : null}
        </div>
        <div className="grid gap-2 text-sm text-muted-foreground">
          {children}
        </div>
      </div>
    </section>
  )
}

const relativeFormat = new Intl.RelativeTimeFormat("en", { numeric: "auto" })

function relativeDate(value: string) {
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return ""
  const minutes = Math.round((time - Date.now()) / 60_000)
  if (Math.abs(minutes) < 60) return relativeFormat.format(minutes, "minute")
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return relativeFormat.format(hours, "hour")
  return relativeFormat.format(Math.round(hours / 24), "day")
}
