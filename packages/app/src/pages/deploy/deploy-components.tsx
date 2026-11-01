import * as React from "react"
import type {
  DeployConnection,
  DeployProject,
  DeployTarget,
  ProjectDeployment,
} from "@blame/deploy-contract"
import {
  AlertTriangleIcon,
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  LoaderCircleIcon,
  LogInIcon,
  XIcon,
} from "lucide-react"

import { FeatureStart } from "@/components/shared/feature-start"
import { DeploymentReadiness } from "./deploy-source"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import type { DeployProgress } from "@/context/platform"
import type { LocalDeployPreflight } from "./use-deploy-page"

export function VercelMark({ className = "size-5" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={className}
      fill="currentColor"
    >
      <path d="M12 3 23 21H1L12 3Z" />
    </svg>
  )
}

export function DeployEmptyState({
  connecting,
  error,
  onConnect,
}: {
  connecting: boolean
  error?: string
  onConnect(): void
}) {
  return (
    <FeatureStart
      title="Deploy"
      description="Publish your current workspace with Vercel."
      heading="Take your project from local to live."
      steps={deploymentSetupSteps}
      footer="Deployments and usage stay in your Vercel account."
    >
      <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
        Connect your Vercel account, choose a destination, and publish from
        Blame. Follow the build here and open your site when it is ready.
      </p>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <ConnectVercelButton connecting={connecting} onConnect={onConnect} />
      <p className="text-xs text-muted-foreground">
        {connecting
          ? "Complete the connection in your browser to continue."
          : "Choose your account or team in the next step."}
      </p>
    </FeatureStart>
  )
}

/** Deploying goes through hosted services: a local workspace signs in first. */
export function DeploySignInState({ onSignIn }: { onSignIn(): void }) {
  return (
    <FeatureStart
      title="Deploy"
      description="Publish your current workspace with Vercel."
      heading="Take your project from local to live."
      steps={deploymentSetupSteps}
      footer="Deployments and usage stay in your Vercel account."
    >
      <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
        Deploying links Vercel to a Blame account and uploads your source
        through Blame. Sign in to deploy; your workspace moves into the account.
      </p>
      <Button onClick={onSignIn}>
        <LogInIcon />
        Sign in to deploy
      </Button>
    </FeatureStart>
  )
}

const deploymentSetupSteps = [
  {
    title: "Connect your account",
    description: "Link the Vercel account or team that will host your project.",
  },
  {
    title: "Choose the destination",
    description: "Use an existing Vercel project or create a new one.",
  },
  {
    title: "Review and publish",
    description:
      "Confirm the workspace snapshot, then follow the build and public URL check.",
  },
]

export function DeployLoading() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 pt-[calc(var(--header-height)+1rem)] pb-8 lg:px-6">
      <Skeleton className="h-6 w-28" />
      <Skeleton className="h-52 w-full rounded-xl" />
      <Skeleton className="h-28 w-full rounded-xl" />
    </div>
  )
}

type DeploymentCardProps = {
  connection: DeployConnection
  deploying: boolean
  deployment?: ProjectDeployment
  onCancel(): void
  onCopy(url: string): void
  onDeploy(): void
  onLogs(): void
  onManage(): void
  onOpen(url: string): void
  onTarget(): void
  preflight?: LocalDeployPreflight
  progress?: DeployProgress
  target: DeployTarget | null
}

type ActiveDeploymentCardProps = DeploymentCardProps & { active: boolean }

export function DeploymentCard(props: DeploymentCardProps) {
  const active =
    props.deploying ||
    Boolean(props.deployment && activeDeployment(props.deployment.status))
  return (
    <Card>
      <DeploymentHeader {...props} active={active} />
      <CardContent className="space-y-4">
        <DeploymentFeedback
          deployment={props.deployment}
          preflight={props.preflight}
        />
        <DeploymentContent {...props} active={active} />
        <DeploymentActions {...props} active={active} />
      </CardContent>
      <DeploymentConnection
        connection={props.connection}
        onManage={props.onManage}
      />
    </Card>
  )
}

