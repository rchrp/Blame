// Runs security audits in this window: the desktop maps the repository (no
// agent), then the investigators and the validator run as engine tasks,
// followed for their progress and stopped with `cancelTask`. One audit per
// project at a time; every change goes to `onChanged`.
import type {
  SecurityAudit,
  SecurityAuditPerspective,
  SecurityAuditWorkspaceMap,
} from "@blame/agent-runtime"
import type { EnginePlatformClient } from "@blame/agent-runtime/engine-protocol"

import { activityDetail, followTask } from "./security-audit-activity.ts"
import {
  auditPerspectives,
  auditTask,
  count,
  createAudit,
  deterministicDiscovery,
  discoverySteps,
  endRunningSteps,
  mappingSteps,
  prioritizationSteps,
  progressStep,
  reconcileFindings,
  validationSteps,
  withStep,
  type SecurityAuditRunInput,
} from "./security-audit-steps.ts"

export type SecurityAuditChange = {
  root: string
  audit: SecurityAudit
  /** Live progress only: shown, not saved. */
  transient?: boolean
}

export type SecurityAuditRunnerDependencies = {
  map(input: {
    root: string
    scope?: SecurityAudit["scope"]
  }): Promise<SecurityAuditWorkspaceMap>
  engine: Pick<EnginePlatformClient, "call" | "follow">
}

type ActiveAudit = {
  audit: SecurityAudit
  cancelled: boolean
  root: string
  /** Engine tasks running now. */
  tasks: Set<string>
}

export type SecurityAuditRunner = ReturnType<typeof createSecurityAuditRunner>

