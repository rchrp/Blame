import type { ProjectRunConfiguration } from "@blame/agent-runtime"
import * as React from "react"
import { toast } from "sonner"

import {
  approveBuildsCommand,
  blockedBuildScripts,
  dependencyInstallCommand,
  dependencyInstallFailure,
  dependencyInstallProgress,
  missingPackagesInOutput,
  outputSaysNothingInstalled,
  packagesNotInstalled,
  projectDependencies,
  type DependencyFiles,
  type ProjectDependencies,
} from "@/components/backlog/board/project-dependencies"
import type {
  ProjectRunnerStartOptions,
  useProjectRunner,
} from "@/components/backlog/board/use-project-runner"
import { ProgressNotificationBody } from "@/components/shared/progress-notification"
import { Button } from "@/components/ui/button"
import { usePlatform, type WorkspaceClient } from "@/context/platform"
import { useLatestCallback } from "@/lib/use-latest-callback"

// When an app started from the runner lacks its Node packages, a toast
// offers to install them, follows the install, then starts the app again,
// as IDEs do. It checks on each start and reads the app's output: pnpm's
// warnings, packages the app cannot load, and the build scripts pnpm 11
// waits on (approving them runs their code, so the person decides).

type Runner = ReturnType<typeof useProjectRunner>

type Reason =
  | { kind: "missing" }
  | { kind: "outdated"; packages: string[] }
  | { kind: "builds"; packages: string[] }

type Offer = {
  dependencies: ProjectDependencies
  reason: Reason
  running: boolean
  toastId: string
  // Configurations to start again once it worked.
  waiting: Set<string>
}

const toastOptions = {
  className: "progress-notification-toast",
  closeButton: false,
  dismissible: true,
  duration: Infinity,
  onDismiss: undefined,
  position: "bottom-right" as const,
}
// pnpm 11 installs on its own before a script: give it time to start.
const startCheckDelayMs = 2_500

