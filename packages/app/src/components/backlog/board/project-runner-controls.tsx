import type { ProjectRunConfiguration } from "@blame/agent-runtime"
import {
  AppWindowIcon,
  ChevronDownIcon,
  LoaderCircleIcon,
  PlayIcon,
  RotateCwIcon,
  SquareAsteriskIcon,
  SquareIcon,
  SquareTerminalIcon,
  type LucideIcon,
} from "lucide-react"
import * as React from "react"

import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import type {
  ProjectRunnerControlStatus,
  ProjectRunnerPendingOperation,
} from "@/components/backlog/board/project-runner-types"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

// What the runner shows of its app: the same buttons, in the same order,
// in the header and in a story's preview. Variables belong to a story.
export type RunnerViewId = "preview" | "logs" | "variables"

export type RunnerView = {
  id: RunnerViewId
  active?: boolean
  // Something to see there now, such as a preview whose app answers: a
  // blue dot, selected or not.
  ready?: boolean
  // Why the view cannot show now.
  unavailable?: string
  onSelect: () => void
}

type ProjectRunnerControlsProps = {
  configurations: ProjectRunConfiguration[]
  disabled?: boolean
  pending?: ProjectRunnerPendingOperation
  selectedId?: string
  statusFor: (configurationId: string) => ProjectRunnerControlStatus
  onMenuOpenChange?: (open: boolean) => void
  onSelect: (configurationId: string) => void
  onStart: (configurationId: string, restart: boolean) => void
  onStop: (configurationId: string) => void
  // The selected app already runs outside Blame: Blame can neither rerun
  // nor stop it.
  runningOutside?: boolean
  // Why the selected app cannot start now (its port is held by another
  // app, which a dev server would silently step around).
  startBlocked?: string
  // Shown after the start and stop buttons.
  views?: RunnerView[]
}
type SelectedRunnerControlsProps = ProjectRunnerControlsProps & {
  selected: ProjectRunConfiguration
  status: ProjectRunnerControlStatus
}
type RunnerConfigurationActionProps = ProjectRunnerControlsProps & {
  configuration: ProjectRunConfiguration
  status: ProjectRunnerControlStatus
}

const runnerViewMeta: Record<
  RunnerViewId,
  { icon: LucideIcon; label: string; show: string }
> = {
  preview: { icon: AppWindowIcon, label: "Preview", show: "Show preview" },
  logs: {
    icon: SquareTerminalIcon,
    label: "Run logs",
    show: "Show run logs",
  },
  variables: {
    icon: SquareAsteriskIcon,
    label: "Variables",
    show: "Show variables",
  },
}

export const runnerViewIcon = (id: RunnerViewId) => runnerViewMeta[id].icon

const runnerGroupClassName = "rounded-lg border bg-muted p-0.5"

export function ProjectRunnerControls(props: ProjectRunnerControlsProps) {
  const selected = selectedConfiguration(props.configurations, props.selectedId)
  if (!selected) return null
  const status = props.statusFor(selected.id)
  return (
    <TooltipProvider>
      <ButtonGroup className={runnerGroupClassName}>
        <RunnerConfigurationMenu {...props} selected={selected} />
        <RunnerStartButton {...props} selected={selected} status={status} />
        <RunnerStopButton {...props} selected={selected} status={status} />
        {props.views?.length ? (
          <RunnerViewSwitch className="ml-1" views={props.views} />
        ) : null}
      </ButtonGroup>
    </TooltipProvider>
  )
}

// The views alone, while the runner's controls are not there yet.
export function RunnerViewGroup({ views }: { views: RunnerView[] }) {
  if (!views.length) return null
  return (
    <TooltipProvider>
      <ButtonGroup className={runnerGroupClassName}>
        <RunnerViewSwitch views={views} />
      </ButtonGroup>
    </TooltipProvider>
  )
}

// The views sit in a recess of the group, a switch whose knob slides to
// the one showing.
const runnerViewStep = "(1.75rem + 0.125rem)"

function RunnerViewSwitch({
  className,
  views,
}: {
  className?: string
  views: RunnerView[]
}) {
  const active = views.findIndex((view) => view.active)
  return (
    <div
      className={cn(
        "relative flex items-center gap-0.5 rounded-md! bg-foreground/[0.07] p-0.5 shadow-[inset_0_1px_2px_rgb(0_0_0/0.16)] dark:bg-black/35 dark:shadow-[inset_0_1px_3px_rgb(0_0_0/0.45)]",
        className
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute top-0.5 left-0.5 size-7 rounded-[5px] border border-transparent bg-background shadow-sm transition-[translate,opacity] duration-200 ease-out motion-reduce:transition-none dark:border-white/10 dark:bg-muted",
          active < 0 && "opacity-0"
        )}
        style={{
          translate: `calc(${Math.max(active, 0)} * ${runnerViewStep}) 0`,
        }}
      />
      {views.map((view) => (
        <RunnerViewButton key={view.id} view={view} />
      ))}
    </div>
  )
}

