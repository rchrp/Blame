import {
  parseProjectInitializationPayload,
  projectInitializationResultSchema,
  type ProjectInitializationScan,
} from "./project-initialization.js";
import type {
  ProjectInitializationPreferences,
  ProjectInitializationRepairClassification,
  RepairProjectInitializationInput,
  RepairProjectInitializationResult,
} from "./types.js";

const classifications = new Set<ProjectInitializationRepairClassification>([
  "repairable_initialization",
  "project_code_failure",
  "external_failure",
  "unknown",
]);
const maxCorrectionPayloadLength = 24_000;

type ProjectInitializationRepairCorrection = {
  validationError: string;
  previousResult: string;
};

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
  input: RepairProjectInitializationInput,
  scan: ProjectInitializationScan,
  correction?: ProjectInitializationRepairCorrection,
) {
  const prompt = repairPrompt(input, scan);
  if (!correction) return prompt;
  return [
    prompt,
    "Your previous tool input was rejected by validation.",
    "Fix only the submitted result according to the validation error.",
    "Do not broaden the diagnosis and do not read more files.",
    "Call submit_project_initialization_repair again with a complete corrected input.",
    `Validation error: ${correction.validationError}`,
    `Previous rejected input: ${correction.previousResult.slice(0, maxCorrectionPayloadLength)}`,
  ].join("\n");
}

export function parseProjectInitializationRepairResult(
  text: string,
  scan?: ProjectInitializationScan,
  preferences?: ProjectInitializationPreferences,
): Omit<RepairProjectInitializationResult, "sessionId"> {
  const parsed = JSON.parse(jsonPayload(text)) as unknown;
  return parseProjectInitializationRepairPayload(parsed, scan, preferences);
}

export function parseProjectInitializationRepairPayload(
  parsed: unknown,
  scan?: ProjectInitializationScan,
  preferences?: ProjectInitializationPreferences,
): Omit<RepairProjectInitializationResult, "sessionId"> {
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

function repairPrompt(
  input: RepairProjectInitializationInput,
  scan: ProjectInitializationScan,
) {
  return [
    "Diagnose these project initialization diagnostics according to your system instructions.",
    "Call submit_project_initialization_repair exactly once with the complete result.",
    "Do not answer with JSON text.",
    `Database preference: ${JSON.stringify(input.preferences ?? null)}`,
    `Current previewManifest: ${JSON.stringify(input.previewManifest)}`,
    `Current runConfigurations: ${JSON.stringify(input.runConfigurations)}`,
    `Initialization diagnostics: ${JSON.stringify(input.diagnostics)}`,
    `Project root entries: ${JSON.stringify(scan.topLevelEntries)}`,
    `Project discovery: ${JSON.stringify(scan.discovery ?? null)}`,
    `Project evidence files: ${JSON.stringify(scan.files)}`,
  ].join("\n");
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

function jsonPayload(text: string) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return trimmed;
  const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match?.[1]) return match[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
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
