import type {
  RepairProjectInitializationResult,
  RepairProjectInitializationTask,
} from "./engine/task-protocol.js";
import {
  parseProjectInitializationPayload,
  projectInitializationResultSchema,
  type ProjectInitializationScan,
} from "./project-initialization.js";
import type {
  ProjectInitializationPreferences,
  ProjectInitializationRepairClassification,
} from "./types.js";

const classifications = new Set<ProjectInitializationRepairClassification>([
  "repairable_initialization",
  "project_code_failure",
  "external_failure",
  "unknown",
]);

export type ProjectInitializationRepair = Omit<
  RepairProjectInitializationResult,
  "session"
>;

const repairableResultSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "classification",
    "reason",
    "previewManifest",
    "runConfigurations",
  ],
  properties: {
    classification: { const: "repairable_initialization" },
    reason: { type: "string", minLength: 1 },
    previewManifest:
      projectInitializationResultSchema.properties.previewManifest,
    runConfigurations:
      projectInitializationResultSchema.properties.runConfigurations,
  },
} as const;

const diagnosticResultSchema = {
  type: "object",
  additionalProperties: false,
  required: ["classification", "reason"],
  properties: {
    classification: {
      enum: ["project_code_failure", "external_failure", "unknown"],
    },
    reason: { type: "string", minLength: 1 },
  },
} as const;

export const projectInitializationRepairResultSchema = {
  oneOf: [repairableResultSchema, diagnosticResultSchema],
} as const;

export function projectInitializationRepairPrompt(
  input: Pick<
    RepairProjectInitializationTask,
    "preferences" | "previewManifest" | "runConfigurations" | "diagnostics"
  >,
  scan: ProjectInitializationScan,
) {
  return [
    "Diagnose these project initialization diagnostics according to your system instructions.",
    "Call submit_project_initialization_repair with the complete result.",
    "Do not answer with JSON text.",
    `Database preference: ${JSON.stringify(input.preferences ?? null)}`,
    `Current previewManifest: ${JSON.stringify(input.previewManifest)}`,
    `Current runConfigurations: ${JSON.stringify(input.runConfigurations)}`,
    `Initialization diagnostics: ${JSON.stringify(input.diagnostics)}`,
    `Project root entries: ${JSON.stringify(scan.topLevelEntries)}`,
    `Project discovery: ${JSON.stringify(scan.discovery ?? null)}`,
    `Preview images: ${JSON.stringify(scan.previewImages ?? null)}`,
    `Project evidence files: ${JSON.stringify(scan.files)}`,
  ].join("\n");
}

export function parseProjectInitializationRepairPayload(
  parsed: unknown,
  scan?: ProjectInitializationScan,
  preferences?: ProjectInitializationPreferences,
): ProjectInitializationRepair {
  if (!isRecord(parsed))
    throw new Error("Initialization repair result must be an object");
  const classification = classificationValue(parsed.classification);
  assertOnlyKeys(
    parsed,
    classification === "repairable_initialization"
      ? ["classification", "reason", "previewManifest", "runConfigurations"]
      : ["classification", "reason"],
  );
  const reason = stringValue(parsed.reason);
  if (!reason)
    throw new Error("Initialization repair result is missing reason");
  if (classification !== "repairable_initialization")
    return { classification, reason };
  if (!parsed.previewManifest) {
    throw new Error(
      "Repairable initialization result must include a canonical previewManifest",
    );
  }
  const initialization = parseProjectInitializationPayload(
    {
      previewManifest: parsed.previewManifest,
      runConfigurations: parsed.runConfigurations,
    },
    scan,
    preferences,
    // A repair answers an observed failure: heuristic warnings never block it.
    { acceptWarnings: true },
  );
  return {
    classification,
    reason,
    ...initialization,
  };
}

function classificationValue(value: unknown) {
  if (
    typeof value !== "string" ||
    !classifications.has(value as ProjectInitializationRepairClassification)
  ) {
    throw new Error(
      "Initialization repair result has an invalid classification",
    );
  }
  return value as ProjectInitializationRepairClassification;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: string[]) {
  const keys = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !keys.has(key));
  if (unknown) {
    throw new Error(
      `Initialization repair result contains unsupported field ${unknown}`,
    );
  }
}