function DeploymentHeader({
  target,
  deployment,
  active,
}: Pick<ActiveDeploymentCardProps, "target" | "deployment" | "active">) {
  return (
    <CardHeader className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background">
          <VercelMark className="size-4" />
        </span>
        <div className="min-w-0">
          <CardTitle>Production</CardTitle>
          <p className="text-xs break-all text-muted-foreground">
            {target?.providerProjectName ?? "New Vercel project"}
          </p>
        </div>
      </div>
      <CardAction>{deploymentBadge(deployment, active)}</CardAction>
    </CardHeader>
  )
}

function DeploymentFeedback({
  preflight,
  deployment,
}: Pick<DeploymentCardProps, "preflight" | "deployment">) {
  return (
    <>
      {preflight?.manifest.compatibility.status === "unsupported" && (
        <CompatibilityAlert preflight={preflight} />
      )}
      {deployment?.status === "failed" && (
        <Alert variant="destructive">
          <AlertTriangleIcon />
          <AlertTitle>Deployment failed</AlertTitle>
          <AlertDescription>
            {deployment.safeErrorMessage ??
              "Vercel could not complete this deployment."}
          </AlertDescription>
        </Alert>
      )}
    </>
  )
}

function DeploymentContent(props: ActiveDeploymentCardProps) {
  const { deployment, progress, target, active, onCopy, onOpen, preflight } =
    props
  const url =
    deployment?.productionUrl ??
    deployment?.deploymentUrl ??
    target?.productionUrl
  if (active)
    return <DeploymentProgress deployment={deployment} progress={progress} />
  if (url && deployment)
    return (
      <OnlineDeployment
        deployment={deployment}
        url={url}
        onCopy={onCopy}
        onOpen={onOpen}
      />
    )
  return <DeploymentReadiness preflight={preflight} />
}

function DeploymentActions(props: ActiveDeploymentCardProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Button
        variant="link"
        className="h-auto px-0 text-foreground underline decoration-muted-foreground underline-offset-4"
        onClick={props.onTarget}
        disabled={props.active}
      >
        {props.target ? "Change project" : "Choose project"}
      </Button>
      <div className="flex flex-wrap gap-2">
        {props.deployment?.status === "failed" && (
          <Button variant="outline" onClick={props.onLogs}>
            View build logs
          </Button>
        )}
        <DeploymentPublishAction {...props} />
      </div>
    </div>
  )
}

function DeploymentPublishAction({
  active,
  deploying,
  deployment,
  preflight,
  onCancel,
  onDeploy,
}: ActiveDeploymentCardProps) {
  if (deployment && activeDeployment(deployment.status) && !deploying)
    return (
      <CancelDeploymentButton deployment={deployment} onCancel={onCancel} />
    )
  return (
    <Button
      onClick={onDeploy}
      disabled={
        active ||
        preflight?.manifest.compatibility.status === "unsupported" ||
        !preflight
      }
    >
      {deploying && (
        <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" />
      )}
      {deploying
        ? "Preparing deployment…"
        : deployment
          ? "Deploy update"
          : "Deploy to production"}
    </Button>
  )
}

function DeploymentConnection({
  connection,
  onManage,
}: Pick<DeploymentCardProps, "connection" | "onManage">) {
  return (
    <CardFooter className="flex-wrap justify-between gap-3 text-xs text-muted-foreground">
      <span className="min-w-0 break-words">
        Vercel {connection.scopeType === "team" ? "team" : "account"}:{" "}
        {connection.scopeDisplayName}
      </span>
      <Button variant="ghost" size="xs" onClick={onManage}>
        Manage connection <ExternalLinkIcon />
      </Button>
    </CardFooter>
  )
}

