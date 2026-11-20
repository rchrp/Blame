// The security audit's agent steps: read-only tasks that must read code
// before their result, with schemas the engine can check.

import assert from "node:assert/strict";
import test from "node:test";
import type { SecurityAuditDiscoveryResult } from "../../types.js";
import { VM_WORKSPACE_UNSUPPORTED } from "../tasks/runner.js";
import { securityDiscoveryTask } from "./security-discovery.js";
import { securityValidationTask } from "./security-validation.js";

const model = { providerId: "anthropic", modelId: "claude-sonnet-4-6" };
const workspace = { root: "/projects/app" };
const repository = {
  revision: { snapshotDigest: "digest", dirty: false },
  deterministic: {
    candidates: [],
    inspectedPaths: [],
    limitations: [],
    scanners: [],
  },
  surfaceMap: {
    rootName: "app",
    fileCount: 4,
    relevantFileCount: 2,
    ignoredDirectoryCount: 0,
    truncated: false,
    languages: ["TypeScript"],
    frameworks: [],
    projectRoots: [],
    services: [],
    entrypoints: ["src/server.ts"],
    sensitivePaths: [],
    dependencyPaths: [],
    infrastructurePaths: [],
    ciPaths: [],
    evidencePaths: [],
  },
};

// The keywords `blame-engine-core/src/contract/schema.rs` checks or ignores.
const supported = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "uniqueItems",
  "enum",
  "const",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  "description",
  "title",
  "default",
  "examples",
  "format",
]);

function unsupported(schema: unknown, path = "$"): string[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
  return Object.entries(schema).flatMap(([key, value]) => {
    if (key === "properties")
      return Object.entries(value as object).flatMap(([name, property]) =>
        unsupported(property, `${path}.${name}`),
      );
    if (!supported.has(key)) return [`${path}: ${key}`];
    if (key === "items" || key === "additionalProperties" || key === "not")
      return unsupported(value, `${path}[]`);
    if (Array.isArray(value) && key !== "enum" && key !== "required")
      return value.flatMap((item) => unsupported(item, path));
    return [];
  });
}

function candidate(id: string, path: string) {
  return {
    id,
    sourceCandidateIds: [id],
    sources: ["ai:baseline"],
    title: "Unscoped project deletion",
    summary: "Deletes a project by id without checking its tenant.",
    vulnerabilityFamily: "broken access control",
    rootControl: "tenant ownership",
    component: "projects",
    attacker: "Authenticated user",
    locations: [{ path }],
    evidence: [],
    taxonomy: {},
  };
}

const discovery: SecurityAuditDiscoveryResult = {
  threatModel: {
    assets: ["Projects"],
    actors: [],
    trustBoundaries: [],
    attackerInputs: [],
    securityInvariants: [],
  },
  candidates: [
    candidate("a", "src/projects.ts"),
    candidate("b", "src/admin.ts"),
  ],
  inspectedPaths: ["src/projects.ts"],
  limitations: [],
};

test("an investigator reads the project with the harness, and only reads", () => {
  const task = securityDiscoveryTask({
    model,
    workspace,
    mode: "standard",
    perspective: "forward_data_flow",
    repository,
  });
  const { config } = task;
  assert.equal(config.purpose, "security-discovery");
  assert.deepEqual(config.kind, { kind: "task", replicate: false });
  assert.equal(config.workspace_root, "/projects/app");
  assert.deepEqual(config.engine_tools, ["harness"]);
  assert.deepEqual(config.contract?.required, ["read_code"]);
  assert.deepEqual(config.contract?.allowed, ["search_code", "read_code"]);
  assert.equal(config.contract?.result.name, "submit_security_discovery");
  assert.equal(config.limits.max_requests_per_turn, 28);
  assert.ok(config.limits.max_turn_ms);
  assert.match(task.instruction, /forward data flow security discovery/);
  assert.match(task.instruction, /"entrypoints":\["src\/server.ts"\]/);
  assert.doesNotMatch(task.instruction, /deterministic/);
  assert.match(config.system_prompt, /submit_security_discovery/);
  const result = config.contract!.result;
  assert.equal(result.source, "submit");
  if (result.source === "submit")
    assert.deepEqual(unsupported(result.input_schema), []);
  const deep = securityDiscoveryTask({
    model,
    workspace,
    mode: "deep",
    perspective: "business_logic",
    repository,
  });
  assert.equal(deep.config.limits.max_requests_per_turn, 40);
});

