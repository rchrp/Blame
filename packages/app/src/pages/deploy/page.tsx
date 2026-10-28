import * as React from "react"
import type { DeployTarget, ProjectDeployment } from "@blame/deploy-contract"
import { toast } from "sonner"
import { DeploymentSource } from "./deploy-source"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { useCloudAuth } from "@/context/cloud-auth"
import { navigate } from "@/components/navigation/navigation"

import {
  BuildLogsDialog,
  DeployConfirmationDialog,
  DeployEmptyState,
  DeployLoading,
  DeploymentCard,
  RecentDeployments,
  TargetDialog,
} from "./deploy-components"
import {
  normalizedProjectName,
  useDeployPage,
  type LocalDeployPreflight,
} from "./use-deploy-page"

export function DeployPage() {
  return (
    <div className="flex h-svh min-h-0 min-w-0 flex-col overflow-hidden md:h-[calc(100svh_-_1rem)]">
      <DeployPageContent />
    </div>
  )
}

function DeployPageContent() {
  const auth = useCloudAuth()
  const deploy = useDeployPage()
  const [confirmOpen, setConfirmOpen] = React.useState(false)
  const [targetOpen, setTargetOpen] = React.useState(false)
  const [logsOpen, setLogsOpen] = React.useState(false)
  const [savingTarget, setSavingTarget] = React.useState(false)
  const [confirmedTarget, setConfirmedTarget] =
    React.useState<DeployTarget | null>(null)
  const [confirmedPreflight, setConfirmedPreflight] =
    React.useState<LocalDeployPreflight | null>(null)
  const activeConnections = deploy.connections.filter(
    ({ status }) => status === "active"
  )
  const connection =
    activeConnections.find(({ id }) => id === deploy.connectionId) ??
    activeConnections[0]

  const chooseTarget = async () => {
    setTargetOpen(true)
    await deploy.loadProviderProjects(connection?.id)
  }

  const prepareDeployment = async () => {
    if (!auth.license?.licensed) {
      toast.info("Hosted deployment uploads require Blame Premium.", {
        action: { label: "View Premium", onClick: () => navigate("/premium") },
      })
      return
    }
    try {
      const preflight = await deploy.refreshPreflight()
      if (!preflight) {
        toast.error("Set up the preview environment again before deploying.")
        return
      }
      if (preflight.manifest.compatibility.status === "unsupported") {
        toast.error(
          preflight.manifest.compatibility.blockers[0]?.message ??
            "This project is not compatible with Vercel."
        )
        return
      }
      const target = await deploy.ensureTarget(preflight)
      if (!target) {
        await chooseTarget()
        return
      }
      setConfirmedTarget(target)
      setConfirmedPreflight(preflight)
      setConfirmOpen(true)
    } catch (cause) {
      toast.error(
        cause instanceof Error ? cause.message : "Deployment preflight failed."
      )
    }
  }

  const confirmDeployment = () => {
    if (!confirmedTarget || !confirmedPreflight) return
    const target = confirmedTarget
    const preflight = confirmedPreflight
    setConfirmationOpen(false)
    void deploy.startDeployment(target, preflight)
  }

  const setConfirmationOpen = (open: boolean) => {
    setConfirmOpen(open)
    if (!open) {
      setConfirmedTarget(null)
      setConfirmedPreflight(null)
    }
  }

  const saveTarget = (input: {
    connectionId: string
    providerProjectId: string | null
    providerProjectName: string
  }) => {
    setSavingTarget(true)
    void deploy
      .saveTarget(input)
      .then(() => {
        setTargetOpen(false)
        toast.success("Vercel project selected.")
      })
      .catch((cause) =>
        toast.error(
          cause instanceof Error
            ? cause.message
            : "Vercel project could not be saved."
        )
      )
      .finally(() => setSavingTarget(false))
  }

  const showLogs = (deployment: ProjectDeployment) => {
    setLogsOpen(true)
    void deploy.loadLogs(deployment)
  }

  if (deploy.loading) return <DeployLoading />
  if (!connection) {
    return (
      <DeployEmptyState
        connecting={deploy.connecting}
        error={deploy.error}
        onConnect={() => void deploy.connect()}
      />
    )
  }

  return (
    <>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-6 overflow-y-auto px-4 pt-[calc(var(--header-height)+1rem)] pb-6 lg:px-6 lg:pt-[calc(var(--header-height)+1.5rem)]">
        <div>
          <h2 className="font-heading text-xl font-semibold">Deploy</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Publish the current workspace to your Vercel account.
          </p>
        </div>
        {deploy.error && (
          <Alert variant="destructive">
            <AlertDescription>{deploy.error}</AlertDescription>
          </Alert>
        )}
        <div className="mx-auto grid w-full max-w-5xl gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(16rem,1fr)]">
          <div className="min-w-0 space-y-6">
            <DeploymentCard
              connection={connection}
              deploying={deploy.deploying}
              deployment={deploy.latest}
              onCancel={() =>
                deploy.latest && void deploy.cancel(deploy.latest)
              }
              onCopy={(url) => {
                void navigator.clipboard
                  .writeText(url)
                  .then(() => toast.success("Production URL copied."))
                  .catch(() =>
                    toast.error(
                      "Unable to copy the URL. Try opening the site instead."
                    )
                  )
              }}
              onDeploy={() => void prepareDeployment()}
              onLogs={() => deploy.latest && showLogs(deploy.latest)}
              onManage={() =>
                deploy.openExternal("https://vercel.com/account/integrations")
              }
              onOpen={deploy.openExternal}
              onTarget={() => void chooseTarget()}
              preflight={deploy.preflight}
              progress={deploy.progress}
              target={deploy.target}
            />
            <RecentDeployments
              deployments={deploy.deployments}
              onLogs={showLogs}
            />
          </div>
          <div className="min-w-0">
            <DeploymentSource preflight={deploy.preflight} />
          </div>
        </div>
      </div>
      <DeployConfirmationDialog
        open={confirmOpen}
        onOpenChange={setConfirmationOpen}
        onConfirm={confirmDeployment}
        preflight={confirmedPreflight ?? undefined}
      />
      {targetOpen ? (
        <TargetDialog
          key={`${connection.id}:${deploy.target?.id ?? "new"}`}
          connections={activeConnections}
          defaultName={
            deploy.target?.providerProjectName ??
            normalizedProjectName(deploy.activeProject?.name ?? "blame-project")
          }
          initialConnectionId={connection.id}
          loading={deploy.projectsLoading}
          onConnectionChange={(id) => {
            deploy.setConnectionId(id)
            void deploy.loadProviderProjects(id)
          }}
          onOpenChange={setTargetOpen}
          onSave={saveTarget}
          open={targetOpen}
          projects={deploy.providerProjects}
          saving={savingTarget}
        />
      ) : null}
      <BuildLogsDialog
        loading={deploy.logsLoading}
        logs={deploy.logs}
        onOpenChange={setLogsOpen}
        open={logsOpen}
      />
    </>
  )
}
