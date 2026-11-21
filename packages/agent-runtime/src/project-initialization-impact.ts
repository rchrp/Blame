import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
  AssessInitializationImpactTask,
  AssessProjectInitializationImpactResult,
} from "./engine/task-protocol.js";
import type {
  ProjectInitializationImpactClassification,
  ProjectInitializationImpactDiagnostics,
} from "./types.js";

/** The commits to compare, in the repository at `cwd`. */
export type AssessProjectInitializationImpactInput = Pick<
  AssessInitializationImpactTask,
  "baseCommit" | "mergeCommit" | "previewManifest" | "runConfigurations"
> & { cwd: string };

export type ProjectInitializationImpact = Omit<
  AssessProjectInitializationImpactResult,
  "session" | "diagnostics"
>;

const execFileAsync = promisify(execFile);
const maxDiffLength = 18_000;
const maxSummaryLength = 12_000;
const maxFileLength = 12_000;

const classifications = new Set<ProjectInitializationImpactClassification>([
  "initialization_update_required",
  "initialization_still_valid",
  "project_code_failure",
  "unknown",
]);

const strategicFilePatterns = [
  /(^|\/)package\.json$/,
  /^pnpm-workspace\.yaml$/,
  /(^|\/)(yarn\.lock|pnpm-lock\.yaml|package-lock\.json|bun\.lockb)$/,
  /(^|\/)(docker-compose|compose).*\.ya?ml$/,
  /(^|\/)Dockerfile[^/]*$/,
  /(^|\/)\.env\.(example|sample|template)$/,
  /(^|\/)(next|nuxt|vite|astro|svelte|remix)\.config\.[cm]?[jt]s$/,
  /(^|\/)(pyproject\.toml|requirements\.txt|go\.mod|Cargo\.toml)$/,
  /(^|\/)(drizzle\.config\.[cm]?[jt]s|alembic\.ini)$/,
  /(^|\/)prisma\/schema\.prisma$/,
  /^(apps|packages|services)\/[^/]+\/package\.json$/,
  /^(apps|packages|services)\/[^/]+\/(src\/)?(server|main|index)\.[cm]?[jt]sx?$/,
];

const structurePatterns = [
  /^(apps|packages|services)\/[^/]+\/?$/,
  /^(apps|packages|services)\/[^/]+\/package\.json$/,
  /^(apps|packages|services)\/[^/]+\/(Dockerfile|docker-compose|compose)/,
];

export async function collectProjectInitializationImpactDiagnostics(
  input: AssessProjectInitializationImpactInput,
): Promise<ProjectInitializationImpactDiagnostics> {
  const changedFiles = await changedFileNames(input);
  const relevantFiles = changedFiles.filter(relevantProjectFile);
  return {
    baseCommit: input.baseCommit,
    mergeCommit: input.mergeCommit,
    changedFiles,
    diffSummary: await diffSummary(input),
    relevantDiffs: await relevantDiffs(input, relevantFiles),
    currentPreviewManifest: input.previewManifest,
    currentRunConfigurations: input.runConfigurations,
    strategicFilesBefore: await strategicFiles(
      input,
      input.baseCommit,
      relevantFiles,
    ),
    strategicFilesAfter: await strategicFiles(
      input,
      input.mergeCommit,
      relevantFiles,
    ),
  };
}

const maxListedChangedFiles = 300;

/**
 * The diagnostics as an agent reads them: what it can use, once. A merge
 * of 2,188 files listed every name (125k characters) and each strategic
 * file twice beside its diff; the impact and repair briefs reached 413k and
 * 562k characters. The names list keeps the runtime files and the first
 * others; a file's content before the merge is kept only where its diff is
 * missing or was cut (the full diff and the content after give it).
 */
export function diagnosticsBrief(
  diagnostics: ProjectInitializationImpactDiagnostics,
) {
  const { changedFiles, relevantDiffs, strategicFilesBefore } = diagnostics;
  const relevant = changedFiles.filter((path) => path in relevantDiffs);
  const others = changedFiles.filter((path) => !(path in relevantDiffs));
  const listed =
    changedFiles.length > maxListedChangedFiles
      ? [...relevant, ...others.slice(0, Math.max(0, maxListedChangedFiles - relevant.length))]
      : changedFiles;
  const before = Object.fromEntries(
    Object.entries(strategicFilesBefore).filter(
      ([path]) => !((relevantDiffs[path]?.length ?? maxDiffLength) < maxDiffLength),
    ),
  );
  return {
    ...diagnostics,
    changedFiles: listed,
    ...(listed.length < changedFiles.length
      ? { changedFilesNotListed: changedFiles.length - listed.length }
      : {}),
    strategicFilesBefore: before,
  };
}

export function projectInitializationImpactPrompt(
  full: ProjectInitializationImpactDiagnostics,
) {
  const diagnostics = diagnosticsBrief(full);
  return [
    "Assess whether the changes between these commits make the persisted project initialization obsolete.",
    "Call submit_initialization_impact with the result. Do not answer with JSON text.",
    `Base commit: ${diagnostics.baseCommit}`,
    `Merge commit: ${diagnostics.mergeCommit}`,
    `Changed files (${full.changedFiles.length}${diagnostics.changedFilesNotListed ? `, ${diagnostics.changedFilesNotListed} not listed` : ""}): ${JSON.stringify(diagnostics.changedFiles)}`,
    `Diff summary: ${JSON.stringify(diagnostics.diffSummary)}`,
    `Relevant diffs: ${JSON.stringify(diagnostics.relevantDiffs)}`,
    `Current previewManifest: ${JSON.stringify(diagnostics.currentPreviewManifest)}`,
    `Current runConfigurations: ${JSON.stringify(diagnostics.currentRunConfigurations)}`,
    `Strategic files before (only those whose diff above is missing or cut): ${JSON.stringify(diagnostics.strategicFilesBefore)}`,
    `Strategic files after: ${JSON.stringify(diagnostics.strategicFilesAfter)}`,
  ].join("\n");
}

