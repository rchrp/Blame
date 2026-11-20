import * as React from "react"
import type {
  SecurityAudit,
  SecurityAuditMode,
  SecurityFinding,
} from "@blame/agent-runtime"
import {
  AlertTriangleIcon,
  LoaderCircleIcon,
  ShieldCheckIcon,
} from "lucide-react"
import { toast } from "sonner"

import { useBacklogStore } from "@/components/backlog/data/backlog-store"
import { useModelSelection } from "@/components/model/model-selection"
import { SecurityAuditDashboard } from "@/components/security/security-audit-dashboard"
import { SecurityAuditProgress } from "@/components/security/security-audit-progress"
import { SecurityFindingDrawer } from "@/components/security/security-finding-drawer"
import { SecurityLaunchDialog } from "@/components/security/security-launch-dialog"
import { SecurityRemediationDialog } from "@/components/security/security-remediation-dialog"
import { securityFindingStory } from "@/components/security/data/security-remediation"
import { useSecurityAudits } from "@/components/security/data/use-security-audits"
import { SecurityEmptyState } from "@/components/security/security-empty-state"
import { SecurityAuditHistory } from "@/components/security/security-audit-history"
import { Button } from "@/components/ui/button"
import { engineModelChoice } from "@/lib/agent-title-generation"

export function SecurityPage() {
  const selection = useModelSelection({ role: "alternative" })
  const security = useSecurityAudits()
  const backlog = useBacklogStore()
  const backlogLoading = backlog.loading
  const backlogProjectId = backlog.projectId
  const backlogStories = backlog.stories
  const securityProjectId = security.project?.id
  const updateSecurityFinding = security.updateFinding
  const [launchOpen, setLaunchOpen] = React.useState(false)
  const [remediationOpen, setRemediationOpen] = React.useState(false)
  const [selectedAuditId, setSelectedAuditId] = React.useState<string>()
  const [selectedFingerprint, setSelectedFingerprint] = React.useState<string>()
  const [addingFingerprint, setAddingFingerprint] = React.useState<string>()
  const [creatingPlan, setCreatingPlan] = React.useState(false)
  const [cancelling, setCancelling] = React.useState(false)
  const audit =
    security.audits.find((item) => item.id === selectedAuditId) ??
    security.latest
  const displayAudit = React.useMemo(
    () =>
      auditWithCurrentBacklogLinks(
        audit,
        backlogLoading,
        backlogProjectId,
        backlogStories
      ),
    [audit, backlogLoading, backlogProjectId, backlogStories]
  )
  const selectedFinding = displayAudit?.findings.find(
    (finding) => finding.fingerprint === selectedFingerprint
  )
  const previousCompletedAudit = security.audits.find(
    (item) => item.status === "completed"
  )

  const runAudit = (mode: SecurityAuditMode) => {
    const model = engineModelChoice(selection)
    if (!model || !security.project) {
      toast.error("Connect an analysis model before running an audit.")
      return
    }
    setSelectedAuditId(undefined)
    void security
      .run({
        model,
        projectId: security.project.id,
        mode,
        scope: { type: "repository" },
      })
      .then((result) => {
        if (result.status === "completed")
          toast.success("Security audit completed.")
      })
      .catch((error) =>
        toast.error("Security audit failed", {
          description: error instanceof Error ? error.message : undefined,
        })
      )
  }

  const cancelAudit = async () => {
    if (!audit) return
    setCancelling(true)
    try {
      await security.cancel(audit.id)
      toast.info("Security audit stopped cleanly.")
    } catch (error) {
      toast.error("Unable to stop the security audit", {
        description: error instanceof Error ? error.message : undefined,
      })
    } finally {
      setCancelling(false)
    }
  }

  React.useEffect(() => {
    if (!audit || backlogLoading || backlogProjectId !== securityProjectId) {
      return
    }
    const storyIds = new Set(backlogStories.map((story) => story.id))
    const stale = audit.findings.filter(
      (finding) =>
        finding.backlogStoryId && !storyIds.has(finding.backlogStoryId)
    )
    if (!stale.length) return
    void (async () => {
      for (const finding of stale) {
        await updateSecurityFinding(audit.id, finding.fingerprint, {
          backlogStoryId: null,
          status: finding.status === "fixing" ? "open" : finding.status,
        })
      }
    })().catch(() => undefined)
  }, [
    audit,
    backlogLoading,
    backlogProjectId,
    backlogStories,
    securityProjectId,
    updateSecurityFinding,
  ])

  const addToBacklog = async (finding: SecurityFinding, quiet = false) => {
    if (!audit) return
    setAddingFingerprint(finding.fingerprint)
    try {
      const story = await backlog.create(securityFindingStory(finding))
      await security.updateFinding(audit.id, finding.fingerprint, {
        backlogStoryId: story.id,
        status: "fixing",
      })
      if (!quiet) toast.success(`${finding.id} added to the backlog.`)
    } finally {
      setAddingFingerprint(undefined)
    }
  }

  const createPlan = async (findings: SecurityFinding[]) => {
    setCreatingPlan(true)
    try {
      for (const finding of findings) await addToBacklog(finding, true)
      setRemediationOpen(false)
      toast.success(
        `${findings.length} remediation ${findings.length === 1 ? "story" : "stories"} created.`
      )
    } catch (error) {
      toast.error("Unable to create the complete remediation plan", {
        description: error instanceof Error ? error.message : undefined,
      })
    } finally {
      setCreatingPlan(false)
    }
  }

  if (security.loading && !audit) return <SecurityLoading />

  return (
    <>
      {audit && audit.status !== "completed" && (
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 px-4 pt-[calc(var(--header-height)+1rem)] lg:px-6 lg:pt-[calc(var(--header-height)+1.5rem)]">
          <h2 className="font-heading text-xl font-semibold">Security Audit</h2>
          <SecurityAuditHistory
            audit={audit}
            audits={security.audits}
            onSelect={setSelectedAuditId}
          />
        </div>
      )}
      {!audit ? (
        <SecurityEmptyState
          error={security.error}
          onRun={() => setLaunchOpen(true)}
        />
      ) : audit.status === "failed" ? (
        <SecurityFailedState
          auditError={audit.error}
          onRun={() => setLaunchOpen(true)}
          onViewPrevious={
            previousCompletedAudit
              ? () => setSelectedAuditId(previousCompletedAudit.id)
              : undefined
          }
        />
      ) : audit.status === "cancelled" ? (
        <SecurityStoppedState onRun={() => setLaunchOpen(true)} />
      ) : audit.status !== "completed" ? (
        <SecurityAuditProgress
          audit={audit}
          cancelling={cancelling}
          onCancel={() => void cancelAudit()}
        />
      ) : (
        <SecurityAuditDashboard
          audit={displayAudit ?? audit}
          audits={security.audits}
          onCreatePlan={() => setRemediationOpen(true)}
          onRun={() => setLaunchOpen(true)}
          onSelectAudit={setSelectedAuditId}
          onSelectFinding={(finding) =>
            setSelectedFingerprint(finding.fingerprint)
          }
        />
      )}
      <SecurityLaunchDialog
        open={launchOpen}
        onOpenChange={setLaunchOpen}
        onRun={runAudit}
      />
      <SecurityFindingDrawer
        finding={selectedFinding}
        open={Boolean(selectedFinding)}
        adding={addingFingerprint === selectedFinding?.fingerprint}
        onAddToBacklog={(finding) =>
          void addToBacklog(finding).catch(showBacklogError)
        }
        onOpenChange={(open) => {
          if (!open) setSelectedFingerprint(undefined)
        }}
      />
      <SecurityRemediationDialog
        key={`${audit?.id ?? "none"}:${remediationOpen}`}
        creating={creatingPlan}
        findings={displayAudit?.findings ?? []}
        open={remediationOpen}
        onCreate={(findings) => void createPlan(findings)}
        onOpenChange={setRemediationOpen}
      />
    </>
  )
}

