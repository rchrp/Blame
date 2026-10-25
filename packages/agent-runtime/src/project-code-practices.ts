import type {
  ProjectCodePracticeKey,
  ProjectCodePracticeResult,
} from "./types.js";
import type { ProjectCodePracticesScan } from "./project-code-practices-scan.js";
import { jsonPayload } from "./json-payload.js";

const requiredPractices: ProjectCodePracticeKey[] = [
  "coding_style",
  "unit_tests",
  "layered_architecture",
  "commit_message_convention",
];

type CodePracticesCorrection = {
  validationError: string;
  previousResult: string;
};

export const projectCodePracticesResultSchema = {
  type: "object",
  additionalProperties: false,
  required: ["projectState", "practices"],
  properties: {
    projectState: {
      enum: ["starter", "established"],
      description:
        "Classify the evidence, not the creation flow: starter means empty or only scaffold/template code with no substantive application behavior; otherwise use established.",
    },
    practices: {
      type: "array",
      minItems: 4,
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["practice", "detected", "comment"],
        properties: {
          practice: { enum: requiredPractices },
          detected: { type: "boolean" },
          comment: { type: "string" },
        },
      },
    },
  },
} as const;

export function projectCodePracticesPrompt(scan: ProjectCodePracticesScan) {
  return [
    "Analyze the code practices from the comprehensive project evidence below.",
    "First classify the project as starter or established from its contents. For an empty or boilerplate-only starter, adopt all four professional practices with detected: true and explain the defaults in the comments.",
    "Call submit_project_code_practices exactly once with the complete result.",
    "Do not answer with JSON text.",
    `Project evidence: ${JSON.stringify(scan)}`,
  ].join("\n");
}

export function projectCodePracticesCorrectionPrompt(
  scan: ProjectCodePracticesScan,
  correction: CodePracticesCorrection,
) {
  return [
    projectCodePracticesPrompt(scan),
    "Your previous tool input was rejected by validation.",
    "Call submit_project_code_practices again with a complete corrected input.",
    `Validation error: ${correction.validationError}`,
    `Previous rejected input: ${correction.previousResult.slice(0, 24_000)}`,
  ].join("\n");
}

export function parseProjectCodePracticesResult(
  value: unknown,
): ProjectCodePracticeResult[] {
  const parsed = typeof value === "string" ? parseText(value) : value;
  if (!isRecord(parsed) || !Array.isArray(parsed.practices)) {
    throw new Error("Code practice analysis result is missing practices");
  }
  if (
    parsed.projectState !== "starter" &&
    parsed.projectState !== "established"
  ) {
    throw new Error(
      "Code practice analysis projectState must be starter or established",
    );
  }
  const practices = parsed.practices;
  if (practices.length !== requiredPractices.length) {
    throw new Error(
      "Code practice analysis must contain exactly four practices",
    );
  }
  return requiredPractices.map((practice) =>
    parsePractice(practices, practice),
  );
}

export function resolveProjectCodePracticesResult(
  value: unknown,
  commits: ProjectCodePracticesScan["commits"],
) {
  const parsed = typeof value === "string" ? parseText(value) : value;
  const practices = parseProjectCodePracticesResult(parsed);
  if (isRecord(parsed) && parsed.projectState === "starter") {
    if (practices.some(({ detected }) => !detected)) {
      throw new Error(
        "For a starter project, return detected: true for all four practices and explain that they are professional defaults for future work.",
      );
    }
    // Scaffold commits do not establish a convention; retain the analyst's defaults.
    return practices;
  }
  if (!commits.evaluatedCount) return practices;
  return practices.map((practice) =>
    practice.practice === "commit_message_convention"
      ? commitMessageConventionResult(commits)
      : practice,
  );
}

function commitMessageConventionResult(
  commits: ProjectCodePracticesScan["commits"],
): ProjectCodePracticeResult {
  const detected = commits.conventionalCount > commits.evaluatedCount / 2;
  const conclusion = detected
    ? "the majority follows the convention"
    : "the majority does not follow the convention";
  return {
    practice: "commit_message_convention",
    detected,
    comment: `${commits.conventionalCount} of ${commits.evaluatedCount} evaluated commits use Conventional Commits, so ${conclusion}.`,
  };
}

function parseText(value: string) {
  return JSON.parse(jsonPayload(value)) as unknown;
}

function parsePractice(values: unknown[], practice: ProjectCodePracticeKey) {
  const value = values.find(
    (item) => isRecord(item) && item.practice === practice,
  );
  if (!isRecord(value))
    throw new Error(`Code practice analysis is missing ${practice}`);
  if (typeof value.detected !== "boolean") {
    throw new Error(`${practice} detected must be boolean`);
  }
  const comment = stringValue(value.comment);
  if (!comment) throw new Error(`${practice} comment is required`);
  return { practice, detected: value.detected, comment };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
