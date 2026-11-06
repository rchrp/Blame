import { lightCapabilityDescription } from "./light-capabilities.js";
import { parseCode } from "./code-intelligence.js";
import { lightRequiredChecksSchema, type LightTaskContract } from "./light-contracts.js";
import type { LightWorkspaceExecutor } from "./light-executor.js";
import { foldViewCharacters } from "./light-fold-economics.js";
import { symbolicPath } from "./light-navigation.js";
import { readTaskCatalog } from "./task-catalog.js";
import { WorkspaceFiles, languageName } from "./workspace-files.js";
import { resolvePackageManager } from "./package-manager-runtime.js";

type InitialTaskBriefingInput = {
  executor?: LightWorkspaceExecutor;
  taskContract?: LightTaskContract;
  workspaceRoot: string;
};

export async function createInitialTaskBriefing(
  input: InitialTaskBriefingInput,
) {
  if (input.executor) return remoteBriefing(input);
  try {
    return await localBriefing(input);
  } catch {
    return undefined;
  }
}

async function localBriefing(input: InitialTaskBriefingInput) {
  const files = new WorkspaceFiles(input.workspaceRoot);
  const snapshot = await files.snapshot();
  const tasks = await readTaskCatalog(input.workspaceRoot, snapshot.files);
  const dependencyTask = tasks.find(({ kind }) => kind === "dependencies");
  const packagePaths = snapshot.files.filter((path) =>
    path.endsWith("package.json"),
  );
  const packages = await packageSummaries(files, packagePaths);
  const candidates = briefingCandidates(
    snapshot.files,
    snapshot.changes.map(({ path }) => path),
    input.taskContract?.objective,
  );
  const targets = await briefingTargets(
    files,
    candidates,
    input.taskContract?.objective,
  );
  return [...briefingLines({
    candidates: targets,
    keyFiles: briefingKeyFiles(snapshot.files),
    manager: dependencyTask?.package_manager,
    managerAvailability: await packageManagerAvailability(dependencyTask),
    environment: await runtimeEnvironmentSummary(files, snapshot.files),
    packages,
    projectMap: projectMap(snapshot.files),
    snapshot,
    tasks,
  }), ...requiredCheckBriefing(input.taskContract)].join("\n");
}

function requiredCheckBriefing(contract?: LightTaskContract) {
  const checks = lightRequiredChecksSchema.parse(contract?.required_checks ?? []);
  return checks.length ? [
    `Required final-source checks: ${JSON.stringify(checks)}. finish_task runs missing selections. Passing test execution does not establish scope coverage or satisfy every user criterion.`,
  ] : [];
}

type BriefingFacts = {
  candidates: string[];
  environment?: string;
  keyFiles: string[];
  manager?: string;
  managerAvailability: string;
  packages: PackageSummary[];
  projectMap: string[];
  snapshot: Awaited<ReturnType<WorkspaceFiles["snapshot"]>>;
  tasks: Awaited<ReturnType<typeof readTaskCatalog>>;
};

type PackageSummary = {
  dependencies: string[];
  name?: string;
  path: string;
  scripts: string[];
};

function briefingLines(input: BriefingFacts) {
  const scripts = input.tasks
    .filter(({ kind }) => kind !== "dependencies" && kind !== "service")
    .slice(0, 16)
    .map(({ task_id }) => task_id)
    .join(", ");
  const git = input.snapshot.git
    ? `branch ${input.snapshot.branch || "detached"}; ${input.snapshot.changes.length} changed path(s)`
    : "not detected";
  return [
    `Project: ${projectDescription(input.snapshot.files)}.`,
    `Project map: ${input.projectMap.join(", ") || "root only"}.`,
    `Config inventory: ${input.keyFiles.join(", ") || "none detected"}.`,
    `Packages: ${packageDescription(input.packages)}.`,
    `Package manager: ${input.manager ?? "not detected"}; ${input.managerAvailability}.`,
    ...(input.environment ? [`Runtime variables: ${input.environment}.`] : []),
    `Task IDs: ${scripts || "none detected"}; pass listed IDs directly to run_task.`,
    `Git: ${git}.`,
    lightCapabilityDescription(),
    ...(input.candidates.length
      ? [`Likely targets: ${input.candidates.join(", ")}.`]
      : []),
  ];
}

async function runtimeEnvironmentSummary(
  files: WorkspaceFiles,
  paths: string[],
) {
  const sources = await Promise.all(
    paths
      .filter(environmentReferencePath)
      .slice(0, 20)
      .map((path) => environmentNames(files, path)),
  );
  const names = [...new Set(sources.flat())].sort().slice(0, 12);
  if (!names.length) return undefined;
  return `${names.join(", ")} referenced; values stay hidden. A missing value is an environment blocker and must not be replaced by a source or localhost fallback`;
}

