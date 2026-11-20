// What a running security audit shows and keeps: the audit it starts as,
// its progress steps, and its findings reconciled with the earlier audits.
import type {
  MapSecurityAuditResult,
  SecurityAudit,
  SecurityAuditDiscoveryResult,
  SecurityAuditFindingHistory,
  SecurityAuditMode,
  SecurityAuditPerspective,
  SecurityAuditProgressStep,
} from "@blame/agent-runtime"
import type { EngineModelChoice } from "@blame/agent-runtime/engine-protocol"

export type SecurityAuditRunInput = {
  /** The project folder, as the app knows it. */
  root: string
  projectId: string
  model: EngineModelChoice
  mode: SecurityAuditMode
  scope?: SecurityAudit["scope"]
  previousFindings?: SecurityAuditFindingHistory[]
}

export function createAudit(input: SecurityAuditRunInput): SecurityAudit {
  const timestamp = new Date().toISOString()
  return {
    version: 1,
    id: crypto.randomUUID(),
    sequence: 0,
    projectId: input.projectId,
    analysisModel: {
      providerId: input.model.providerId,
      modelId: input.model.modelId,
      ...(input.model.reasoning
        ? { reasoningEffort: input.model.reasoning }
        : {}),
    },
    mode: input.mode,
    scope: input.scope ?? { type: "repository" },
    status: "queued",
    findings: [],
    candidateCount: 0,
    rejectedCandidateCount: 0,
    sessionIds: [],
    scannerVersions: {
      "blame-security-engine": "1",
      "ai-static-review": "1",
      "local-secret-scanner": "1",
      "threat-model": "1",
    },
    progress: {
      phase: "queued",
      steps: [
        progressStep(
          "queued:runtime",
          "Preparing the local audit runtime",
          "running"
        ),
      ],
    },
    startedAt: timestamp,
    updatedAt: timestamp,
  }
}

/** The engine task of one agent step, named after the audit. */
export function auditTask(auditId: string, step: string) {
  return `security-${auditId}-${step}`
}

export function auditPerspectives(
  mode: SecurityAuditMode
): SecurityAuditPerspective[] {
  return mode === "deep"
    ? ["forward_data_flow", "backward_sensitive_operations", "business_logic"]
    : ["baseline"]
}

export function reconcileFindings(
  auditId: string,
  findings: SecurityAudit["findings"],
  history: SecurityAuditFindingHistory[]
) {
  const previousByFingerprint = new Map<string, SecurityAuditFindingHistory>()
  for (const previous of history) {
    if (!previousByFingerprint.has(previous.fingerprint)) {
      previousByFingerprint.set(previous.fingerprint, previous)
    }
  }
  return findings.map((finding) => {
    const previous = previousByFingerprint.get(finding.fingerprint)
    return {
      ...finding,
      status:
        previous?.status === "fixed"
          ? ("regressed" as const)
          : (previous?.status ?? finding.status),
      ...(previous?.backlogStoryId
        ? { backlogStoryId: previous.backlogStoryId }
        : {}),
      firstSeenAuditId:
        previous?.firstSeenAuditId ?? previous?.auditId ?? auditId,
      lastSeenAuditId: auditId,
    }
  })
}

/** The deterministic scanners' candidates, validated with the agents'. */
export function deterministicDiscovery(
  repository: MapSecurityAuditResult
): SecurityAuditDiscoveryResult {
  return {
    threatModel: {
      assets: [],
      actors: [],
      trustBoundaries: [],
      attackerInputs: [],
      securityInvariants: [],
    },
    candidates: repository.deterministic.candidates,
    inspectedPaths: repository.deterministic.inspectedPaths,
    limitations: repository.deterministic.limitations,
  }
}

export function mappingSteps(
  status: "running" | "completed",
  repository?: MapSecurityAuditResult
): SecurityAuditProgressStep[] {
  return [
    progressStep(
      "mapping:inventory",
      "Indexing repository files and revision",
      status,
      repository ? `${repository.surfaceMap.fileCount} files mapped` : undefined
    ),
    progressStep(
      "mapping:surface",
      "Detecting services, entrypoints and sensitive paths",
      status === "running" ? "pending" : "completed",
      repository
        ? `${repository.surfaceMap.services.length} services · ${repository.surfaceMap.entrypoints.length} entrypoints`
        : undefined
    ),
    progressStep(
      "mapping:secrets",
      "Scanning current files for exposed secrets",
      status === "running" ? "pending" : "completed",
      repository
        ? `${repository.deterministic.inspectedPaths.length} paths inspected by deterministic scanners`
        : undefined
    ),
  ]
}

export function discoverySteps(
  perspectives: SecurityAuditPerspective[]
): SecurityAuditProgressStep[] {
  return [
    progressStep(
      "discovery:deterministic",
      "Reviewing deterministic scanner candidates",
      "completed"
    ),
    ...perspectives.map((perspective) =>
      progressStep(
        `discovery:${perspective}`,
        perspectiveLabel(perspective),
        "running"
      )
    ),
  ]
}

export function validationSteps(
  candidateCount: number,
  validation?: { findings: number; coverage: number }
): SecurityAuditProgressStep[] {
  return [
    progressStep(
      "validation:merge",
      "Merging duplicate candidates",
      "completed",
      validation
        ? undefined
        : `${count(candidateCount, "candidate")} to validate`
    ),
    progressStep(
      "validation:evidence",
      "Tracing reachability, controls and counter-evidence",
      validation ? "completed" : "running",
      validation
        ? `${count(validation.findings, "validated finding")}`
        : undefined
    ),
    progressStep(
      "validation:coverage",
      "Calculating coverage and confidence",
      validation ? "completed" : "pending",
      validation ? `${validation.coverage}% repository review` : undefined
    ),
  ]
}

export function prioritizationSteps(
  status: "running" | "completed"
): SecurityAuditProgressStep[] {
  return [
    progressStep(
      "prioritization:fingerprints",
      "Reconciling fingerprints with audit history",
      status
    ),
    progressStep(
      "prioritization:report",
      "Preparing the final report",
      status === "running" ? "pending" : "completed"
    ),
  ]
}

function perspectiveLabel(perspective: SecurityAuditPerspective) {
  if (perspective === "forward_data_flow")
    return "Tracing untrusted inputs to sensitive operations"
  if (perspective === "backward_sensitive_operations")
    return "Tracing sensitive operations back to callers"
  if (perspective === "business_logic")
    return "Reviewing authorization and business invariants"
  return "Reviewing attack paths across the project"
}

/** The step with its new status and detail; the others unchanged. */
export function withStep(
  steps: SecurityAuditProgressStep[],
  id: string,
  update: Partial<Pick<SecurityAuditProgressStep, "status" | "detail">>
) {
  return steps.map((step) => (step.id === id ? { ...step, ...update } : step))
}

/** Running steps end as `status` (the audit failed or was stopped). */
export function endRunningSteps(
  progress: SecurityAudit["progress"],
  status: "failed" | "cancelled"
): SecurityAudit["progress"] {
  if (!progress) return undefined
  return {
    ...progress,
    steps: progress.steps.map((step) =>
      step.status === "running" ? { ...step, status } : step
    ),
  }
}

export function count(value: number, noun: string) {
  return `${value} ${noun}${value === 1 ? "" : "s"}`
}

export function progressStep(
  id: string,
  label: string,
  status: SecurityAuditProgressStep["status"],
  detail?: string
): SecurityAuditProgressStep {
  return { id, label, status, ...(detail ? { detail } : {}) }
}
