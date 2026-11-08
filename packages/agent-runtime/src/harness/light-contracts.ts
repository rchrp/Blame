import type { ImageContent } from "@cline/sdk";
import { z } from "zod";

const relativePath = z.string().trim().min(1).max(4_096);
const editContent = z.string().max(2_097_152);

export const lightSearchCodeInputSchema = z
  .object({
    query: z.string().trim().min(1).max(1_000),
    scope: z.union([relativePath, z.array(relativePath).max(100)]).optional()
      .describe('One literal path/glob, or multiple scopes as an array, e.g. ["src","spec"]. A space in one string belongs to that path.'),
    mode: z.enum(["auto", "text", "regex", "symbol", "references"]).optional(),
    output: z.enum(["matches", "files", "count"]).optional()
      .describe("matches (default): located hits with aliases; files: every matching path with its matching-line count; count: totals only."),
    caseSensitive: z.boolean().optional().describe("Text and regex searches ignore case unless true."),
    context: z.number().int().min(0).max(30).optional()
      .describe("Lines of surrounding source shown with each text match, grep -C style (12: match, 11- context)."),
    limit: z.number().int().min(1).max(100).optional()
      .describe("Results per page: 8 matches or 50 files by default."),
    offset: z.number().int().min(0).max(5_000).optional()
      .describe("Results to skip; a limited result returns the next page as nextSearch."),
  })
  .strict();

const lineRange = z
  .object({
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  })
  .strict()
  .refine((value) => value.endLine >= value.startLine);

export const lightReadCodeInputSchema = z
  .object({
    target: z.string().trim().min(1).max(4_096),
    view: z.enum(["auto", "raw", "outline", "symbol", "signature", "range", "declaration"]).optional(),
    offset: z.number().int().nonnegative().max(256_000).optional()
      .describe("Only for declaration continuation; use the offset returned by nextRead."),
    range: z.union([lineRange, z.array(lineRange).min(1).max(8)]).optional()
      .describe("Lines to read; an array reads up to 8 ranges in one call."),
  })
  .strict();

/** The line ranges of a read, one or several. */
export function readRanges(input: Pick<LightReadCodeInput, "range">) {
  return input.range === undefined ? [] : Array.isArray(input.range) ? input.range : [input.range];
}

const symbolEdit = z
  .object({
    kind: z.literal("symbol"),
    target: z.string().trim().min(1).max(4_096),
    action: z.enum([
      "replace",
      "replace_body",
      "rename",
      "insert_before",
      "insert_after",
      "delete",
    ]),
    content: editContent.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.action !== "delete" && value.content === undefined)
      context.addIssue({ code: "custom", message: "content is required" });
  });

const patchEdit = z
  .object({
    kind: z.literal("patch"),
    target: z.string().trim().min(1).max(4_096).optional().describe("Observed symbol alias. Restricts one Update File patch to this symbol; its header must match the alias path. Omit target for a deliberate file/multi-file patch; explicit headers select those files."),
    path: relativePath.optional().describe("Target for raw content or a patch without file headers. Explicit patch headers select their own files."),
    patch: editContent
      .min(1)
      .describe(
        "For an existing file: *** Begin Patch\n*** Update File: file.ts\n@@\n-old line\n+new line\n*** End Patch. For a new path, complete raw content is also accepted.",
      ),
  })
  .strict();

export const lightEditCodeInputSchema = z
  .object({
    operations: z
      .array(z.discriminatedUnion("kind", [symbolEdit, patchEdit]))
      .min(1)
      .max(50),
  })
  .strict();