function environmentReferencePath(path: string) {
  return (
    path.endsWith(".env.example") ||
    /(?:^|\/)prisma\.config\.[cm]?[jt]s$/u.test(path) ||
    path.endsWith("schema.prisma")
  );
}

async function environmentNames(files: WorkspaceFiles, path: string) {
  try {
    const source = (await files.read(path)).content.toString("utf8");
    return [...source.matchAll(databaseEnvironmentName)].map(
      (match) => match[1]!,
    );
  } catch {
    return [];
  }
}

const databaseEnvironmentName =
  /\b((?:DATABASE_URL|DB_[A-Z0-9_]+|MYSQL_[A-Z0-9_]+|POSTGRES(?:QL)?_[A-Z0-9_]+|MONGO(?:DB)?_[A-Z0-9_]+|REDIS_[A-Z0-9_]+))\b/gu;

async function briefingTargets(
  files: WorkspaceFiles,
  paths: string[],
  objective?: string,
) {
  const terms = objectiveTerms(objective);
  const symbols = await Promise.all(
    paths.map((path) => briefingSymbolTarget(files, path, terms)),
  );
  return paths.map((path, index) => symbols[index] ?? path).slice(0, 8);
}

async function briefingSymbolTarget(
  files: WorkspaceFiles,
  path: string,
  terms: string[],
) {
  try {
    if ((await files.fileSize(path)) > 512_000) return undefined;
    const content = (await files.read(path)).content;
    // A file larger than a folded view is best entered through a symbol.
    if (content.toString("utf8").length <= foldViewCharacters || !symbolicPath(path))
      return undefined;
    const symbols = parseCode(path, content)
      .symbols.map((symbol) => ({
        name: symbol.qualified_name,
        score: symbolTargetScore(symbol.qualified_name, terms),
      }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score);
    return symbols[0] ? `${path}#${symbols[0].name}` : undefined;
  } catch {
    return undefined;
  }
}

function symbolTargetScore(name: string, terms: string[]) {
  const normalized = name.toLocaleLowerCase();
  return terms.reduce(
    (score, term) => score + (normalized.includes(term) ? 10 : 0),
    0,
  );
}

async function packageSummaries(files: WorkspaceFiles, paths: string[]) {
  const ordered = paths
    .filter((path) => !briefingExcludedPath(path))
    .sort((left, right) => {
      if (left === "package.json") return -1;
      if (right === "package.json") return 1;
      return pathDepth(left) - pathDepth(right) || left.localeCompare(right);
    });
  const summaries = await Promise.all(
    ordered.slice(0, 12).map((path) => packageSummary(files, path)),
  );
  return summaries.filter((value): value is PackageSummary => Boolean(value));
}

async function packageSummary(files: WorkspaceFiles, path: string) {
  try {
    const content = (await files.read(path)).content.toString("utf8");
    const manifest = JSON.parse(content) as Record<string, unknown>;
    return {
      path,
      ...(typeof manifest.name === "string" ? { name: manifest.name } : {}),
      scripts: Object.keys(record(manifest.scripts))
        .filter(finiteScriptName)
        .slice(0, 8),
      dependencies: dependencySignals(manifest),
    } satisfies PackageSummary;
  } catch {
    return undefined;
  }
}

function finiteScriptName(name: string) {
  return !/^(?:dev|preview|serve|start|watch)(?::|$)/iu.test(name);
}

function dependencySignals(manifest: Record<string, unknown>) {
  const dependencies = new Map<string, string>();
  for (const section of packageDependencySections)
    for (const [name, version] of Object.entries(record(manifest[section])))
      if (typeof version === "string") dependencies.set(name, version);
  return [...dependencies]
    .filter(([name]) => stackDependency.test(name))
    .slice(0, 5)
    .map(([name, version]) => `${name}@${version.slice(0, 24)}`);
}

function packageDescription(packages: PackageSummary[]) {
  if (!packages.length) return "none detected";
  return packages.slice(0, 6).map(formatPackage).join(" | ");
}

function formatPackage(packageValue: PackageSummary) {
  const identity = packageValue.name
    ? `${packageValue.path} (${packageValue.name})`
    : packageValue.path;
  const scripts = packageValue.scripts.length
    ? `scripts ${packageValue.scripts.join(",")}`
    : "no scripts";
  const dependencies = packageValue.dependencies.length
    ? `stack ${packageValue.dependencies.join(",")}`
    : undefined;
  return [identity, scripts, dependencies].filter(Boolean).join("; ");
}

const packageDependencySections = ["dependencies", "devDependencies"];
const stackDependency =
  /(?:^|\/)(?:client|electron|express|fastify|next|prisma|react|svelte|typescript|vite|vue)$/iu;

async function remoteBriefing(input: InitialTaskBriefingInput) {
  const result = await input.executor!({
    input: {},
    taskContract: input.taskContract,
    tool: "initial_task_briefing",
    workspaceRoot: input.workspaceRoot,
  });
  if (result.status !== "ok") return undefined;
  const data = result.data as { briefing?: unknown };
  return typeof data.briefing === "string" ? data.briefing : undefined;
}

async function packageManagerAvailability(
  task: Awaited<ReturnType<typeof readTaskCatalog>>[number] | undefined,
) {
  if (!task?.package_manager) return "not detected";
  try {
    const manager = await resolvePackageManager({
      name: task.package_manager,
      version: task.package_manager_version,
      compatibility:
        task.package_manager === "pnpm" ? "pnpm_same_major" : undefined,
    });
    return `available (${manager.resolvedVersion})`;
  } catch {
    return "executable unavailable";
  }
}

export function appendInitialTaskBriefing(
  systemPrompt: string,
  briefing: string | undefined,
) {
  if (!briefing) return systemPrompt;
  return `${systemPrompt}\n\n<task_briefing>\n${briefing}\n</task_briefing>`;
}

function projectDescription(paths: string[]) {
  const languages = new Map<string, number>();
  for (const path of paths) {
    const language = languageName(path);
    if (language === "unknown") continue;
    languages.set(language, (languages.get(language) ?? 0) + 1);
  }
  const dominant = [...languages]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 4)
    .map(([language, count]) => `${language} (${count})`);
  return `${paths.length} files; ${dominant.join(", ") || "text/configuration"}`;
}