test("an investigator's result becomes its candidates, named after its perspective", () => {
  const task = securityDiscoveryTask({
    model,
    workspace,
    mode: "standard",
    perspective: "baseline",
    repository,
  });
  const result = task.result({
    threatModel: discovery.threatModel,
    candidates: [{ ...candidate("", "src/projects.ts"), id: "" }],
    inspectedPaths: ["src/projects.ts", "src/projects.ts"],
    limitations: [],
  });
  assert.equal(result.candidates[0]?.id, "baseline-1");
  assert.deepEqual(result.candidates[0]?.sources, ["ai:baseline"]);
  assert.deepEqual(result.inspectedPaths, ["src/projects.ts"]);
  assert.throws(
    () =>
      task.result({
        ...result,
        candidates: [{ ...candidate("x", "a.ts"), title: "  " }],
      }),
    /Candidate title is required/,
  );
});

test("the validator may name only the candidates it was given", () => {
  const task = securityValidationTask({
    model,
    workspace,
    mode: "deep",
    repository,
    discoveries: [discovery],
  });
  const { config } = task;
  assert.equal(config.purpose, "security-validation");
  assert.deepEqual(config.contract?.required, ["read_code"]);
  assert.deepEqual(config.contract?.allowed, ["search_code", "read_code"]);
  assert.equal(config.limits.max_requests_per_turn, 48);
  const result = config.contract!.result;
  assert.equal(result.source, "submit");
  if (result.source !== "submit") return;
  assert.deepEqual(unsupported(result.input_schema), []);
  const findings = (result.input_schema as Record<string, any>).properties
    .findings.items.properties;
  assert.deepEqual(findings.candidateIds.items.enum, [
    "candidate-1",
    "candidate-2",
  ]);
  assert.match(task.instruction, /"id":"candidate-2"/);

  const validated = task.result({
    findings: [],
    rejected: [{ candidateIds: ["candidate-1"], reason: "Guarded." }],
    inspectedPaths: ["src/admin.ts"],
    limitations: [],
  });
  assert.equal(validated.candidateCount, 2);
  assert.equal(validated.rejectedCandidateCount, 2);
  assert.deepEqual(validated.coverage.inspectedPaths, [
    "src/admin.ts",
    "src/projects.ts",
  ]);

  const empty = securityValidationTask({
    model,
    workspace,
    mode: "standard",
    repository,
    discoveries: [],
  }).config.contract!.result;
  if (empty.source === "submit")
    assert.equal(
      (empty.input_schema as Record<string, any>).properties.findings.items
        .properties.candidateIds.items.enum,
      undefined,
      "no candidate: no empty enum",
    );
});

test("an audit of a project in the runtime VM is not run on this machine", () => {
  assert.throws(
    () =>
      securityDiscoveryTask({
        model,
        workspace: { root: "/home/blame/app", inVm: true },
        mode: "standard",
        perspective: "baseline",
        repository,
      }),
    (error: unknown) =>
      error instanceof Error && error.message === VM_WORKSPACE_UNSUPPORTED,
  );
  assert.throws(
    () =>
      securityValidationTask({
        model,
        workspace: { root: "/home/blame/app", inVm: true },
        mode: "standard",
        repository,
        discoveries: [discovery],
      }),
    (error: unknown) =>
      error instanceof Error && error.message === VM_WORKSPACE_UNSUPPORTED,
  );
});