export const lightRunTaskInputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("analyze"),
      target: z.string().trim().min(1).max(4_096)
        .describe("Typed TypeScript function sN alias or path#functionName. Analysis reads source but grants no edit or validation coverage."),
      inputs: z.record(z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/u), z.union([
        z.object({ min: z.number().int().safe(), max: z.number().int().safe() }).strict()
          .refine(({ min, max }) => min <= max, "min must not exceed max"),
        z.object({ type: z.literal("boolean") }).strict(),
      ])).refine((inputs) => Object.keys(inputs).length <= 8, "At most eight inputs"),
      assertion: z.string().trim().min(1).max(2_000)
        .describe("Boolean expression over input names and result. Supported pure scalar subset only. A bounded no-counterexample result is not project verification."),
      timeoutMs: z.number().int().min(100).max(10_000).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("inspect").describe("Waits on a command run_task started; it does not run a new command."),
      run: z.string().regex(/^r[1-9]\d*$/u).describe("The rN id returned by run_task."),
      cursor: z.string().regex(/^\d+$/u).optional().describe("Output position to read from, as returned by the previous result; without it the latest output is shown."),
      until: z.enum(["exit", "output", "now"]).optional()
        .describe("exit (default): wait until the run ends, up to 4 minutes. output: return as soon as new output arrives. now: return at once."),
    })
    .strict(),
  z
    .object({
      kind: z.literal("project"),
      task: z.string().trim().min(1).max(300),
      packagePath: relativePath.optional(),
      args: z.array(z.string().min(1).max(2_048).refine((value) => !value.includes("\0")))
        .max(32).optional()
        .describe("Extra argv for a test task, such as filters or --run. Keep task equal to its catalog ID; arguments are passed literally, without shell expansion."),
    })
    .strict(),
  z
    .object({
      kind: z.literal("command").optional().default("command"),
      command: z.string().trim().min(1).max(8_000),
      cwd: relativePath.optional(),
    })
    .strict(),
  z
    .object({
      kind: z
        .literal("dependency")
        .describe(
          "Node package.json dependencies only; use command for other package managers.",
        ),
      action: z.enum(["add", "remove"]),
      packages: z.array(z.string().trim().min(1).max(300)).min(1).max(50),
      packagePath: relativePath.optional(),
    })
    .strict(),
]);

/** Keep experimental reasoning out of ordinary model schemas until enabled. */
const [, inspectTask, projectTask, commandTask, dependencyTask] = lightRunTaskInputSchema.options;
export const lightDefaultRunTaskInputSchema = z.discriminatedUnion("kind",
  [inspectTask, projectTask, commandTask, dependencyTask]);

// The final reply can be a long analysis. This only stops a runaway answer;
// project memory keeps its own short excerpt.
export const finishSummaryLimit = 100_000;

export const finishTaskInputSchema = z
  .object({
    summary: z.string().trim().min(1).max(finishSummaryLimit),
    images: z
      .array(
        z
          .object({
            ref: z.string().regex(/^screenshot:[0-9a-f]{64}$/u),
            caption: z.string().trim().min(1).max(160),
          })
          .strict(),
      )
      .max(8)
      .optional(),
  })
  .strict();

export type FinishTaskImage = { caption: string; id: string };

export type LightSearchCodeInput = z.infer<typeof lightSearchCodeInputSchema>;
export type LightReadCodeInput = z.infer<typeof lightReadCodeInputSchema>;
export type LightEditCodeInput = z.infer<typeof lightEditCodeInputSchema>;
export type LightRunTaskInput = z.infer<typeof lightRunTaskInputSchema>;

/** Trusted caller requirements, never commands inferred from acceptance prose. */
export const lightRequiredChecksSchema = z.array(z.object({
  id: z.string().regex(/^[A-Za-z0-9_.:-]{1,120}$/u),
  task: z.string().trim().min(1).max(300),
  args: z.array(z.string().min(1).max(2_048).refine((value) => !value.includes("\0"))).max(32).optional(),
}).strict()).max(16).refine((checks) => new Set(checks.map(({ id }) => id)).size === checks.length,
  "Required check IDs must be unique.");

export type RequiredProjectCheck = z.infer<typeof lightRequiredChecksSchema>[number];

export type LightTaskContract = {
  environment?: { isolated: boolean; managedPreview: boolean };
  acceptance_criteria?: string[];
  required_checks?: RequiredProjectCheck[];
  effect_requirement?: "none" | "source_change";
  objective?: string;
  session_id?: string;
  story_id?: string;
};

/**
 * What the desktop grants the commands of one managed runtime request. With
 * it, a command never inherits GH_TOKEN or GITHUB_TOKEN: GH_TOKEN is the
 * granted token, when there is one.
 */
export type LightCommandCredentials = { githubToken?: string };

export type LightToolResult<T> =
  | { status: "ok"; data: T; receipt?: string; content?: ImageContent[] }
  | {
      status: "blocked";
      category: "input" | "code" | "command" | "environment" | "external";
      message: string;
      recovery?: string;
      diagnosticId?: string;
    }
  | {
      status: "failed";
      category: "harness";
      applied?: boolean;
      recovery?: "recovery_required";
      paths?: string[];
      message: string;
      diagnosticId: string;
    };
