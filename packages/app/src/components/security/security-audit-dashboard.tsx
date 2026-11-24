import type {
  SecurityAudit,
  SecurityFinding,
  SecuritySeverity,
} from "@blame/agent-runtime"
import {
  CheckCircle2Icon,
  ChevronRightIcon,
  ListChecksIcon,
  RotateCwIcon,
} from "lucide-react"

import {
  KanbanBoard,
  KanbanColumn,
  KanbanColumnHeader,
} from "@/components/shared/kanban-board"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { SeverityBadge } from "@/components/security/security-finding-drawer"
import {
  auditDate,
  auditRevision,
  SecurityAuditHistory,
} from "./security-audit-history"

type SecurityAuditDashboardProps = {
  audit: SecurityAudit
  audits: SecurityAudit[]
  onCreatePlan(): void
  onRun(): void
  onSelectAudit(auditId: string): void
  onSelectFinding(finding: SecurityFinding): void
}

const columns: {
  severity: SecuritySeverity
  title: string
  description: string
  color: string
}[] = [
  {
    severity: "critical",
    title: "Critical",
    description: "Address first",
    color: "border-red-500",
  },
  {
    severity: "high",
    title: "High",
    description: "Prioritize next",
    color: "border-orange-500",
  },
  {
    severity: "medium",
    title: "Medium",
    description: "Plan remediation",
    color: "border-amber-500",
  },
  {
    severity: "low",
    title: "Low",
    description: "Review and improve",
    color: "border-blue-500",
  },
]

export function SecurityAuditDashboard(props: SecurityAuditDashboardProps) {
  return (
    <div className="project-page-top flex h-svh min-h-0 min-w-0 flex-col gap-4 overflow-hidden px-4 pb-4 md:h-[calc(100svh_-_1rem)] lg:px-6 lg:pb-6">
      <AuditToolbar {...props} />
      <AuditSummary audit={props.audit} />
      <KanbanBoard gridClassName="min-w-280 grid-cols-4">
        {columns.map((column) => (
          <FindingColumn
            key={column.severity}
            column={column}
            findings={props.audit.findings.filter(
              (finding) => finding.severity === column.severity
            )}
            onSelect={props.onSelectFinding}
          />
        ))}
      </KanbanBoard>
    </div>
  )
}

function AuditToolbar(props: SecurityAuditDashboardProps) {
  const { audit, audits, onCreatePlan, onRun, onSelectAudit } = props
  const canCreatePlan = audit.findings.some(
    (finding) => !finding.backlogStoryId && finding.status === "open"
  )
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
      <AuditTitle audit={audit} />
      <div className="flex flex-wrap items-center gap-2">
        <SecurityAuditHistory
          audit={audit}
          audits={audits}
          onSelect={onSelectAudit}
        />
        <Button
          variant="outline"
          onClick={onCreatePlan}
          disabled={!canCreatePlan}
        >
          <ListChecksIcon /> Create remediation plan
        </Button>
        <Button onClick={onRun}>
          <RotateCwIcon /> Run audit
        </Button>
      </div>
    </div>
  )
}

function AuditSummary({ audit }: { audit: SecurityAudit }) {
  const linked = audit.findings.filter(
    (finding) => finding.backlogStoryId
  ).length
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
      <span className="font-medium text-foreground">
        {audit.findings.length} validated findings
      </span>
      <span>{linked} in backlog</span>
      <span>{audit.mode === "deep" ? "Deep audit" : "Standard audit"}</span>
      {!audit.findings.length && (
        <span className="inline-flex items-center gap-1.5">
          <CheckCircle2Icon className="size-4 text-emerald-600 dark:text-emerald-400" />{" "}
          No validated findings in this revision.
        </span>
      )}
    </div>
  )
}

type FindingColumnProps = {
  column: (typeof columns)[number]
  findings: SecurityFinding[]
  onSelect(finding: SecurityFinding): void
}

function FindingColumn({ column, findings, onSelect }: FindingColumnProps) {
  return (
    <KanbanColumn
      header={<KanbanColumnHeader {...column} count={findings.length} />}
    >
      {findings.length ? (
        findings.map((finding) => (
          <FindingCard
            key={finding.fingerprint}
            finding={finding}
            onSelect={onSelect}
          />
        ))
      ) : (
        <p className="px-2 py-8 text-center text-sm text-muted-foreground">
          No {column.severity} findings
        </p>
      )}
    </KanbanColumn>
  )
}

function FindingCard({
  finding,
  onSelect,
}: {
  finding: SecurityFinding
  onSelect(finding: SecurityFinding): void
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(finding)}
      className="group flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-4 text-left transition-colors hover:border-foreground/25 hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <span className="flex w-full items-center justify-between gap-2">
        <SeverityBadge severity={finding.severity} />
        <span className="font-mono text-xs text-muted-foreground">
          {finding.id}
        </span>
      </span>
      <span className="line-clamp-3 font-medium break-words">
        {finding.title}
      </span>
      <span className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
        {finding.rootCause.summary}
      </span>
      <span className="w-full truncate font-mono text-xs text-muted-foreground">
        {finding.affectedLocations[0]?.path ?? "Project-wide"}
      </span>
      <FindingCardFooter finding={finding} />
    </button>
  )
}

function AuditTitle({ audit }: { audit: SecurityAudit }) {
  return (
    <div className="min-w-0">
      <h2 className="project-page-title">Security Audit</h2>
      <p className="text-sm break-words text-muted-foreground">
        {auditRevision(audit)} ·{" "}
        {auditDate(audit.completedAt ?? audit.updatedAt)}
      </p>
    </div>
  )
}

function FindingCardFooter({ finding }: { finding: SecurityFinding }) {
  return (
    <span className="flex w-full flex-wrap items-center gap-2 border-t pt-3">
      <Badge variant="outline">
        {finding.backlogStoryId
          ? "In backlog"
          : finding.status.replaceAll("_", " ")}
      </Badge>
      <span className="text-xs text-muted-foreground">
        {finding.confidence} confidence
      </span>
      <ChevronRightIcon className="ml-auto size-4 text-muted-foreground" />
    </span>
  )
}
