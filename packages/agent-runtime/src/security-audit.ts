import { createHash } from "node:crypto";

import type {
  MapSecurityAuditResult,
  SecurityAuditDiscoveryResult,
  SecurityCandidate,
  SecurityCoverage,
  SecurityEvidence,
  SecurityFinding,
  SecurityPriority,
  SecuritySeverity,
  SecuritySourceLocation,
  SecurityThreatModel,
  ValidateSecurityAuditResult,
} from "./types.js";

/** A discovery pass's result, from the input its result tool accepted. */
export function parseSecurityDiscovery(
  value: unknown,
  source: string,
): SecurityAuditDiscoveryResult {
  const result = record(value, "Security discovery result is invalid");
  const candidates = array(result.candidates).map((candidate, index) =>
    parseCandidate(candidate, `${source}-${index + 1}`, source),
  );
  return {
    threatModel: parseThreatModel(result.threatModel),
    candidates,
    inspectedPaths: strings(result.inspectedPaths),
    limitations: strings(result.limitations),
  };
}

export function mergeSecurityCandidates(
  discoveries: SecurityAuditDiscoveryResult[],
) {
  const groups = new Map<string, SecurityCandidate>();
  for (const candidate of discoveries.flatMap(({ candidates }) => candidates)) {
    const key = candidateMergeKey(candidate);
    const current = groups.get(key);
    groups.set(key, current ? mergeCandidate(current, candidate) : candidate);
  }
  return [...groups.values()].map((candidate, index) => ({
    ...candidate,
    id: `candidate-${index + 1}`,
  }));
}

/** The validated findings and coverage, from the validator's accepted input. */
export function parseSecurityValidation(
  value: unknown,
  repository: MapSecurityAuditResult,
  discoveries: SecurityAuditDiscoveryResult[],
): ValidateSecurityAuditResult {
  const result = record(value, "Security validation result is invalid");
  const candidates = mergeSecurityCandidates(discoveries);
  const rawFindings = array(result.findings);
  const validatedFindings = rawFindings.map((raw) => ({
    raw,
    finding: parseFinding(raw),
  }));
  const reportableFindings = validatedFindings.filter(
    ({ finding }) => finding.confidence !== "low",
  );
  const findings = reportableFindings.map(({ finding }) => finding);
  const inspectedPaths = unique([
    ...discoveries.flatMap(({ inspectedPaths }) => inspectedPaths),
    ...strings(result.inspectedPaths),
  ]);
  const limitations = unique([
    ...discoveries.flatMap(({ limitations }) => limitations),
    ...strings(result.limitations),
  ]);
  const coveredCandidates = new Set(
    reportableFindings.flatMap(({ raw }) =>
      strings(record(raw, "Validated finding is invalid").candidateIds),
    ),
  );
  const rejectedIds = new Set(
    array(result.rejected).flatMap((item) =>
      strings(record(item, "Rejected candidate is invalid").candidateIds),
    ),
  );
  return {
    threatModel: mergeThreatModels(
      discoveries.map(({ threatModel }) => threatModel),
    ),
    findings,
    candidateCount: candidates.length,
    rejectedCandidateCount: Math.max(
      rejectedIds.size,
      candidates.length - coveredCandidates.size,
    ),
    coverage: securityCoverage(repository, inspectedPaths, limitations),
  };
}

function parseCandidate(value: unknown, fallbackId: string, source: string) {
  const candidate = record(value, "Security candidate is invalid");
  const id = text(candidate.id) ?? fallbackId;
  return {
    id,
    sourceCandidateIds: [id],
    sources: [`ai:${source}`],
    title: requiredText(candidate.title, "Candidate title"),
    summary: requiredText(candidate.summary, "Candidate summary"),
    vulnerabilityFamily: requiredText(
      candidate.vulnerabilityFamily,
      "Candidate family",
    ),
    rootControl: requiredText(candidate.rootControl, "Candidate root control"),
    component: requiredText(candidate.component, "Candidate component"),
    attacker: requiredText(candidate.attacker, "Candidate attacker"),
    ...(text(candidate.asset) ? { asset: text(candidate.asset) } : {}),
    locations: array(candidate.locations).map(parseLocation),
    evidence: array(candidate.evidence).map(parseEvidence),
    taxonomy: parseTaxonomy(candidate.taxonomy),
  } satisfies SecurityCandidate;
}

