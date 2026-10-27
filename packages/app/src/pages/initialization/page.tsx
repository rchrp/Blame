import * as React from "react"
import { CopyIcon, PencilIcon, RefreshCwIcon } from "lucide-react"
import { toast } from "sonner"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import {
  notifyProjectInitializationUpdated,
  requestProjectInitializationRun,
} from "@/components/project-initialization/project-initialization-events"
import { useInitializationProgress } from "@/components/project-initialization/project-initialization-progress"
import { useProjectInitialization } from "@/components/project-initialization/use-project-initialization"
import { useCloudAuth } from "@/context/cloud-auth"
import { useProjects } from "@/context/projects"
import { createCloudApi } from "@/lib/cloud-api"
import {
  InitializationSetupEditor,
  InitializationSetupView,
} from "./initialization-setup"
import {
  manualEditReason,
  setupJson,
  type SavedSetup,
} from "./initialization-setup-draft"
import { InitializationStatus } from "./initialization-status"

export function InitializationPage() {
  const auth = useCloudAuth()
  const projects = useProjects()
  const project = projects.activeProject
  const snapshot = useProjectInitialization()
  const progress = useInitializationProgress(project?.id)
  // The setup being edited, kept while an analysis started elsewhere
  // replaces the saved one.
  const [editing, setEditing] = React.useState<SavedSetup>()
  const [confirmRun, setConfirmRun] = React.useState(false)

  const initialization = snapshot?.initialization
  const availability = snapshot?.availability ?? "unavailable"
  const running = availability === "running"
  const setup: SavedSetup | undefined = initialization?.previewManifest
    ? {
        previewManifest: initialization.previewManifest,
        runConfigurations: initialization.runConfigurations,
      }
    : undefined
  const neverRan = !initialization || initialization.status === "pending"

  const runAgain = () => {
    if (!project) return
    if (initialization?.repairReason === manualEditReason && !confirmRun) {
      setConfirmRun(true)
      return
    }
    setConfirmRun(false)
    requestProjectInitializationRun(project.id)
  }

  const copySetup = () => {
    if (!setup) return
    void navigator.clipboard
      .writeText(setupJson(setup))
      .then(() =>
        toast.success("Setup copied", {
          description: "The JSON of the current setup is in your clipboard.",
          position: "bottom-right",
        })
      )
      .catch(() =>
        toast.error("The setup could not be copied", {
          position: "bottom-right",
        })
      )
  }

  const save = async (next: SavedSetup) => {
    if (!project) return
    await createCloudApi(auth.apiConnection).repairProjectInitialization(
      project.id,
      {
        previewManifest: next.previewManifest,
        runConfigurations: next.runConfigurations,
        databaseMode: initialization?.databaseMode ?? null,
        reason: manualEditReason,
      }
    )
    notifyProjectInitializationUpdated(project.id)
    setEditing(undefined)
    toast.success("Setup saved", {
      description: "Stories started from now on use it.",
      position: "bottom-right",
    })
  }

  return (
    <div className="flex flex-1 flex-col items-center px-4 pt-[calc(var(--header-height)+1rem)] pb-4 lg:px-6 lg:pt-[calc(var(--header-height)+1.5rem)] lg:pb-6">
      <div className="flex w-full max-w-4xl flex-col gap-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div className="grid gap-1">
            <h2 className="font-heading text-2xl font-semibold tracking-normal">
              Preview Environment
            </h2>
            <p className="max-w-xl text-sm text-pretty text-muted-foreground">
              How Blame runs {project?.name ?? "this project"} in containers:
              what it installs, which services it starts, and where each
              story&apos;s preview opens.
            </p>
          </div>
          {snapshot && !editing ? (
            <div className="flex items-center gap-2">
              {setup ? (
                <Button
                  variant="outline"
                  onClick={() => setEditing(setup)}
                  disabled={running}
                >
                  <PencilIcon data-icon="inline-start" />
                  Edit setup
                </Button>
              ) : null}
              <Button onClick={runAgain} disabled={running}>
                <RefreshCwIcon
                  data-icon="inline-start"
                  className={running ? "animate-spin" : undefined}
                />
                {running
                  ? "Analyzing…"
                  : neverRan
                    ? "Analyze project"
                    : "Run again"}
              </Button>
            </div>
          ) : null}
        </header>
        {!snapshot ? (
          <InitializationLoading />
        ) : (
          <>
            <InitializationStatus
              availability={availability}
              initialization={initialization}
              progress={progress}
            />
            {editing ? (
              <InitializationSetupEditor
                saved={editing}
                locked={
                  running
                    ? "An analysis is running. Save waits until it ends, and then replaces its result with your version."
                    : undefined
                }
                onCancel={() => setEditing(undefined)}
                onSave={save}
              />
            ) : setup ? (
              <InitializationSetupView setup={setup} />
            ) : null}
          </>
        )}
      </div>
      <AlertDialog open={confirmRun} onOpenChange={setConfirmRun}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace your edits?</AlertDialogTitle>
            <AlertDialogDescription>
              You edited this setup by hand. A new analysis writes a new setup
              and your edits are lost. Copy the current setup first to keep a
              copy of them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="ghost" className="sm:mr-auto" onClick={copySetup}>
              <CopyIcon data-icon="inline-start" />
              Copy setup
            </Button>
            <AlertDialogCancel>Keep my setup</AlertDialogCancel>
            <AlertDialogAction onClick={runAgain}>
              Run the analysis
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function InitializationLoading() {
  return (
    <div className="grid gap-6" aria-busy="true">
      <Skeleton className="h-20 rounded-lg" />
      <Skeleton className="h-48 rounded-lg" />
    </div>
  )
}