export function createSecurityAuditRunner(
  dependencies: SecurityAuditRunnerDependencies
) {
  const active = new Map<string, ActiveAudit>()
  const listeners = new Set<(change: SecurityAuditChange) => void>()
  const { engine } = dependencies

  const update = (
    run: ActiveAudit,
    change: Partial<SecurityAudit>,
    transient = false
  ) => {
    run.audit = {
      ...run.audit,
      ...change,
      id: run.audit.id,
      version: 1,
      sequence: run.audit.sequence + 1,
      updatedAt: new Date().toISOString(),
    }
    for (const listener of listeners)
      listener({ root: run.root, audit: run.audit, transient })
    return run.audit
  }

  const updateStep = (
    run: ActiveAudit,
    id: string,
    step: Parameters<typeof withStep>[2],
    transient = false
  ) => {
    const progress = run.audit.progress
    if (!progress) return
    update(
      run,
      { progress: { ...progress, steps: withStep(progress.steps, id, step) } },
      transient
    )
  }

  const assertActive = (run: ActiveAudit) => {
    if (run.cancelled) throw new Error("Security audit cancelled")
  }

  // One agent step: its task, followed while it runs for the step's detail.
  const runTask = async <R>(
    run: ActiveAudit,
    task: string,
    step: string,
    call: () => Promise<R>
  ) => {
    assertActive(run)
    run.tasks.add(task)
    const pending = call()
    const unfollow = followTask(engine, task, (activity) => {
      const current = run.audit.progress?.steps.find(({ id }) => id === step)
      if (current?.status === "running")
        updateStep(run, step, { detail: activityDetail(activity) }, true)
    })
    try {
      return await pending
    } finally {
      unfollow()
      run.tasks.delete(task)
    }
  }

  const stopTasks = (run: ActiveAudit) =>
    Promise.allSettled(
      [...run.tasks].map((session) => engine.call("cancelTask", { session }))
    )

  async function execute(run: ActiveAudit, input: SecurityAuditRunInput) {
    const auditId = run.audit.id
    const call = { model: input.model, projectId: input.projectId }
    update(run, {
      status: "mapping",
      progress: { phase: "mapping", steps: mappingSteps("running") },
    })
    const { workspace, repository } = await dependencies.map({
      root: input.root,
      ...(input.scope ? { scope: input.scope } : {}),
    })
    assertActive(run)
    update(run, {
      revision: repository.revision,
      surfaceMap: repository.surfaceMap,
      progress: {
        phase: "mapping",
        steps: mappingSteps("completed", repository),
      },
    })

    const perspectives = auditPerspectives(input.mode)
    const discoveryTasks = perspectives.map((perspective) =>
      auditTask(auditId, `discovery-${perspective}`)
    )
    update(run, {
      status: "discovery",
      sessionIds: discoveryTasks,
      progress: { phase: "discovery", steps: discoverySteps(perspectives) },
    })
    const discover = async (
      perspective: SecurityAuditPerspective,
      task: string
    ) => {
      const step = `discovery:${perspective}`
      const { session: _session, ...discovery } = await runTask(
        run,
        task,
        step,
        () =>
          engine.call("discoverSecurityAudit", {
            ...call,
            task,
            workspace,
            mode: input.mode,
            perspective,
            repository,
          })
      )
      assertActive(run)
      updateStep(run, step, {
        status: "completed",
        detail: `${count(discovery.candidates.length, "candidate")} reported`,
      })
      return discovery
    }
    const runs = await Promise.allSettled(
      perspectives.map((perspective, index) =>
        discover(perspective, discoveryTasks[index]!)
      )
    )
    assertActive(run)
    const discoveries = [
      deterministicDiscovery(repository),
      ...runs.map((result) => {
        if (result.status === "rejected") throw result.reason
        return result.value
      }),
    ]
    const candidateCount = discoveries.reduce(
      (total, discovery) => total + discovery.candidates.length,
      0
    )

    const validationTask = auditTask(auditId, "validation")
    update(run, {
      status: "validation",
      candidateCount,
      sessionIds: [...discoveryTasks, validationTask],
      progress: { phase: "validation", steps: validationSteps(candidateCount) },
    })
    const validation = await runTask(
      run,
      validationTask,
      "validation:evidence",
      () =>
        engine.call("validateSecurityAudit", {
          ...call,
          task: validationTask,
          workspace,
          mode: input.mode,
          repository,
          discoveries,
        })
    )
    assertActive(run)
    update(run, {
      progress: {
        phase: "validation",
        steps: validationSteps(candidateCount, {
          findings: validation.findings.length,
          coverage: validation.coverage.percentage,
        }),
      },
    })
    update(run, {
      status: "prioritization",
      progress: {
        phase: "prioritization",
        steps: prioritizationSteps("running"),
      },
    })
    const findings = reconcileFindings(
      auditId,
      validation.findings,
      input.previousFindings ?? []
    )
    update(run, {
      progress: {
        phase: "prioritization",
        steps: prioritizationSteps("completed"),
      },
    })
    return update(run, {
      status: "completed",
      threatModel: validation.threatModel,
      coverage: validation.coverage,
      findings,
      candidateCount: validation.candidateCount,
      rejectedCandidateCount: validation.rejectedCandidateCount,
      completedAt: new Date().toISOString(),
      progress: {
        phase: "completed",
        steps: [
          progressStep("report:ready", "Security report ready", "completed"),
        ],
      },
    })
  }

  return {
    /** The audit running for this project folder, if any. */
    active(root: string) {
      return active.get(root)?.audit
    },

    async run(input: SecurityAuditRunInput) {
      if (active.has(input.root))
        throw new Error("A security audit is already running for this project")
      const run: ActiveAudit = {
        audit: createAudit(input),
        cancelled: false,
        root: input.root,
        tasks: new Set(),
      }
      active.set(input.root, run)
      update(run, {})
      try {
        return await execute(run, input)
      } catch (error) {
        if (run.cancelled) return run.audit
        // One investigator failed: the others stop too.
        await stopTasks(run)
        const message =
          error instanceof Error ? error.message : "Security audit failed"
        update(run, {
          status: "failed",
          error: message,
          completedAt: new Date().toISOString(),
          progress: endRunningSteps(run.audit.progress, "failed"),
        })
        throw Object.assign(new Error(message), { audit: run.audit })
      } finally {
        active.delete(input.root)
      }
    },

    async cancel({ root, auditId }: { root: string; auditId: string }) {
      const run = active.get(root)
      if (!run || run.audit.id !== auditId) return undefined
      if (run.cancelled) return run.audit
      run.cancelled = true
      await stopTasks(run)
      if (run.audit.status !== "cancelled")
        update(run, {
          status: "cancelled",
          error: "Audit stopped by user.",
          completedAt: new Date().toISOString(),
          progress: endRunningSteps(
            run.audit.progress ?? { phase: "queued", steps: [] },
            "cancelled"
          ),
        })
      return run.audit
    },

    onChanged(listener: (change: SecurityAuditChange) => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
