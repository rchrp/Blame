import type {
  AgentBackendConfig,
  ApiConnection,
  ReasoningSelection,
} from "./types.js";

/** The model and workspace a security audit agent runs with. */
type SecurityAuditAgentInput = {
  apiConnection: ApiConnection;
  providerId: string;
  modelId: string;
  reasoningEffort?: ReasoningSelection;
  cwd: string;
  workspaceRoot: string;
  credentialLabel?: string;
  backend?: AgentBackendConfig;
};

export type SecurityAuditMode = "standard" | "deep";
export type SecurityAuditStatus =
  | "queued"
  | "mapping"
  | "discovery"
  | "validation"
  | "prioritization"
  | "completed"
  | "failed"
  | "cancelled";
export type SecuritySeverity = "critical" | "high" | "medium" | "low";
export type SecurityConfidence = "high" | "medium" | "low";
export type SecurityPriority = "p0" | "p1" | "p2" | "p3";
export type SecurityFindingStatus =
  | "open"
  | "fixing"
  | "fixed"
  | "accepted_risk"
  | "false_positive"
  | "regressed";

export type SecurityAuditProgressStepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type SecurityAuditProgressStep = {
  id: string;
  label: string;
  status: SecurityAuditProgressStepStatus;
  detail?: string;
};

export type SecurityAuditProgress = {
  phase: Exclude<SecurityAuditStatus, "failed" | "cancelled">;
  steps: SecurityAuditProgressStep[];
};

export type SecuritySourceLocation = {
  path: string;
  startLine?: number;
  endLine?: number;
  symbol?: string;
};

export type SecurityEvidence = {
  summary: string;
  location?: SecuritySourceLocation;
  code?: string;
};

export type SecurityThreatModel = {
  assets: string[];
  actors: string[];
  trustBoundaries: string[];
  attackerInputs: string[];
  securityInvariants: string[];
};

export type SecuritySurfaceMap = {
  rootName: string;
  fileCount: number;
  relevantFileCount: number;
  ignoredDirectoryCount: number;
  truncated: boolean;
  languages: string[];
  frameworks: string[];
  projectRoots: { path: string; markers: string[] }[];
  services: string[];
  entrypoints: string[];
  sensitivePaths: string[];
  dependencyPaths: string[];
  infrastructurePaths: string[];
  ciPaths: string[];
  evidencePaths: string[];
};

export type SecurityRevision = {
  branch?: string;
  commitSha?: string;
  snapshotDigest: string;
  dirty: boolean;
};

export type SecurityCoverageArea = {
  area:
    | "source"
    | "dependencies"
    | "secrets"
    | "infrastructure"
    | "runtime"
    | "git_history";
  status: "complete" | "partial" | "limited" | "not_scanned";
  detail?: string;
};

export type SecurityCoverage = {
  status: "complete" | "partial" | "limited";
  percentage: number;
  reviewedFiles: number;
  totalFiles: number;
  excludedFiles: number;
  areas: SecurityCoverageArea[];
  inspectedPaths: string[];
  limitations: string[];
};

export type SecurityCandidate = {
  id: string;
  sourceCandidateIds: string[];
  sources: string[];
  title: string;
  summary: string;
  vulnerabilityFamily: string;
  rootControl: string;
  component: string;
  attacker: string;
  asset?: string;
  locations: SecuritySourceLocation[];
  evidence: SecurityEvidence[];
  taxonomy: {
    cwe?: string[];
    owasp?: string[];
    asvs?: string[];
  };
};

export type SecurityAttackPathStep = {
  label: string;
  location?: SecuritySourceLocation;
};

export type SecurityFinding = {
  id: string;
  fingerprint: string;
  title: string;
  status: SecurityFindingStatus;
  severity: SecuritySeverity;
  confidence: SecurityConfidence;
  priority: SecurityPriority;
  taxonomy: {
    cwe?: string[];
    owasp?: string[];
    asvs?: string[];
  };
  attacker: string;
  asset?: string;
  rootCause: {
    summary: string;
    location?: SecuritySourceLocation;
  };
  attackPath: SecurityAttackPathStep[];
  impact: string;
  evidence: SecurityEvidence[];
  affectedLocations: SecuritySourceLocation[];
  remediation: {
    summary: string;
    guidance?: string[];
  };
  validation: {
    rationale: string;
    counterEvidence: string[];
  };
  backlogStoryId?: string;
  firstSeenAuditId?: string;
  lastSeenAuditId?: string;
};

export type SecurityAudit = {
  version: 1;
  id: string;
  sequence: number;
  projectId?: string;
  mode: SecurityAuditMode;
  scope: { type: "repository" | "paths"; paths?: string[] };
  status: SecurityAuditStatus;
  revision?: SecurityRevision;
  surfaceMap?: SecuritySurfaceMap;
  threatModel?: SecurityThreatModel;
  coverage?: SecurityCoverage;
  findings: SecurityFinding[];
  candidateCount: number;
  rejectedCandidateCount: number;
  sessionIds: string[];
  progress?: SecurityAuditProgress;
  scannerVersions: Record<string, string>;
  analysisModel?: {
    providerId: string;
    modelId: string;
    reasoningEffort?: string;
  };
  error?: string;
  startedAt: string;
  completedAt?: string;
  updatedAt: string;
};

export type MapSecurityAuditInput = {
  cwd: string;
  workspaceRoot: string;
  scope?: { type: "repository" | "paths"; paths?: string[] };
  backend?: AgentBackendConfig;
};

export type MapSecurityAuditResult = {
  revision: SecurityRevision;
  surfaceMap: SecuritySurfaceMap;
  deterministic: SecurityDeterministicScanResult;
};

export type SecurityAuditPerspective =
  | "baseline"
  | "forward_data_flow"
  | "backward_sensitive_operations"
  | "business_logic";

export type DiscoverSecurityAuditInput = SecurityAuditAgentInput & {
  auditId: string;
  mode: SecurityAuditMode;
  perspective: SecurityAuditPerspective;
  repository: MapSecurityAuditResult;
};

export type SecurityAuditDiscoveryResult = {
  sessionId: string;
  threatModel: SecurityThreatModel;
  candidates: SecurityCandidate[];
  inspectedPaths: string[];
  limitations: string[];
};

export type SecurityScannerCoverage = {
  id: string;
  reviewedFiles: number;
  totalFiles: number;
  status: "complete" | "partial" | "limited";
  limitations: string[];
};

export type SecurityDeterministicScanResult = {
  candidates: SecurityCandidate[];
  inspectedPaths: string[];
  limitations: string[];
  scanners: SecurityScannerCoverage[];
};

export type ValidateSecurityAuditInput = SecurityAuditAgentInput & {
  auditId: string;
  mode: SecurityAuditMode;
  repository: MapSecurityAuditResult;
  discoveries: SecurityAuditDiscoveryResult[];
};

export type ValidateSecurityAuditResult = {
  sessionId: string;
  threatModel: SecurityThreatModel;
  findings: SecurityFinding[];
  candidateCount: number;
  rejectedCandidateCount: number;
  coverage: SecurityCoverage;
};

export type RunSecurityAuditInput = SecurityAuditAgentInput & {
  projectId?: string;
  mode: SecurityAuditMode;
  scope?: { type: "repository" | "paths"; paths?: string[] };
  previousFindings?: SecurityAuditFindingHistory[];
};

export type SecurityAuditFindingHistory = Pick<
  SecurityFinding,
  "backlogStoryId" | "fingerprint" | "firstSeenAuditId" | "status"
> & { auditId: string };