function OnlineDeployment({
  deployment,
  onCopy,
  onOpen,
  url,
}: {
  deployment: ProjectDeployment
  onCopy(url: string): void
  onOpen(url: string): void
  url: string
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 rounded-lg border bg-background px-3 py-2">
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{url}</span>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={() => onCopy(url)}
          aria-label="Copy URL"
        >
          <CopyIcon />
        </Button>
        <Button size="sm" variant="outline" onClick={() => onOpen(url)}>
          Open site <ExternalLinkIcon />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Deployed{" "}
        {relativeTime(
          deployment.readyAt ?? deployment.updatedAt ?? deployment.createdAt
        )}{" "}
        · {deployment.sourceBranch ?? "detached HEAD"} ·{" "}
        {localChanges(deployment.localChangeCount)}
      </p>
    </div>
  )
}

function DeploymentProgress({
  deployment,
  progress,
}: {
  deployment?: ProjectDeployment
  progress?: DeployProgress
}) {
  const current = progress
    ? progress.phase === "preparing"
      ? 0
      : progress.phase === "uploading"
        ? 1
        : 2
    : deployment?.status === "verifying_public_access"
      ? 3
      : 2
  const steps = [
    "Preparing files",
    "Uploading source",
    "Building on Vercel",
    "Checking public URL",
  ]
  return (
    <div className="space-y-3 rounded-lg border bg-background p-4">
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-foreground transition-all"
          style={{
            width: `${progress?.percent ?? Math.min(92, (current + 0.5) * 25)}%`,
          }}
        />
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {steps.map((step, index) => (
          <div
            key={step}
            className={
              index <= current
                ? "flex items-center gap-2 text-xs"
                : "flex items-center gap-2 text-xs text-muted-foreground"
            }
          >
            {index < current ? (
              <CheckIcon className="size-3.5 text-emerald-600" />
            ) : index === current ? (
              <LoaderCircleIcon className="size-3.5 animate-spin" />
            ) : (
              <span className="size-3.5 rounded-full border" />
            )}
            {step}
          </div>
        ))}
      </div>
    </div>
  )
}

function CompatibilityAlert({
  preflight,
}: {
  preflight: LocalDeployPreflight
}) {
  const blocker = preflight.manifest.compatibility.blockers[0]
  return (
    <Alert variant="destructive">
      <AlertTriangleIcon />
      <AlertTitle>Not ready for Vercel</AlertTitle>
      <AlertDescription>
        {blocker?.message ?? "This project is not compatible with Vercel."}
        {blocker?.action ? ` ${blocker.action}` : ""}
      </AlertDescription>
    </Alert>
  )
}

export function RecentDeployments({
  deployments,
  onLogs,
}: {
  deployments: ProjectDeployment[]
  onLogs(deployment: ProjectDeployment): void
}) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-medium">Recent deployments</h3>
        <span className="text-xs text-muted-foreground">
          {deployments.length
            ? `Last ${Math.min(5, deployments.length)}`
            : "No deployments yet"}
        </span>
      </div>
      {!deployments.length && (
        <p className="rounded-xl border px-4 py-5 text-sm text-muted-foreground">
          Your deployment history and build logs will appear here after the
          first run.
        </p>
      )}
      <div className="divide-y rounded-xl bg-card">
        {deployments.slice(0, 5).map((deployment) => (
          <DeploymentHistoryRow
            key={deployment.id}
            deployment={deployment}
            onLogs={onLogs}
          />
        ))}
      </div>
    </section>
  )
}

function StatusIcon({ deployment }: { deployment: ProjectDeployment }) {
  if (["ready"].includes(deployment.status))
    return <CheckIcon className="size-4 text-emerald-600" />
  if (["failed", "unhealthy"].includes(deployment.status))
    return <XIcon className="size-4 text-destructive" />
  if (deployment.status === "canceled")
    return <XIcon className="size-4 text-muted-foreground" />
  if (deployment.status === "protected")
    return <AlertTriangleIcon className="size-4 text-amber-600" />
  return (
    <LoaderCircleIcon className="size-4 animate-spin text-muted-foreground" />
  )
}