function parseFinding(value: unknown): SecurityFinding {
  const finding = record(value, "Validated finding is invalid");
  const rootCause = record(finding.rootCause, "Finding root cause is invalid");
  const remediation = record(
    finding.remediation,
    "Finding remediation is invalid",
  );
  const affectedLocations = array(finding.affectedLocations).map(parseLocation);
  const title = requiredText(finding.title, "Finding title");
  const fingerprint = findingFingerprint({
    title,
    rootCause: requiredText(rootCause.summary, "Root cause summary"),
    locations: affectedLocations,
    attackPath: array(finding.attackPath).map((step) =>
      requiredText(
        record(step, "Attack path step is invalid").label,
        "Attack path label",
      ),
    ),
  });
  return {
    id: `SEC-${fingerprint.slice(0, 8).toUpperCase()}`,
    fingerprint,
    title,
    status: "open",
    severity: securitySeverity(finding.severity),
    confidence: securityConfidence(finding.confidence),
    priority: securityPriority(finding.priority),
    taxonomy: parseTaxonomy(finding.taxonomy),
    attacker: requiredText(finding.attacker, "Finding attacker"),
    ...(text(finding.asset) ? { asset: text(finding.asset) } : {}),
    rootCause: {
      summary: requiredText(rootCause.summary, "Root cause summary"),
      ...(rootCause.location
        ? { location: parseLocation(rootCause.location) }
        : {}),
    },
    attackPath: array(finding.attackPath).map((step) => {
      const item = record(step, "Attack path step is invalid");
      return {
        label: requiredText(item.label, "Attack path label"),
        ...(item.location ? { location: parseLocation(item.location) } : {}),
      };
    }),
    impact: requiredText(finding.impact, "Finding impact"),
    evidence: array(finding.evidence).map(parseEvidence),
    affectedLocations,
    remediation: {
      summary: requiredText(remediation.summary, "Remediation summary"),
      guidance: strings(remediation.guidance),
    },
    validation: {
      rationale: requiredText(finding.rationale, "Validation rationale"),
      counterEvidence: strings(finding.counterEvidence),
    },
  };
}

function securityCoverage(
  repository: MapSecurityAuditResult,
  inspectedPaths: string[],
  limitations: string[],
): SecurityCoverage {
  const relevant = Math.max(repository.surfaceMap.relevantFileCount, 1);
  const reviewedFiles = unique(inspectedPaths).length;
  const percentage = Math.min(
    100,
    Math.round((reviewedFiles / relevant) * 100),
  );
  const areas: SecurityCoverage["areas"] = [
    { area: "source", status: percentage >= 85 ? "complete" : "partial" },
    {
      area: "dependencies",
      status: "limited",
      detail: "Manifests reviewed; no external advisory database queried.",
    },
    {
      area: "secrets",
      status: secretCoverage(repository).status,
      detail: secretCoverage(repository).detail,
    },
    {
      area: "infrastructure",
      status: repository.surfaceMap.infrastructurePaths.length
        ? "partial"
        : "not_scanned",
    },
    {
      area: "runtime",
      status: "not_scanned",
      detail: "Runtime audit is not enabled in this release.",
    },
    { area: "git_history", status: "not_scanned" },
  ];
  return {
    status:
      percentage >= 85 ? "complete" : percentage >= 40 ? "partial" : "limited",
    percentage,
    reviewedFiles,
    totalFiles: repository.surfaceMap.fileCount,
    excludedFiles: repository.surfaceMap.ignoredDirectoryCount,
    areas,
    inspectedPaths: unique(inspectedPaths).sort(),
    limitations: unique([
      ...limitations,
      ...(repository.surfaceMap.truncated
        ? ["Repository discovery reached its safety limit."]
        : []),
    ]),
  };
}

function secretCoverage(repository: MapSecurityAuditResult) {
  const scanner = repository.deterministic.scanners.find(
    ({ id }) => id === "local-secret-scanner",
  );
  if (!scanner) {
    return {
      status: "not_scanned" as const,
      detail: "Local secret scanner was unavailable.",
    };
  }
  return {
    status: scanner.status,
    detail: `${scanner.reviewedFiles} of ${scanner.totalFiles} current candidate files scanned locally; Git history and entropy scanning were not included.`,
  };
}