function RunnerViewButton({ view }: { view: RunnerView }) {
  const meta = runnerViewMeta[view.id]
  const Icon = meta.icon
  return (
    <RunnerIconTooltip
      label={view.unavailable ?? (view.active ? meta.label : meta.show)}
    >
      {/* A disabled button gets no pointer events: its tooltip needs one. */}
      <span className="relative inline-flex">
        <Button
          aria-label={view.ready ? `${meta.label}, ready` : meta.label}
          aria-pressed={Boolean(view.active)}
          className={cn(
            "relative size-7 rounded-[5px] text-muted-foreground hover:bg-foreground/5 hover:text-foreground dark:hover:bg-white/5",
            view.active &&
              "text-foreground hover:bg-transparent dark:hover:bg-transparent"
          )}
          disabled={Boolean(view.unavailable)}
          size="icon"
          type="button"
          variant="ghost"
          onClick={view.onSelect}
        >
          <Icon />
          {view.ready ? (
            <span
              aria-hidden="true"
              className="absolute top-1 right-1 size-1.5 rounded-full bg-sky-500 shadow-[0_0_0_1.5px_var(--muted)]"
            />
          ) : null}
        </Button>
      </span>
    </RunnerIconTooltip>
  )
}

function RunnerConfigurationMenu(
  props: ProjectRunnerControlsProps & { selected: ProjectRunConfiguration }
) {
  return (
    <DropdownMenu onOpenChange={props.onMenuOpenChange}>
      <RunnerConfigurationTrigger {...props} />
      <DropdownMenuContent align="end" className="min-w-64">
        <DropdownMenuLabel>Run configurations</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {props.configurations.map((configuration) => (
          <RunnerConfigurationItem
            key={configuration.id}
            {...props}
            configuration={configuration}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function RunnerConfigurationTrigger({
  disabled,
  pending,
  runningOutside,
  selected,
  statusFor,
}: ProjectRunnerControlsProps & { selected: ProjectRunConfiguration }) {
  const status = pendingStatus(selected.id, statusFor(selected.id), pending)
  return (
    <DropdownMenuTrigger asChild>
      <Button
        className="min-w-36 justify-between"
        disabled={disabled || Boolean(pending)}
        type="button"
        variant="ghost"
      >
        <span className="flex min-w-0 items-center gap-2">
          <ProjectRunnerStatusDot status={status} />
          <span className="truncate">{selected.name}</span>
          {runningOutside ? (
            <span className="shrink-0 text-xs font-normal text-muted-foreground">
              outside Blame
            </span>
          ) : null}
        </span>
        <ChevronDownIcon />
      </Button>
    </DropdownMenuTrigger>
  )
}

function RunnerConfigurationItem(
  props: ProjectRunnerControlsProps & {
    configuration: ProjectRunConfiguration
  }
) {
  const { configuration, pending, statusFor } = props
  const status = pendingStatus(
    configuration.id,
    statusFor(configuration.id),
    pending
  )
  return (
    <DropdownMenuItem
      className="py-1.5"
      disabled={props.disabled || Boolean(pending)}
      onSelect={() => props.onSelect(configuration.id)}
    >
      <ProjectRunnerStatusDot status={status} />
      <span className="flex-1 truncate">{configuration.name}</span>
      <RunnerConfigurationAction {...props} status={status} />
    </DropdownMenuItem>
  )
}

function RunnerConfigurationAction({
  configuration,
  disabled,
  pending,
  status,
  onStart,
  onStop,
}: RunnerConfigurationActionProps) {
  const running = status === "running"
  const loading = pending?.configurationId === configuration.id
  const run = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    if (running) onStop(configuration.id)
    else onStart(configuration.id, false)
  }
  return (
    <button
      aria-label={running ? "Stop configuration" : "Run configuration"}
      className="rounded-md p-1 hover:bg-foreground/10 disabled:opacity-50"
      disabled={disabled || Boolean(pending)}
      type="button"
      onPointerDown={run}
    >
      <RunnerActionIcon loading={loading} running={running} />
    </button>
  )
}

function RunnerStartButton(props: SelectedRunnerControlsProps) {
  const running = props.status === "running"
  const loading = isPendingStart(props.pending, props.selected.id)
  const disabled =
    props.disabled ||
    props.runningOutside ||
    (Boolean(props.startBlocked) && !running) ||
    Boolean(props.pending) ||
    isTransitioning(props.status)
  return (
    <RunnerIconTooltip
      label={
        props.runningOutside
          ? "Already running outside Blame"
          : props.startBlocked && !running
            ? props.startBlocked
            : running
              ? "Restart"
              : "Start"
      }
    >
      <Button
        aria-label={running ? "Restart" : "Start"}
        className={runnerStartClassName(running)}
        disabled={disabled}
        size="icon"
        type="button"
        onClick={() => props.onStart(props.selected.id, running)}
      >
        <RunnerStartIcon loading={loading} running={running} />
      </Button>
    </RunnerIconTooltip>
  )
}

function RunnerStopButton(props: SelectedRunnerControlsProps) {
  // A preview that is starting or failed still holds its runtime, a cloud
  // sandbox included: it can be stopped too.
  const running = props.status !== "stopped"
  const loading = isPendingStop(props.pending, props.selected.id)
  return (
    <RunnerIconTooltip label={loading ? "Stopping" : "Stop"}>
      <Button
        aria-label="Stop"
        className={runnerStopClassName(running || loading)}
        disabled={
          props.disabled ||
          props.runningOutside ||
          Boolean(props.pending) ||
          !running
        }
        size="icon"
        type="button"
        onClick={() => props.onStop(props.selected.id)}
      >
        {loading ? (
          <LoaderCircleIcon className="animate-spin" />
        ) : (
          <SquareIcon />
        )}
      </Button>
    </RunnerIconTooltip>
  )
}

export function ProjectRunnerStatusDot({
  status,
}: {
  status?: ProjectRunnerControlStatus
}) {
  const tone =
    status === "running"
      ? "bg-emerald-500"
      : status === "error"
        ? "bg-destructive"
        : isTransitioning(status)
          ? "animate-pulse bg-amber-500"
          : "bg-muted-foreground/45"
  return (
    <span
      className={`size-2 shrink-0 rounded-full ${tone}`}
      data-status={status ?? "stopped"}
    />
  )
}

export function RunnerIconTooltip({
  children,
  label,
}: {
  children: React.ReactElement
  label: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function RunnerActionIcon({
  loading,
  running,
}: {
  loading: boolean
  running: boolean
}) {
  if (loading) return <LoaderCircleIcon className="animate-spin" />
  if (running) return <SquareIcon className="text-destructive" />
  return <PlayIcon className="text-emerald-500" />
}

function RunnerStartIcon({
  loading,
  running,
}: {
  loading: boolean
  running: boolean
}) {
  if (loading) return <LoaderCircleIcon className="animate-spin" />
  if (running) return <RotateCwIcon />
  return <PlayIcon />
}

function pendingStatus(
  configurationId: string,
  status: ProjectRunnerControlStatus,
  pending?: ProjectRunnerPendingOperation
) {
  if (pending?.configurationId !== configurationId) return status
  return pending.action === "stop" ? "stopping" : "starting"
}

function isPendingStart(
  pending: ProjectRunnerPendingOperation | undefined,
  id: string
) {
  return pending?.configurationId === id && pending.action !== "stop"
}

function isPendingStop(
  pending: ProjectRunnerPendingOperation | undefined,
  id: string
) {
  return pending?.configurationId === id && pending.action === "stop"
}

function isTransitioning(status: ProjectRunnerControlStatus | undefined) {
  return status === "starting" || status === "stopping"
}

// Rounded on its left, as Stop is on its right: the two read as a pair.
function runnerStartClassName(running: boolean) {
  return cn(
    "rounded-l-lg!",
    running
      ? "bg-emerald-600 text-white hover:bg-emerald-500"
      : "bg-muted text-emerald-500 hover:bg-muted/80 hover:text-emerald-400"
  )
}

function runnerStopClassName(running: boolean) {
  return running
    ? "bg-destructive/10 text-destructive hover:bg-destructive/20"
    : "bg-muted text-destructive hover:bg-muted/80"
}

function selectedConfiguration(
  configurations: ProjectRunConfiguration[],
  selectedId?: string
) {
  return configurations.find(({ id }) => id === selectedId) ?? configurations[0]
}