export function useProjectDependencies(input: {
  configurations: ProjectRunConfiguration[]
  projectPath?: string
  runner: Runner
  start(id: string, options?: ProjectRunnerStartOptions): void
}) {
  const workspace = usePlatform().workspace
  const { configurations, projectPath, runner } = input
  const offers = React.useRef(new Map<string, Offer>())
  // Offers the person turned down, by root and kind: guesses read from the
  // output are not repeated. A missing install is, on each start.
  const declined = React.useRef(new Set<string>())
  const scanned = React.useRef(new Map<string, number>())
  const files = React.useMemo(
    () =>
      workspace?.pathExists && projectPath
        ? dependencyFiles(workspace, projectPath)
        : undefined,
    [projectPath, workspace]
  )

  // The offer's button runs the latest run(), which may offer again.
  const runRef = React.useRef<(key: string) => Promise<void>>(undefined)

  const present = useLatestCallback(
    (
      dependencies: ProjectDependencies,
      waiting: Iterable<string>,
      reason: Reason
    ) => {
      const key = `${projectPath}:${dependencies.root}`
      const current = offers.current.get(key)
      // Blocked build scripts are the next step of a missing install.
      const replaces =
        current &&
        !current.running &&
        reason.kind === "builds" &&
        current.reason.kind !== "builds"
      if (current && !replaces) {
        for (const id of waiting) current.waiting.add(id)
        return
      }
      const declinedKey = `${key}:${reason.kind}`
      if (reason.kind !== "missing" && declined.current.has(declinedKey)) return
      const toastId = current?.toastId ?? `project-dependencies:${key}`
      const offer: Offer = {
        dependencies,
        reason,
        running: false,
        toastId,
        waiting: new Set([...(current?.waiting ?? []), ...waiting]),
      }
      offers.current.set(key, offer)
      const later = () => {
        if (offers.current.get(key) === offer) offers.current.delete(key)
        declined.current.add(declinedKey)
      }
      toast.warning(offerTitle(reason), {
        ...toastOptions,
        description: (
          <DependencyNotice
            message={offerMessage(dependencies, offer, configurations, reason)}
            action={reason.kind === "builds" ? "Allow" : "Install"}
            onAction={() => void runRef.current?.(key)}
            onLater={() => {
              later()
              toast.dismiss(toastId)
            }}
          />
        ),
        id: toastId,
        onDismiss: later,
      })
    }
  )

  const run = useLatestCallback(async (key: string) => {
    const offer = offers.current.get(key)
    if (!offer || offer.running) return
    offer.running = true
    const { manager, root } = offer.dependencies
    const builds = offer.reason.kind === "builds" ? offer.reason.packages : []
    const title = builds.length
      ? "Approving build scripts"
      : "Installing dependencies"
    let output = ""
    let timer: number | undefined
    const show = () => {
      timer = undefined
      const progress = dependencyInstallProgress(output)
      toast.loading(title, {
        ...toastOptions,
        description: (
          <ProgressNotificationBody
            label={
              builds.length
                ? `Running the scripts of ${packageList(builds)}`
                : progress.percent === undefined
                  ? `${manager} install`
                  : `Adding packages · ${progress.percent}%`
            }
            percent={progress.percent}
            detail={progress.detail}
          />
        ),
        id: offer.toastId,
      })
    }
    show()
    // The apps waiting on it go first: pnpm 11 may be installing for them.
    const restarting = configurations.filter(
      (configuration) =>
        offer.waiting.has(configuration.id) &&
        ["running", "starting", "error"].includes(
          runner.sessionFor(configuration.id)?.status ?? ""
        )
    )
    await Promise.all(restarting.map((item) => runner.stop(item.id)))
    const taskId = `dependencies:${root || "."}`
    const succeeded = await runner.runTask(
      {
        command: builds.length
          ? approveBuildsCommand(builds)
          : dependencyInstallCommand(manager),
        cwd: root || ".",
        id: taskId,
        name: builds.length ? "Approve build scripts" : "Install dependencies",
      },
      (data) => {
        output = `${output}${data}`.slice(-16_000)
        timer ??= window.setTimeout(show, 250)
      }
    )
    window.clearTimeout(timer)
    offers.current.delete(key)
    const blocked = succeeded ? [] : blockedBuildScripts(output)
    if (blocked.length && !builds.length) {
      // Installed, but pnpm 11 waits on build scripts before any start.
      declined.current.delete(`${key}:builds`)
      return present(offer.dependencies, offer.waiting, {
        kind: "builds",
        packages: blocked,
      })
    }
    if (!succeeded) {
      toast.error(
        builds.length
          ? "Couldn't approve build scripts"
          : "Couldn't install dependencies",
        {
          ...toastOptions,
          description: (
            <DependencyNotice
              message={
                dependencyInstallFailure(output) ??
                "It stopped before it finished."
              }
              action="Show logs"
              later="Dismiss"
              onAction={() => {
                runner.selectSession(taskId)
                runner.setLogsOpen(true)
                toast.dismiss(offer.toastId)
              }}
              onLater={() => toast.dismiss(offer.toastId)}
            />
          ),
          id: offer.toastId,
        }
      )
      return
    }
    // An app that still misses packages after an install has another
    // problem: don't offer the same install again.
    if (offer.reason.kind === "outdated")
      declined.current.add(`${key}:outdated`)
    for (const item of restarting) input.start(item.id, { revealLogs: false })
    toast.success(
      builds.length ? "Build scripts approved" : "Dependencies installed",
      {
        ...toastOptions,
        description: restarting.length
          ? `Restarting ${restarting.map((item) => item.name).join(", ")}.`
          : "Start the app again to use them.",
        duration: 5_000,
        id: offer.toastId,
      }
    )
  })

  React.useEffect(() => {
    runRef.current = run
  }, [run])

  const inspect = useLatestCallback(
    async (
      configuration: ProjectRunConfiguration,
      signs: { builds?: string[]; packages?: string[]; project?: string } = {}
    ) => {
      if (!files || (signs.project && signs.project !== projectPath)) return
      const dependencies = await projectDependencies(files, configuration)
      if (!dependencies) return
      const waiting = [configuration.id]
      if (signs.builds?.length && dependencies.manager === "pnpm")
        return present(dependencies, waiting, {
          kind: "builds",
          packages: signs.builds,
        })
      if (dependencies.missing)
        return present(dependencies, waiting, { kind: "missing" })
      if (!signs.packages?.length) return
      const absent = await packagesNotInstalled(
        files,
        dependencies,
        signs.packages
      )
      if (absent.length)
        present(dependencies, waiting, { kind: "outdated", packages: absent })
    }
  )

  // What the apps print. Tasks such as the install itself are left out.
  React.useEffect(() => {
    for (const session of runner.sessions) {
      if (!session.sessionId) continue
      const configuration = configurations.find(
        (item) => item.id === session.configurationId
      )
      if (!configuration) continue
      const read = scanned.current.get(session.sessionId) ?? 0
      if (session.logs.length <= read) continue
      scanned.current.set(session.sessionId, session.logs.length)
      // A little overlap catches a message split across two chunks.
      const fresh = session.logs.slice(Math.max(0, read - 400))
      const builds = blockedBuildScripts(fresh)
      const packages = missingPackagesInOutput(fresh)
      if (builds.length || packages.length || outputSaysNothingInstalled(fresh))
        void inspect(configuration, { builds, packages }).catch(() => undefined)
    }
  }, [configurations, inspect, runner.sessions])

  // Starts as input.start does, then checks the app's packages.
  const start = useLatestCallback(
    (id: string, options?: ProjectRunnerStartOptions) => {
      input.start(id, options)
      const configuration = configurations.find((item) => item.id === id)
      if (!configuration) return
      const project = projectPath
      window.setTimeout(
        () => void inspect(configuration, { project }).catch(() => undefined),
        startCheckDelayMs
      )
    }
  )
  return { start }
}

