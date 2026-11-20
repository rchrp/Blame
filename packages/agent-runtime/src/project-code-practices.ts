import type {
  ProjectCodePracticeKey,
  ProjectCodePracticeResult,
} from "./types.js";
import type { ProjectCodePracticesScan } from "./project-code-practices-scan.js";

const requiredPractices: ProjectCodePracticeKey[] = [
  "coding_style",
  "unit_tests",
  "layered_architecture",
  "commit_message_convention",
];

const practiceSchema = (detected: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  required: ["detected", "comment"],
  properties: {
    detected,
    comment: { type: "string", minLength: 1 },
  },
});

const practicesSchema = (detected: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  required: requiredPractices,
  properties: Object.fromEntries(
    requiredPractices.map((practice) => [practice, practiceSchema(detected)]),
  ),
});

/**
 * Each practice once, by name, and a starter adopts all four: the engine
 * checks all of it, so an accepted result needs no further correction.
 */
export const projectCodePracticesResultSchema = {
  type: "object",
  additionalProperties: false,
  required: ["projectState", "practices"],
  properties: {
    projectState: {
      enum: ["starter", "established"],
      description:
        "Classify the evidence, not the creation flow: starter means empty or only scaffold/template code with no substantive application behavior; otherwise use established. A starter has detected: true for all four practices.",
    },
    practices: practicesSchema({ type: "boolean" }),
  },
  anyOf: [
    { properties: { projectState: { const: "established" } } },
    {
      properties: {
        projectState: { const: "starter" },
        practices: practicesSchema({ const: true }),
      },
    },
  ],
};

export function projectCodePracticesPrompt(scan: ProjectCodePracticesScan) {
  return [
    "Analyze the code practices from the comprehensive project evidence below, and read the code with read_code or search_code where the evidence leaves a practice uncertain.",
    "First classify the project as starter or established from its contents. For an empty or boilerplate-only starter, adopt all four professional practices with detected: true and explain the defaults in the comments.",
    "Call submit_project_code_practices with the complete result.",
    "Do not answer with JSON text.",
    `Project evidence: ${JSON.stringify(scan)}`,
  ].join("\n");
}

/**
 * The four practices in their order, from the validated result. For an
 * established project the commit convention comes from the commits Blame
 * counted, not from the analyst.
 */
export function resolveProjectCodePracticesResult(
  value: unknown,
  commits: ProjectCodePracticesScan["commits"],
): ProjectCodePracticeResult[] {
  if (!isRecord(value) || !isRecord(value.practices))
    throw new Error("Code practice analysis result is missing practices");
  const practices = value.practices;
  const parsed = requiredPractices.map((practice) =>
    parsePractice(practices[practice], practice),
  );
  if (value.projectState === "starter" || !commits.evaluatedCount)
    return parsed;
  return parsed.map((practice) =>
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

function parsePractice(value: unknown, practice: ProjectCodePracticeKey) {
  if (!isRecord(value))
    throw new Error(`Code practice analysis is missing ${practice}`);
  if (typeof value.detected !== "boolean")
    throw new Error(`${practice} detected must be boolean`);
  const comment = typeof value.comment === "string" ? value.comment.trim() : "";
  if (!comment) throw new Error(`${practice} comment is required`);
  return { practice, detected: value.detected, comment };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
