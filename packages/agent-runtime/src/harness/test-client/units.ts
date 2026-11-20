import { absent, unit } from "./harness.js";

// The harness functions some tests call directly, by their TypeScript
// names: each runs blame-harness's own function (`crates/blame-harness/src/
// units.rs`), synchronously as the TypeScript ones were (async where they
// were async). No logic of their own.

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
export type TaskCatalogItem = Json;
export type ShellInspectionRoute = Json;
export type CheckObservation = Json;

export const blockedCommandReason = (command: string, environment?: unknown) =>
  absent(unit("blockedCommandReason", command, environment) as string | null);
export const observeCheck = (command: string, result: unknown, scope: string, sourceChanged: boolean, attributedReport?: string | string[], nodeEvents?: unknown): Json =>
  unit("observeCheck", command, result, scope, sourceChanged, attributedReport, nodeEvents);
export const nodeEventEvidence = (binding: unknown): Json => absent(unit("nodeEventEvidence", binding));
export const checkReporting = (check: unknown, includeGuidance = true): Json => unit("checkReporting", check, includeGuidance);
export const readTaskCatalog = async (root: string, files?: string[], options: { dependencyTaskAvailable?: boolean } = {}): Promise<Json[]> =>
  unit("readTaskCatalog", root, files, options) as Json[];
export const taskInvocation = (task: unknown, args: string[] = []): Json => unit("taskInvocation", task, args);
export const validationScopePaths = (paths: string[], files: string[], cwd: string) => unit("validationScopePaths", paths, files, cwd) as string[];
export const projectTestCommand = (command: string, cwd: string, tasks: unknown[], platform: string = process.platform): Json =>
  absent(unit("projectTestCommand", command, cwd, tasks, platform));
export const runtimeTestScope = (input: unknown): Json => absent(unit("runtimeTestScope", input));
export const readOnlyInspection = (command: string) => absent(unit("readOnlyInspection", command) as "read" | "search" | null);
export const currentValidationReport = (state: unknown, history?: unknown[]): Json => unit("currentValidationReport", state, history);
export const validationStateAfterEdit = (state: unknown, history: unknown[], revision: unknown) =>
  absent(unit("validationStateAfterEdit", state, history, revision) as
    { invalidatedChecks: Array<{ args: string[]; [key: string]: unknown }>; omitted: number; [key: string]: unknown } | null);
export const latestFailedInvocations = (validations: unknown[]): Json[] => unit("latestFailedInvocations", validations) as Json[];
export const failedLiteralCompilerInvocations = (validations: unknown[]): Json[] => unit("failedLiteralCompilerInvocations", validations) as Json[];
export const validationOutput = async (root: string, output: string): Promise<Json> => unit("validationOutput", root, output);
export const alignDependencyPackages = (packages: string[], manifest: unknown) => unit("alignDependencyPackages", packages, manifest) as string[];
export const pathMatches = (query: string, candidates: string[], limit?: number) => unit("pathMatches", query, candidates, limit) as string[];
export const declarationQuery = (query: string) => absent(unit("declarationQuery", query) as string | null);
export const resolvePackageManager = async (input: unknown): Promise<Json> => unit("resolvePackageManager", input);

/**
 * Shell inspection routes; a search's `grep -v` filters come back as the
 * patterns the harness applies, given here as the predicate the routes had.
 */
export function shellInspectionRoutes(command: string, location: { cwd?: string; root: string }): Json[] | undefined {
  const routes = absent(unit("shellInspectionRoutes", command, location) as Json[] | null);
  return routes?.map((route) => {
    const patterns = route.request?.excludeLines as Array<{ source: string; ignoreCase: boolean }> | undefined;
    if (!patterns) return route;
    const { excludeLines: _, ...request } = route.request;
    const expressions = patterns.map(({ source, ignoreCase }) => new RegExp(source, ignoreCase ? "iu" : "u"));
    return { ...route, request: { ...request, excludeLine: (line: string) => expressions.some((expression) => expression.test(line)) } };
  });
}

export const parseTestReport = (source: string): Json => absent(unit("parseTestReport", source));
export const parseTestReports = (sources: string[]): Json => absent(unit("parseTestReports", sources));
export const planScopedLightPatch = (source: string, patch: string, path: string) =>
  unit("planScopedLightPatch", source, patch, path) as Array<{ start: number; end: number; replacement: string }>;
/** `LightCommitService.restoreFiles` on text contents; rejects as it rejected. */
export const restoreFiles = async (root: string, mutations: Array<{ path: string; before?: string; after?: string }>, requireOwnedState: boolean) => {
  unit("restoreFiles", root, mutations, requireOwnedState);
};
/** A test task's managed report, its invocation run in `root`: `{ command, invocation, run, report }`. */
export const managedTestRun = (task: unknown, invocation: unknown, root: string, sequence: number, options: { run?: boolean; timeoutMs?: number } = {}): Json =>
  absent(unit("managedTestRun", task, invocation, root, sequence, options));
/** An invocation-owned Vitest report with `files` written into its directory between two snapshots. */
export const invocationTestReport = (root: string, files: Record<string, string>): Json => unit("invocationTestReport", root, files);
/**
 * `executeWorkspaceCommand`: the command run to its end by the harness's
 * process runner. A signal is given as `cancelAfterMs` (the call is
 * synchronous); an already aborted one is 0.
 */
export const executeWorkspaceCommand = (executable: string, args: string[], options: {
  cwd: string; environment?: Record<string, string>; timeoutMs?: number; maximumOutputBytes?: number; cancelAfterMs?: number;
}) => {
  const result = unit("executeWorkspaceCommand", executable, args, options) as { all: string; exitCode: number | null; failed: boolean; interruption?: string };
  return { ...result, exitCode: absent(result.exitCode) };
};
/** How a shell command runs, with a directory first on its PATH (`EnvironmentAdapter.command`). */
export const shellCommand = (command: string, firstPathDirectory?: string) =>
  unit("shellCommand", command, firstPathDirectory) as { executable: string; args: string[] };

/** The fold read view's constants, as blame-harness folds. */
export const foldEconomics = () => unit("foldEconomics") as {
  foldCallCharacters: number; foldBodyMinimumCharacters: number; foldFileMinimumCharacters: number; foldMarkerPattern: string;
};
export type FoldView = {
  text: string; shown: Array<[number, number]>;
  markers: Array<{ lines: [number, number]; hidden: [number, number]; characters: number; names: string[]; line: string; summary?: string }>;
};
/** A window's fold plan and view; symbols aliased s1, s2… by qualified name. */
export const fold = (path: string, source: string, attention: { lines: number[]; symbols: string[] }, window?: [number, number]) =>
  unit("fold", path, source, attention, window) as { plan: { removed: number; markers: number; kept: Array<{ lines: [number, number]; reason: string }> }; view: FoldView };
export const lineAlignedWindow = (source: string, range: [number, number]) => unit("lineAlignedWindow", source, range) as [number, number];
/** finish_task's screenshots: repeats dropped, the agent's order kept. */
export const finishImages = (images: unknown[]) => unit("finishImages", images) as Array<{ caption: string; id: string }>;
/** `editTargetSymbols`: the symbols an edit may target after reading `intervals` of the file. */
export const editTargetSymbols = (path: string, source: string, intervals: Array<[number, number]>) =>
  unit("editTargetSymbols", path, source, intervals) as Array<{ name: string; qualified_name: string }>;
