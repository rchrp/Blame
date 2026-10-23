import type { ProjectRunConfiguration } from "@blame/agent-runtime"
import {
  ChevronDownIcon,
  LoaderCircleIcon,
  PlayIcon,
  RotateCwIcon,
  SquareIcon,
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

type ProjectRunnerControlsProps = {
  afterStart?: React.ReactNode
  afterStop?: React.ReactNode
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
}
type SelectedRunnerControlsProps = ProjectRunnerControlsProps & {
  selected: ProjectRunConfiguration
  status: ProjectRunnerControlStatus
}
type RunnerConfigurationActionProps = ProjectRunnerControlsProps & {
  configuration: ProjectRunConfiguration
  status: ProjectRunnerControlStatus
}
type ProjectRunnerLogTabsProps = {
  items: { id: string; label: string; status?: ProjectRunnerControlStatus }[]
  value?: string
  onValueChange: (value: string) => void
}

export function ProjectRunnerControls(props: ProjectRunnerControlsProps) {
  const selected = selectedConfiguration(props.configurations, props.selectedId)
  if (!selected) return null
  const status = props.statusFor(selected.id)
  return (
    <TooltipProvider>
      <ButtonGroup className="rounded-lg border bg-muted p-0.5">
        <RunnerConfigurationMenu {...props} selected={selected} />
        <RunnerStartButton {...props} selected={selected} status={status} />
        {props.afterStart}
        <RunnerStopButton {...props} selected={selected} status={status} />
        {props.afterStop}
      </ButtonGroup>
    </TooltipProvider>
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
              ? "Rerun configuration"
              : "Run configuration"
      }
    >
      <Button
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
  const running = props.status === "running"
  const loading = isPendingStop(props.pending, props.selected.id)
  return (
    <RunnerIconTooltip
      label={loading ? "Stopping configuration" : "Stop configuration"}
    >
      <Button
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

export function ProjectRunnerLogTabs({
  items,
  value,
  onValueChange,
}: ProjectRunnerLogTabsProps) {
  return (
    <Tabs
      value={value}
      className="overflow-y-hidden"
      onValueChange={onValueChange}
    >
      <TabsList>
        {items.map((item) => (
          <TabsTrigger key={item.id} value={item.id}>
            {item.status && <ProjectRunnerStatusDot status={item.status} />}
            {item.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
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
  return <span className={`size-2 shrink-0 rounded-full ${tone}`} />
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

function runnerStartClassName(running: boolean) {
  return running
    ? "bg-emerald-600 text-white hover:bg-emerald-500"
    : "bg-muted text-emerald-500 hover:bg-muted/80 hover:text-emerald-400"
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