export function DeployConfirmationDialog({
  onConfirm,
  onOpenChange,
  open,
  preflight,
}: {
  onConfirm(): void
  onOpenChange(open: boolean): void
  open: boolean
  preflight?: LocalDeployPreflight
}) {
  if (!preflight) return null
  const snapshot = preflight.snapshot
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Deploy to production?</DialogTitle>
          <DialogDescription>
            Blame will send {snapshot.fileCount.toLocaleString()} files (
            {formatBytes(snapshot.sourceBytes)}) from the current workspace to
            Vercel. The snapshot includes{" "}
            {localChanges(snapshot.localChangeCount)}. Local secrets are
            excluded.
          </DialogDescription>
        </DialogHeader>
        {preflight.manifest.compatibility.warnings.length ? (
          <Alert>
            <AlertTriangleIcon />
            <AlertDescription>
              {preflight.manifest.compatibility.warnings[0]?.message}
            </AlertDescription>
          </Alert>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Source files transit temporarily through Blame so your Vercel token
          stays server-side. They are deleted after Vercel accepts the
          deployment.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={onConfirm}>Deploy</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function TargetDialog({
  connections,
  defaultName,
  initialConnectionId,
  loading,
  onConnectionChange,
  onOpenChange,
  onSave,
  open,
  projects,
  saving,
}: {
  connections: DeployConnection[]
  defaultName: string
  initialConnectionId?: string
  loading: boolean
  onConnectionChange(id: string): void
  onOpenChange(open: boolean): void
  onSave(input: {
    connectionId: string
    providerProjectId: string | null
    providerProjectName: string
  }): void
  open: boolean
  projects: DeployProject[]
  saving: boolean
}) {
  const [selectedConnection, setSelectedConnection] = React.useState(
    initialConnectionId ?? ""
  )
  const [selectedProject, setSelectedProject] = React.useState<string | null>(
    null
  )
  const [name, setName] = React.useState(defaultName)
  const selectConnection = (id: string) => {
    setSelectedConnection(id)
    setSelectedProject(null)
    onConnectionChange(id)
  }
  const project = projects.find(({ id }) => id === selectedProject)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Choose Vercel project</DialogTitle>
          <DialogDescription>
            Link an accessible project explicitly or create a new one.
          </DialogDescription>
        </DialogHeader>
        {connections.length > 1 ? (
          <div className="flex flex-wrap gap-2">
            {connections
              .filter(({ status }) => status === "active")
              .map((connection) => (
                <Button
                  key={connection.id}
                  size="sm"
                  variant={
                    selectedConnection === connection.id
                      ? "secondary"
                      : "outline"
                  }
                  onClick={() => selectConnection(connection.id)}
                >
                  {connection.scopeDisplayName}
                </Button>
              ))}
          </div>
        ) : null}
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">
            Existing projects
          </p>
          <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border p-1">
            {loading ? (
              <div className="flex justify-center p-4">
                <LoaderCircleIcon className="size-4 animate-spin" />
              </div>
            ) : projects.length ? (
              projects.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted ${selectedProject === item.id ? "bg-muted" : ""}`}
                  onClick={() => setSelectedProject(item.id)}
                >
                  <span>{item.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {item.framework ?? "Auto"}
                  </span>
                </button>
              ))
            ) : (
              <p className="p-3 text-xs text-muted-foreground">
                No accessible projects found.
              </p>
            )}
          </div>
        </div>
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">
            Or create a project
          </p>
          <Input
            value={name}
            onChange={(event) => {
              setName(event.target.value)
              setSelectedProject(null)
            }}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={
              saving || !selectedConnection || (!project && !name.trim())
            }
            onClick={() =>
              onSave({
                connectionId: selectedConnection,
                providerProjectId: project?.id ?? null,
                providerProjectName: project?.name ?? name,
              })
            }
          >
            {saving ? <LoaderCircleIcon className="animate-spin" /> : null} Save
            project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function BuildLogsDialog({
  loading,
  logs,
  onOpenChange,
  open,
}: {
  loading: boolean
  logs: Array<{ created: number; message: string }>
  onOpenChange(open: boolean): void
  open: boolean
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Vercel build logs</DialogTitle>
          <DialogDescription>
            Recent provider logs, with known credential values redacted.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[55vh] overflow-auto rounded-lg bg-zinc-950 p-3 font-mono text-xs leading-relaxed text-zinc-100">
          {loading ? (
            <LoaderCircleIcon className="mx-auto my-8 animate-spin" />
          ) : logs.length ? (
            logs.map((log, index) => (
              <div key={`${log.created}:${index}`}>{log.message}</div>
            ))
          ) : (
            <p className="text-zinc-400">No build logs are available yet.</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function deploymentBadge(
  deployment: ProjectDeployment | undefined,
  active: boolean
) {
  if (!deployment) return <Badge variant="outline">Not deployed</Badge>
  if (active) return <Badge variant="secondary">Building</Badge>
  const label = statusLabel(deployment.status)
  if (deployment.status === "ready")
    return <Badge className="bg-emerald-600 text-white">{label}</Badge>
  if (deployment.status === "protected")
    return <Badge className="bg-amber-500 text-white">{label}</Badge>
  if (["failed", "unhealthy"].includes(deployment.status))
    return <Badge variant="destructive">{label}</Badge>
  return <Badge variant="outline">{label}</Badge>
}

function activeDeployment(status: ProjectDeployment["status"]) {
  return [
    "packaging",
    "uploading_source",
    "transferring_to_vercel",
    "submitted",
    "building",
    "verifying_public_access",
    "canceling",
  ].includes(status)
}

function statusLabel(status: ProjectDeployment["status"]) {
  if (status === "ready") return "Public"
  if (status === "protected") return "Protected"
  if (status === "unhealthy") return "Unhealthy"
  if (status === "failed") return "Failed"
  if (status === "canceled") return "Canceled"
  return "Building"
}

function localChanges(count: number) {
  return `${count} local ${count === 1 ? "change" : "changes"}`
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function relativeTime(value: string) {
  const seconds = Math.round((Date.parse(value) - Date.now()) / 1_000)
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" })
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second")
  const minutes = Math.round(seconds / 60)
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute")
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour")
  return formatter.format(Math.round(hours / 24), "day")
}

function ConnectVercelButton({
  connecting,
  onConnect,
}: {
  connecting: boolean
  onConnect(): void
}) {
  return (
    <Button onClick={onConnect} disabled={connecting}>
      {connecting ? (
        <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" />
      ) : (
        <VercelMark />
      )}
      {connecting ? "Waiting for Vercel…" : "Connect Vercel"}
    </Button>
  )
}

function DeploymentHistoryRow({
  deployment,
  onLogs,
}: {
  deployment: ProjectDeployment
  onLogs(deployment: ProjectDeployment): void
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-3 py-3 text-sm last:border-b-0">
      <StatusIcon deployment={deployment} />
      <span className="w-20 font-medium">{statusLabel(deployment.status)}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
        {deployment.sourceRevision.slice(0, 7)}
        {deployment.localChangeCount ? " + local changes" : ""}
      </span>
      <span className="text-xs text-muted-foreground">
        {relativeTime(deployment.createdAt)}
      </span>
      {deployment.status === "failed" ? (
        <Button size="xs" variant="ghost" onClick={() => onLogs(deployment)}>
          Logs
        </Button>
      ) : null}
    </div>
  )
}

function CancelDeploymentButton({
  deployment,
  onCancel,
}: {
  deployment: ProjectDeployment
  onCancel(): void
}) {
  return (
    <Button
      variant="destructive"
      onClick={onCancel}
      disabled={deployment.status === "canceling"}
    >
      {deployment.status === "canceling" ? "Canceling…" : "Cancel deployment"}
    </Button>
  )
}
