import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  mergeSecurityCandidates,
  parseSecurityDiscovery,
  parseSecurityValidation,
} from "./security-audit.js";
import { runSecurityScanners } from "./security-audit-scanners.js";
import { scanSecurityAuditRepository } from "./security-audit-scan.js";
import { redactSecuritySecrets } from "./security-secret-redaction.js";
import type { MapSecurityAuditResult } from "./types.js";

const execFileAsync = promisify(execFile);

const repository: MapSecurityAuditResult = {
  revision: { snapshotDigest: "digest", dirty: false },
  deterministic: {
    candidates: [],
    inspectedPaths: [],
    limitations: [],
    scanners: [],
  },
  surfaceMap: {
    rootName: "fixture",
    fileCount: 20,
    relevantFileCount: 10,
    ignoredDirectoryCount: 2,
    truncated: false,
    languages: ["TypeScript"],
    frameworks: ["Express"],
    projectRoots: [{ path: ".", markers: ["package.json"] }],
    services: ["."],
    entrypoints: ["src/server.ts"],
    sensitivePaths: ["src/projects.ts"],
    dependencyPaths: ["package.json"],
    infrastructurePaths: [],
    ciPaths: [],
    evidencePaths: ["src/server.ts", "src/projects.ts"],
  },
};

test("merges equivalent candidates from independent discovery passes", () => {
  const first = discovery("pass-a", "a", 42);
  const second = discovery("pass-b", "b", 84);

  const merged = mergeSecurityCandidates([first, second]);

  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].sources, ["ai:pass-a", "ai:pass-b"]);
  assert.equal(merged[0].locations.length, 2);
});

test("builds stable validated findings and honest coverage", () => {
  const discovered = discovery("baseline", "a", 42);
  const input = validation(42);
  const result = parseSecurityValidation(input, repository, [discovered]);
  const moved = parseSecurityValidation(validation(140), repository, [
    discovered,
  ]);

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].fingerprint, moved.findings[0].fingerprint);
  assert.equal(result.findings[0].severity, "critical");
  assert.equal(result.candidateCount, 1);
  assert.equal(result.rejectedCandidateCount, 0);
  assert.equal(result.coverage.percentage, 20);
  assert.equal(
    result.coverage.areas.find(({ area }) => area === "runtime")?.status,
    "not_scanned",
  );
});

test("detects secrets locally without returning their value", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-security-scanner-"));
  const secret = `sk-proj-${"a".repeat(28)}`;
  try {
    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "src", "config.ts"),
      `export const apiKey = "${secret}";\n`,
    );
    const result = await runSecurityScanners({
      files: ["src/config.ts"],
      repositoryTruncated: false,
      workspaceRoot: root,
    });

    assert.equal(result.candidates.length, 1);
    assert.match(JSON.stringify(result), /REDACTED_SECRET/);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
    assert.equal(result.scanners[0]?.status, "limited");
    assert.doesNotMatch(redactSecuritySecrets(secret), new RegExp(secret));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps low-confidence candidates out of the reportable findings", () => {
  const candidate = discovery("baseline", "a", 42);
  const lowConfidence = validation(42);
  lowConfidence.findings[0]!.confidence = "low";

  const result = parseSecurityValidation(lowConfidence, repository, [
    candidate,
  ]);

  assert.equal(result.findings.length, 0);
  assert.equal(result.rejectedCandidateCount, 1);
});

test("repository revisions exclude Blame's own audit artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-security-revision-"));
  const git = async (cwd: string, args: string[]) =>
    (
      await execFileAsync("git", args, {
        cwd,
        encoding: "utf8",
      })
    ).stdout;
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "index.ts"), "export const ok = true;\n");
    await git(root, ["init"]);
    await git(root, ["config", "user.email", "security@example.test"]);
    await git(root, ["config", "user.name", "Security Test"]);
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "initial"]);
    const before = await scanSecurityAuditRepository(root, git);
    await mkdir(join(root, ".blame", "security", "audits", "audit-123"), {
      recursive: true,
    });
    await writeFile(
      join(root, ".blame", "security", "audits", "audit-123", "manifest.json"),
      "{}\n",
    );
    const after = await scanSecurityAuditRepository(root, git);

    assert.equal(after.revision.dirty, false);
    assert.equal(after.revision.snapshotDigest, before.revision.snapshotDigest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function discovery(source: string, id: string, line: number) {
  return parseSecurityDiscovery(
    {
      threatModel: {
        assets: ["Tenant projects"],
        actors: ["Authenticated user"],
        trustBoundaries: ["HTTP API to database"],
        attackerInputs: ["project id"],
        securityInvariants: ["Users can delete only their tenant projects"],
      },
      candidates: [
        {
          id,
          title: "Missing project deletion authorization",
          summary:
            "The delete handler loads a project by id without tenant scope.",
          vulnerabilityFamily: "broken access control",
          rootControl: "tenant ownership check",
          component: "project deletion",
          attacker: "Authenticated user",
          asset: "Tenant projects",
          locations: [{ path: "src/projects.ts", startLine: line }],
          evidence: [
            {
              summary: "Deletion uses an attacker-selected id.",
              location: { path: "src/projects.ts", startLine: line },
            },
          ],
          taxonomy: { cwe: ["CWE-862"], owasp: ["A01:2025"] },
        },
      ],
      inspectedPaths: ["src/server.ts"],
      limitations: [],
    },
    source,
  );
}

function validation(line: number) {
  return {
    findings: [
      {
        candidateIds: ["candidate-1"],
        title: "Missing project deletion authorization",
        severity: "critical",
        confidence: "high",
        priority: "p0",
        taxonomy: { cwe: ["CWE-862"], owasp: ["A01:2025"] },
        attacker: "Authenticated user",
        asset: "Tenant projects",
        rootCause: {
          summary: "Project deletion does not enforce tenant ownership.",
          location: { path: "src/projects.ts", startLine: line },
        },
        attackPath: [
          { label: "Authenticated user" },
          { label: "DELETE /projects/:id" },
          { label: "Unscoped project delete" },
        ],
        impact: "Cross-tenant project deletion.",
        evidence: [
          {
            summary: "No ownership check exists before deletion.",
            location: { path: "src/projects.ts", startLine: line },
          },
        ],
        affectedLocations: [{ path: "src/projects.ts", startLine: line }],
        remediation: {
          summary: "Scope deletion to the authenticated tenant.",
          guidance: ["Centralize the ownership check."],
        },
        rationale: "The route is reachable and no upstream control applies.",
        counterEvidence: [
          "Authentication middleware does not enforce ownership.",
        ],
      },
    ],
    rejected: [],
    inspectedPaths: ["src/projects.ts"],
    limitations: [],
  };
}
