import assert from "node:assert/strict";
import test from "node:test";

import {
  parseProjectInitializationRepairPayload,
  parseProjectInitializationRepairResult,
  projectInitializationRepairResultSchema,
  projectInitializationRepairPrompt,
} from "./project-initialization-repair.js";
import { parsePreviewManifest } from "./preview-manifest.js";
import type { RepairProjectInitializationInput } from "./types.js";

function canonicalRepair() {
  return {
    classification: "repairable_initialization",
    reason: "The preview command changed.",
    previewManifest: {
      confidence: "high",
      project: { root: ".", detectedStack: ["node"], confidence: "high" },
      setup: [
        {
          id: "deps",
          container: { image: "node:22-bookworm" },
          workingDir: "/workspace",
          command:
            "corepack prepare pnpm@10.33.2 --activate && corepack pnpm install",
        },
      ],
      services: [
        {
          id: "web",
          kind: "preview",
          container: { image: "node:22-bookworm" },
          workingDir: "/workspace",
          command:
            "corepack prepare pnpm@10.33.2 --activate && corepack pnpm dev",
          endpoints: [
            {
              id: "http",
              protocol: "http",
              port: 3000,
              healthcheck: { type: "http", path: "/", timeoutMs: 30_000 },
            },
          ],
        },
      ],
      caches: [],
      risks: [],
      probes: [],
    },
    runConfigurations: [
      {
        id: "web",
        name: "Web application",
        command: "npm run dev",
        cwd: ".",
        default: true,
        category: "web",
        services: ["web"],
        previewService: "web",
        scopes: ["web"],
      },
    ],
  };
}

test("returns only canonical repaired initialization state", () => {
  const result = parseProjectInitializationRepairResult(
    JSON.stringify(canonicalRepair()),
  );

  assert.equal(result.classification, "repairable_initialization");
  assert.equal(result.previewManifest?.services[0]?.kind, "preview");
  assert.equal(result.runConfigurations?.[0]?.previewService, "web");
  assert.deepEqual(Object.keys(result).sort(), [
    "classification",
    "previewManifest",
    "reason",
    "runConfigurations",
  ]);
});

test("rejects removed initialization artifact fields", () => {
  const repair = canonicalRepair();
  assert.throws(
    () =>
      parseProjectInitializationRepairResult(
        JSON.stringify({
          ...repair,
          setupScript: "npm install",
          dockerCompose: "services: {}",
        }),
      ),
    /unsupported field setupScript/,
  );
});

test("rejects fields outside the manifest contract and unknown services", () => {
  const unknownField = canonicalRepair();
  assert.throws(
    () =>
      parseProjectInitializationRepairResult(
        JSON.stringify({
          ...unknownField,
          previewManifest: { ...unknownField.previewManifest, version: 2 },
        }),
      ),
    /unsupported field version/,
  );

  const invalid = canonicalRepair();
  invalid.runConfigurations[0]!.services = ["missing"];
  invalid.runConfigurations[0]!.previewService = "missing";
  assert.throws(
    () => parseProjectInitializationRepairResult(JSON.stringify(invalid)),
    /previewService must be a configured service|references unknown service missing/,
  );
});

test("omits artifacts for non-initialization failures", () => {
  const result = parseProjectInitializationRepairResult(
    JSON.stringify({
      classification: "project_code_failure",
      reason: "The application fails during startup.",
    }),
  );
  assert.deepEqual(result, {
    classification: "project_code_failure",
    reason: "The application fails during startup.",
  });
});

test("requires complete run configurations for a repair", () => {
  const value = canonicalRepair() as Record<string, unknown>;
  delete value.runConfigurations;
  assert.throws(
    () => parseProjectInitializationRepairResult(JSON.stringify(value)),
    /missing runConfigurations/,
  );
});