const otherClassifications = [...classifications].filter(
  (value) => value !== "initialization_update_required",
);

/** The result tool's input: a repair instruction comes with an update. */
export const projectInitializationImpactResultSchema = {
  type: "object",
  additionalProperties: false,
  required: ["classification", "reason"],
  properties: {
    classification: { enum: [...classifications] },
    reason: { type: "string", minLength: 1 },
    repairInstruction: {
      type: "string",
      minLength: 1,
      description:
        "Only for initialization_update_required: what the repair agent should regenerate in previewManifest.",
    },
  },
  anyOf: [
    {
      properties: {
        classification: { const: "initialization_update_required" },
      },
      required: ["repairInstruction"],
    },
    {
      properties: { classification: { enum: otherClassifications } },
      not: { required: ["repairInstruction"] },
    },
  ],
};

export function parseProjectInitializationImpactResult(
  parsed: unknown,
): ProjectInitializationImpact {
  if (!isRecord(parsed))
    throw new Error("Initialization impact result must be an object");
  const classification = classificationValue(parsed.classification);
  const reason = stringValue(parsed.reason);
  if (!reason)
    throw new Error("Initialization impact result is missing reason");
  const repairInstruction = stringValue(parsed.repairInstruction);
  if (
    classification === "initialization_update_required" &&
    !repairInstruction
  ) {
    throw new Error(
      "Initialization impact result is missing repairInstruction",
    );
  }
  return {
    classification,
    reason,
    ...(repairInstruction ? { repairInstruction } : {}),
  };
}

export function deterministicInitializationImpact(
  diagnostics: ProjectInitializationImpactDiagnostics,
): ProjectInitializationImpact | undefined {
  if (diagnostics.changedFiles.length === 0) {
    return {
      classification: "initialization_still_valid",
      reason: "The merge did not change tracked project files.",
    };
  }
  if (Object.keys(diagnostics.relevantDiffs).length === 0) {
    return {
      classification: "initialization_still_valid",
      reason:
        "The diff does not touch runtime, package, workspace, service, port, Compose, or environment files.",
    };
  }
  return undefined;
}

async function changedFileNames(input: AssessProjectInitializationImpactInput) {
  const output = await git(input.cwd, [
    "diff",
    "--name-only",
    "--find-renames",
    `${input.baseCommit}..${input.mergeCommit}`,
    "--",
    ".",
    ":!.blame",
    ":!.blame-preview",
    ":!.pnpm-store",
  ]);
  return splitLines(output).filter((path) => !secretEnvPath(path));
}

async function diffSummary(input: AssessProjectInitializationImpactInput) {
  return truncate(
    await git(input.cwd, [
      "diff",
      "--stat",
      `${input.baseCommit}..${input.mergeCommit}`,
      "--",
      ".",
      ":!.blame",
      ":!.blame-preview",
      ":!.pnpm-store",
    ]),
    maxSummaryLength,
  );
}

async function relevantDiffs(
  input: AssessProjectInitializationImpactInput,
  files: string[],
) {
  const entries = await Promise.all(
    files
      .slice(0, 30)
      .map(async (path) => [path, await fileDiff(input, path)] as const),
  );
  return Object.fromEntries(entries.filter(([, diff]) => diff.trim()));
}

async function fileDiff(
  input: AssessProjectInitializationImpactInput,
  path: string,
) {
  return truncate(
    await git(input.cwd, [
      "diff",
      "--no-ext-diff",
      "--find-renames",
      `${input.baseCommit}..${input.mergeCommit}`,
      "--",
      path,
    ]),
    maxDiffLength,
  );
}

async function strategicFiles(
  input: AssessProjectInitializationImpactInput,
  revision: string,
  files: string[],
) {
  const paths = files.filter((path) => !secretEnvPath(path)).slice(0, 30);
  const entries = await Promise.all(
    paths.map(
      async (path) => [path, await gitFile(input.cwd, revision, path)] as const,
    ),
  );
  return Object.fromEntries(entries.filter(fileContentEntry));
}

async function gitFile(cwd: string, revision: string, path: string) {
  try {
    return truncate(
      await git(cwd, ["show", `${revision}:${path}`]),
      maxFileLength,
    );
  } catch {
    return undefined;
  }
}

function relevantProjectFile(path: string) {
  if (secretEnvPath(path)) return false;
  return (
    strategicFilePatterns.some((pattern) => pattern.test(path)) ||
    structurePatterns.some((pattern) => pattern.test(path))
  );
}

function secretEnvPath(path: string) {
  const name = path.split("/").at(-1) ?? "";
  if (name === ".env") return true;
  if (!name.startsWith(".env.")) return false;
  return ![".example", ".sample", ".template"].some((suffix) =>
    name.endsWith(suffix),
  );
}

function fileContentEntry(
  entry: readonly [string, string | undefined],
): entry is readonly [string, string] {
  return entry[1] !== undefined;
}

function classificationValue(value: unknown) {
  if (
    typeof value !== "string" ||
    !classifications.has(value as ProjectInitializationImpactClassification)
  ) {
    throw new Error(
      "Initialization impact result has an invalid classification",
    );
  }
  return value as ProjectInitializationImpactClassification;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function splitLines(value: string) {
  return value.split("\n").filter(Boolean);
}

function truncate(value: string, length: number) {
  if (value.length <= length) return value;
  return value.slice(0, length);
}

async function git(cwd: string, args: string[]) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout.trim();
}