function auditWithCurrentBacklogLinks(
  audit: SecurityAudit | undefined,
  backlogLoading: boolean,
  backlogProjectId: string | undefined,
  backlogStories: ReturnType<typeof useBacklogStore>["stories"]
) {
  if (!audit || backlogLoading || backlogProjectId !== audit.projectId) {
    return audit
  }
  const storyIds = new Set(backlogStories.map((story) => story.id))
  let changed = false
  const findings = audit.findings.map((finding) => {
    if (!finding.backlogStoryId || storyIds.has(finding.backlogStoryId)) {
      return finding
    }
    changed = true
    const { backlogStoryId, ...withoutLink } = finding
    void backlogStoryId
    return {
      ...withoutLink,
      status: finding.status === "fixing" ? ("open" as const) : finding.status,
    }
  })
  return changed ? { ...audit, findings } : audit
}

function SecurityFailedState({
  auditError,
  onRun,
  onViewPrevious,
}: {
  auditError?: string
  onRun(): void
  onViewPrevious?(): void
}) {
  return (
    <div className="flex flex-1 items-center justify-center px-6 py-12">
      <div className="w-full max-w-md rounded-xl border bg-card p-6 text-center">
        <AlertTriangleIcon className="mx-auto size-8 text-destructive" />
        <h2 className="mt-3 font-heading text-xl font-semibold">
          Audit interrupted
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {auditError ?? "The audit could not be completed."}
        </p>
        <div className="mt-5 flex justify-center gap-2">
          {onViewPrevious ? (
            <Button variant="outline" onClick={onViewPrevious}>
              View previous audit
            </Button>
          ) : null}
          <Button onClick={onRun}>Run again</Button>
        </div>
      </div>
    </div>
  )
}

function SecurityStoppedState({ onRun }: { onRun(): void }) {
  return (
    <div className="flex flex-1 items-center justify-center px-6 py-12">
      <div className="w-full max-w-md rounded-xl border bg-card p-6 text-center">
        <ShieldCheckIcon className="mx-auto size-8 text-muted-foreground" />
        <h2 className="mt-3 font-heading text-xl font-semibold">
          Audit stopped
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The running agents were stopped and the partial audit state
          was saved to the cloud.
        </p>
        <Button className="mt-5" onClick={onRun}>
          Run again
        </Button>
      </div>
    </div>
  )
}

function SecurityLoading() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <LoaderCircleIcon className="size-5 animate-spin text-muted-foreground" />
    </div>
  )
}

function showBacklogError(error: unknown) {
  toast.error("Unable to add the finding to the backlog", {
    description: error instanceof Error ? error.message : undefined,
  })
}