test("includes validation feedback in repair correction prompts", () => {
  const input: RepairProjectInitializationInput = {
    apiConnection: { url: "https://example.com", token: "token" },
    providerId: "provider",
    modelId: "model",
    cwd: "/project",
    workspaceRoot: "/project",
    previewManifest: parsePreviewManifest(canonicalRepair().previewManifest),
    runConfigurations: [],
    diagnostics: {
      setupLog: "",
      launchError: "Preview failed",
      composeConfig: "",
      composePs: "",
      serviceLogs: {},
    },
  };
  const prompt = projectInitializationRepairPrompt(
    input,
    { rootName: "project", topLevelEntries: [], files: {}, gitLog: [] },
    {
      validationError: "Manifest is invalid.",
      previousResult: '{"classification":"repairable_initialization"}',
    },
  );

  assert.match(prompt, /Your previous tool input was rejected by validation/);
  assert.match(prompt, /Validation error: Manifest is invalid\./);
  assert.match(prompt, /submit_project_initialization_repair/);
});

test("exposes a structured repair submission schema", () => {
  assert.equal(projectInitializationRepairResultSchema.oneOf.length, 2);
  assert.deepEqual(projectInitializationRepairResultSchema.oneOf[0].required, [
    "classification",
    "reason",
    "previewManifest",
    "runConfigurations",
  ]);
});

test("normalizes isolated database credentials in repair payloads", () => {
  const repair = canonicalRepair();
  const service = repair.previewManifest.services[0]! as Record<
    string,
    unknown
  >;
  service.environment = {
    DATABASE_URL: "postgresql://app:secret@database:5432/app",
  };
  const result = parseProjectInitializationRepairPayload(repair, undefined, {
    database: { mode: "compose" },
  });

  assert.equal(
    result.previewManifest?.services[0]?.environment?.DATABASE_URL,
    "postgresql://app:blame@database:5432/app",
  );
});

test("normalizes an unambiguous service role used as a probe consumer", () => {
  const repair = canonicalRepair();
  const manifest = repair.previewManifest as unknown as {
    probes: Array<Record<string, unknown>>;
  };
  manifest.probes.push({
    id: "web-ready",
    from: "preview",
    target: { service: "web", endpoint: "http" },
    type: "http",
  });

  const result = parseProjectInitializationRepairPayload(repair);

  assert.equal(result.previewManifest?.probes[0]?.from, "web");
});

test("rejects an ambiguous service role used as a probe consumer", () => {
  const repair = canonicalRepair();
  const manifest = repair.previewManifest as unknown as {
    probes: Array<Record<string, unknown>>;
    services: Array<Record<string, unknown>>;
  };
  manifest.services.push({
    ...manifest.services[0],
    id: "admin",
  });
  manifest.probes.push({
    id: "web-ready",
    from: "preview",
    target: { service: "web", endpoint: "http" },
    type: "http",
  });

  assert.throws(
    () => parseProjectInitializationRepairPayload(repair),
    /probe references unknown consumer preview/,
  );
});

test("moves root bindings to the only application service", () => {
  const repair = canonicalRepair();
  const manifest = repair.previewManifest as unknown as Record<string, unknown>;
  const services = manifest.services as Array<Record<string, unknown>>;
  services.push({
    id: "database",
    kind: "dependency",
    container: { image: "postgres:17" },
    environment: { POSTGRES_PASSWORD: "blame" },
    endpoints: [{ id: "postgres", protocol: "tcp", port: 5432 }],
  });
  manifest.bindings = [
    {
      target: { type: "environment", key: "DATABASE_HOST" },
      source: { service: "database", endpoint: "postgres" },
      exposure: "server",
      format: "host",
    },
  ];

  const result = parseProjectInitializationRepairPayload(repair);

  assert.equal(
    result.previewManifest?.services[0]?.bindings?.[0]?.source.service,
    "database",
  );
});

test("rejects root bindings when the consuming service is ambiguous", () => {
  const repair = canonicalRepair();
  const manifest = repair.previewManifest as unknown as Record<string, unknown>;
  const services = manifest.services as Array<Record<string, unknown>>;
  services.push({ ...services[0], id: "admin" });
  manifest.bindings = [];

  assert.throws(
    () => parseProjectInitializationRepairPayload(repair),
    /previewManifest contains unsupported field bindings/,
  );
});