function projectMap(paths: string[]) {
  const counts = new Map<string, number>();
  for (const path of paths) {
    const root = path.includes("/") ? path.split("/", 1)[0]! : "root";
    counts.set(root, (counts.get(root) ?? 0) + 1);
  }
  return [...counts]
    .sort(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
    )
    .slice(0, 10)
    .map(([root, count]) => `${root} (${count})`);
}

function briefingKeyFiles(paths: string[]) {
  return paths
    .map((path) => ({ path, score: keyFileScore(path) }))
    .filter(({ score }) => score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || left.path.localeCompare(right.path),
    )
    .slice(0, 10)
    .map(({ path }) => path);
}

function keyFileScore(path: string) {
  if (briefingExcludedPath(path)) return 0;
  const depth = pathDepth(path);
  if (path === "package.json") return 100;
  if (/^(?:pnpm-workspace\.yaml|README\.md|tsconfig\.json)$/iu.test(path))
    return 90;
  if (/(?:^|\/)schema\.prisma$/u.test(path)) return 85 - depth;
  if (/(?:^|\/)package\.json$/u.test(path)) return 80 - depth;
  if (/(?:^|\/)src\/(?:app|index|main|server)\.[^.]+$/u.test(path))
    return 70 - depth;
  if (/(?:^|\/)(?:compose\.ya?ml|docker-compose\.ya?ml)$/u.test(path))
    return 60;
  return 0;
}

function briefingExcludedPath(path: string) {
  return /(?:^|\/)(?:__fixtures__|fixtures|test-fixtures)(?:\/|$)/u.test(path);
}

function pathDepth(path: string) {
  return path.split("/").length - 1;
}

function briefingCandidates(
  paths: string[],
  changedPaths: string[],
  objective?: string,
) {
  const terms = objectiveTerms(objective);
  const changed = new Set(changedPaths);
  return paths
    .filter(
      (path) =>
        !briefingExcludedPath(path) &&
        !/(?:^|\/)(?:dist|migrations?|node_modules)(?:\/|$)/u.test(path),
    )
    .map((path) => ({
      path,
      score: candidateScore(path, terms, changed.has(path)),
    }))
    .filter(({ score }) => score >= 10)
    .sort(
      (left, right) =>
        right.score - left.score || left.path.localeCompare(right.path),
    )
    .slice(0, 5)
    .map(({ path }) => path);
}

function objectiveTerms(objective?: string) {
  return [
    ...new Set(
      (objective ?? "")
        .normalize("NFKC")
        .toLocaleLowerCase()
        .match(/[\p{L}\p{N}_-]{4,}/gu) ?? [],
    ),
  ].slice(0, 30);
}

function candidateScore(path: string, terms: string[], changed: boolean) {
  const normalized = path.toLocaleLowerCase();
  return terms.reduce(
    (score, term) => score + (normalized.includes(term) ? 10 : 0),
    changed ? 20 : 0,
  );
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