function mergeCandidate(left: SecurityCandidate, right: SecurityCandidate) {
  return {
    ...left,
    sourceCandidateIds: unique([
      ...left.sourceCandidateIds,
      ...right.sourceCandidateIds,
    ]),
    sources: unique([...left.sources, ...right.sources]),
    locations: uniqueObjects([...left.locations, ...right.locations]),
    evidence: uniqueObjects([...left.evidence, ...right.evidence]),
    taxonomy: {
      cwe: unique([
        ...(left.taxonomy.cwe ?? []),
        ...(right.taxonomy.cwe ?? []),
      ]),
      owasp: unique([
        ...(left.taxonomy.owasp ?? []),
        ...(right.taxonomy.owasp ?? []),
      ]),
      asvs: unique([
        ...(left.taxonomy.asvs ?? []),
        ...(right.taxonomy.asvs ?? []),
      ]),
    },
  };
}

function candidateMergeKey(candidate: SecurityCandidate) {
  const path = candidate.locations[0]?.path ?? "unknown";
  return [
    candidate.vulnerabilityFamily,
    candidate.rootControl,
    candidate.component,
    path,
  ]
    .map(normalizeFingerprintPart)
    .join("|");
}

function findingFingerprint(input: {
  title: string;
  rootCause: string;
  locations: SecuritySourceLocation[];
  attackPath: string[];
}) {
  return createHash("sha256")
    .update(
      [
        input.title,
        input.rootCause,
        ...input.locations.map(({ path, symbol }) => `${path}:${symbol ?? ""}`),
        ...input.attackPath,
      ]
        .map(normalizeFingerprintPart)
        .join("|"),
    )
    .digest("hex");
}

function mergeThreatModels(models: SecurityThreatModel[]): SecurityThreatModel {
  const field = (key: keyof SecurityThreatModel) =>
    unique(models.flatMap((model) => model[key]));
  return {
    assets: field("assets"),
    actors: field("actors"),
    trustBoundaries: field("trustBoundaries"),
    attackerInputs: field("attackerInputs"),
    securityInvariants: field("securityInvariants"),
  };
}

function parseThreatModel(value: unknown): SecurityThreatModel {
  const model = record(value, "Threat model is invalid");
  return {
    assets: strings(model.assets),
    actors: strings(model.actors),
    trustBoundaries: strings(model.trustBoundaries),
    attackerInputs: strings(model.attackerInputs),
    securityInvariants: strings(model.securityInvariants),
  };
}

function parseLocation(value: unknown): SecuritySourceLocation {
  const location = record(value, "Security location is invalid");
  return {
    path: requiredText(location.path, "Security location path"),
    ...(number(location.startLine)
      ? { startLine: number(location.startLine) }
      : {}),
    ...(number(location.endLine) ? { endLine: number(location.endLine) } : {}),
    ...(text(location.symbol) ? { symbol: text(location.symbol) } : {}),
  };
}

function parseEvidence(value: unknown): SecurityEvidence {
  const evidence = record(value, "Security evidence is invalid");
  return {
    summary: requiredText(evidence.summary, "Security evidence summary"),
    ...(evidence.location
      ? { location: parseLocation(evidence.location) }
      : {}),
    ...(text(evidence.code)
      ? { code: text(evidence.code)?.slice(0, 2_000) }
      : {}),
  };
}

function parseTaxonomy(value: unknown) {
  const taxonomy = record(value, "Security taxonomy is invalid");
  return {
    ...(strings(taxonomy.cwe).length ? { cwe: strings(taxonomy.cwe) } : {}),
    ...(strings(taxonomy.owasp).length
      ? { owasp: strings(taxonomy.owasp) }
      : {}),
    ...(strings(taxonomy.asvs).length ? { asvs: strings(taxonomy.asvs) } : {}),
  };
}

function securitySeverity(value: unknown): SecuritySeverity {
  if (["critical", "high", "medium", "low"].includes(String(value)))
    return value as SecuritySeverity;
  throw new Error("Security severity is invalid");
}

function securityConfidence(value: unknown) {
  if (["high", "medium", "low"].includes(String(value)))
    return value as "high" | "medium" | "low";
  throw new Error("Security confidence is invalid");
}

function securityPriority(value: unknown): SecurityPriority {
  if (["p0", "p1", "p2", "p3"].includes(String(value)))
    return value as SecurityPriority;
  throw new Error("Security priority is invalid");
}

function normalizeFingerprintPart(value: string) {
  return value.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(message);
  return value as Record<string, unknown>;
}

function array(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function strings(value: unknown) {
  return unique(
    array(value)
      .map(text)
      .filter((item): item is string => Boolean(item)),
  );
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredText(value: unknown, field: string) {
  const result = text(value);
  if (!result) throw new Error(`${field} is required`);
  return result;
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined;
}

function unique<T>(values: T[]) {
  return [...new Set(values)];
}

function uniqueObjects<T>(values: T[]) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = JSON.stringify(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