function offerTitle(reason: Reason) {
  if (reason.kind === "missing") return "Dependencies aren't installed"
  if (reason.kind === "outdated") return "Some dependencies aren't installed"
  return "pnpm is waiting on build scripts"
}

function offerMessage(
  dependencies: ProjectDependencies,
  offer: Offer,
  configurations: ProjectRunConfiguration[],
  reason: Reason
) {
  const app =
    configurations.find((item) => offer.waiting.has(item.id))?.name ?? "The app"
  const where = dependencies.root ? ` in ${dependencies.root}` : ""
  const command = `${dependencies.manager} install${where}`
  if (reason.kind === "missing")
    return `${app} needs the project's packages to run. Install them with ${command}?`
  if (reason.kind === "outdated")
    return `${app} can't find ${packageList(reason.packages)}, declared in package.json but not installed. Run ${command}?`
  return `${packageList(reason.packages)} ${reason.packages.length === 1 ? "has a script" : "have scripts"} to run after install, and pnpm won't start ${app} until you decide. Allow ${reason.packages.length === 1 ? "it" : "them"} to run?`
}

function packageList(packages: string[]) {
  const shown = packages.slice(0, 3).join(", ")
  return packages.length > 3 ? `${shown} and others` : shown
}

function DependencyNotice({
  message,
  action,
  later = "Not now",
  onAction,
  onLater,
}: {
  message: string
  action: string
  later?: string
  onAction(): void
  onLater(): void
}) {
  return (
    <div className="grid gap-3">
      <p className="text-pretty">{message}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={onAction}>
          {action}
        </Button>
        <Button size="sm" variant="ghost" onClick={onLater}>
          {later}
        </Button>
      </div>
    </div>
  )
}

function dependencyFiles(
  workspace: WorkspaceClient,
  projectPath: string
): DependencyFiles {
  const root = projectPath.replace(/[\\/]+$/, "")
  return {
    exists: (path) =>
      workspace.pathExists({ path: path ? `${root}/${path}` : root }),
    read: (path) =>
      workspace.readFile({ root: projectPath, path }).catch(() => undefined),
  }
}
