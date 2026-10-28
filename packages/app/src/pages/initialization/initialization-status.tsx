import { ChevronRightIcon, LoaderCircleIcon } from "lucide-react"

import { navigate } from "@/components/navigation/navigation"
import type { ProjectInitializationAvailability } from "@/components/project-initialization/project-initialization-availability"
import type { ProjectInitializationProgress } from "@/components/project-initialization/project-initialization-progress"
import { ProgressNotificationBody } from "@/components/shared/progress-notification"
import type { CloudProjectInitialization } from "@/context/cloud-auth"
import {
  blockedInitialization,
  type BlockedInitialization,
} from "@/components/project-initialization/initialization-blocked"
import { useAnimatedBorderEffect } from "@/hooks/use-animated-border-effect"
import { cn } from "@/lib/utils"
import { CornerLight, type CornerTone } from "./environment-kinds"
import { EnvironmentStartChain } from "./environment-start-chain"
import {
  manualEditReason,
  readableInitializationError,
  type SavedSetup,
} from "./initialization-setup-draft"

// One block that says where the project's environment stands and what to
// do next. Its corner light follows the state; once ready, it shows the
// order a story's preview starts its containers.

export function InitializationStatus({
  availability,
  initialization,
  progress,
  setup,
}: {
  availability: ProjectInitializationAvailability
  initialization?: CloudProjectInitialization
  progress?: ProjectInitializationProgress
  setup?: SavedSetup
}) {
  if (availability === "running")
    return <RunningStatus progress={progress} initialization={initialization} />
  if (availability === "ready" && initialization)
    return <ReadyStatus initialization={initialization} setup={setup} />
  if (initialization?.status === "error") {
    const blocked = blockedInitialization(initialization.error)
    return blocked ? (
      <BlockedStatus blocked={blocked} initialization={initialization} />
    ) : (
      <FailedStatus initialization={initialization} />
    )
  }
  if (initialization?.status === "running")
    return (
      <StatusBlock
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
    <StatusBlock tone="neutral" title="This project has not been analyzed yet">
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
      tone="running"
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
  setup,
}: {
  initialization: CloudProjectInitialization
  setup?: SavedSetup
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
  const chain = setup ? <EnvironmentStartChain setup={setup} /> : undefined
  if (!risks.length)
    return (
      <StatusBlock tone="success" title="Ready" meta={meta} footer={chain}>
        <p>
          Each story gets its own containers and a live preview. They start in
          this order:
        </p>
        {repaired ? <p>Last repaired by Blame: {repaired}</p> : null}
      </StatusBlock>
    )
  return (
    <StatusBlock
      tone="warning"
      footer={chain}
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

function BlockedStatus({
  blocked,
  initialization,
}: {
  blocked: BlockedInitialization
  initialization: CloudProjectInitialization
}) {
  const at = initialization.updatedAt ?? initialization.createdAt
  return (
    <StatusBlock
      tone="warning"
      title={blocked.title}
      meta={`Stopped ${relativeDate(at)}`}
    >
      <p className="text-foreground">{blocked.summary}</p>
      <div className="grid gap-0.5">
        <span className="text-xs font-medium text-foreground">
          What you can do
        </span>
        <p>{blocked.userAction}</p>
      </div>
      <p>
        Then run the analysis again. Until it succeeds, stories run in Direct
        mode, in your project folder.
      </p>
      {blocked.evidence ? (
        <ErrorDetails label="What Blame found" text={blocked.evidence} />
      ) : null}
    </StatusBlock>
  )
}

function ErrorDetails({ label, text }: { label: string; text: string }) {
  return (
    <details className="group">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-xs select-none hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon
          aria-hidden
          className="size-3.5 transition-transform duration-150 group-open:rotate-90"
        />
        {label}
      </summary>
      <pre className="mt-1.5 font-mono text-xs break-words whitespace-pre-wrap text-foreground/80">
        {text}
      </pre>
    </details>
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
      tone="danger"
      title="The last analysis failed"
      meta={`Failed ${relativeDate(failedAt)}`}
    >
      <p className="text-foreground">
        {readableInitializationError(initialization.error)}
      </p>
      <p>
        Stories run in Direct mode, in your project folder, until an analysis
        succeeds. Run it again; if it keeps failing, try another model in{" "}
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
        <ErrorDetails label="Error details" text={initialization.error} />
      ) : null}
    </StatusBlock>
  )
}

const tones = {
  neutral: { ring: "border-muted-foreground/60", light: "idle" },
  running: { ring: "", light: undefined },
  success: { ring: "border-emerald-500", light: "ready" },
  warning: { ring: "border-amber-500", light: "warning" },
  danger: { ring: "border-rose-500", light: "failed" },
} as const satisfies Record<
  string,
  { ring: string; light: CornerTone | undefined }
>

function StatusBlock({
  children,
  footer,
  meta,
  title,
  tone,
}: {
  children: React.ReactNode
  footer?: React.ReactNode
  meta?: string
  title: string
  tone: keyof typeof tones
}) {
  const running = tone === "running"
  // While Blame analyzes, the border turns like the agent's final replies.
  const effectRef = useAnimatedBorderEffect(
    running ? "agent-response" : undefined
  )
  const light = tones[tone].light
  return (
    <div
      ref={effectRef}
      className={cn(running && "agent-response-effect")}
      style={
        running
          ? ({ "--radius-3xl": "var(--radius-xl)" } as React.CSSProperties)
          : undefined
      }
    >
      <section
        aria-label="Preview environment status"
        className={cn("relative rounded-xl bg-card", !running && "border")}
      >
        {light ? <CornerLight tone={light} width="30%" height="140%" /> : null}
        <div className="grid gap-2.5 px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
            <div className="flex min-w-0 items-center gap-2.5">
              {running ? (
                <LoaderCircleIcon
                  aria-hidden
                  className="size-3.5 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
                />
              ) : (
                <span
                  aria-hidden
                  className={cn(
                    "size-3 shrink-0 rounded-full border-2",
                    tones[tone].ring
                  )}
                />
              )}
              <h3 className="text-base font-semibold">{title}</h3>
            </div>
            {meta ? (
              <span className="text-xs text-muted-foreground tabular-nums">
                {meta}
              </span>
            ) : null}
          </div>
          <div className="grid gap-2 pl-5.5 text-sm text-muted-foreground">
            {children}
          </div>
        </div>
        {footer ? (
          <div className="rounded-b-xl border-t bg-muted/30 px-5 py-4">
            {footer}
          </div>
        ) : null}
      </section>
    </div>
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
