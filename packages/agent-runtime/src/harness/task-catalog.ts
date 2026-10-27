import { access, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import fg from "fast-glob";
import { nativeTaskCatalog } from "./native-task-catalog.js";

export type TaskCatalogItem = {
  command: string;
  cwd: string;
  dependencyPolicy: "optional" | "required";
  kind:
    | "build"
    | "custom"
    | "dependencies"
    | "lint"
    | "service"
    | "test"
    | "typecheck";
  package_manager?: "bun" | "npm" | "pnpm" | "yarn";
  invocation?: TaskInvocation;
  package_manager_version?: string;
  requiresNetwork: boolean;
  script?: string;
  supportsFileSelection: boolean;
  /** Invocation success is known; compiler project coverage has not been resolved. */
  validationScope?: "invocation_only";
  task_id: string;
};

export type TaskInvocation = {
  executable: string;
  args: string[];
  cwd: string;
  packageManagerVersion?: string;
};

/** Diagnostic POSIX-style argv rendering; execution always uses structured argv. */
export function taskInvocationDisplay(invocation: Pick<TaskInvocation, "executable" | "args">): string {
  return [invocation.executable, ...invocation.args].map((word) =>
    /^[a-zA-Z0-9_@%+=:,./-]+$/u.test(word)
      ? word
      : `'${word.replaceAll("'", "'\\''")}'`,
  ).join(" ");
}

type PackageManagerSelection = {
  name: NonNullable<TaskCatalogItem["package_manager"]>;
  version?: string;
};

type PackageManifest = {
  file: string;
  name?: string;
  packageManager?: string;
  scripts: Record<string, string>;
};

type CatalogCandidate = TaskCatalogItem & {
  candidateId: string;
  pathId: string;
};

export async function readTaskCatalog(
  root: string,
  workspaceFiles?: string[],
  options: { dependencyTaskAvailable?: boolean } = {},
): Promise<TaskCatalogItem[]> {
  const manifests = await readPackageManifests(root, workspaceFiles);
  const native = await nativeTaskCatalog(root, workspaceFiles);
  if (!manifests.length) return native;
  const rootManifest = manifests.find(({ file }) => file === "package.json");
  const packageManager = await detectPackageManager(
    root,
    rootManifest?.packageManager,
  );
  const candidates = manifests.flatMap((manifest) =>
    manifestTasks(manifest, packageManager),
  );
  return [
    ...(options.dependencyTaskAvailable === false
      ? []
      : [dependencyTask(packageManager)]),
    ...disambiguateTasks(candidates),
    ...native,
  ].sort((left, right) => left.task_id.localeCompare(right.task_id));
}

export function taskInvocation(task: TaskCatalogItem, args: string[] = []): TaskInvocation {
  if (args.length && task.kind !== "test")
    throw new Error("Extra arguments are supported only for project test tasks.");
  if (task.invocation) return args.length
    ? { ...task.invocation, args: [...task.invocation.args, ...args] }
    : task.invocation;
  if (!task.package_manager)
    throw new Error(`No command for task ${task.task_id}.`);
  if (task.kind === "dependencies") return dependencyInvocation(task);
  const script = task.script ?? task.task_id;
  return taskCommand(
    task.package_manager,
    ["run", script, ...(args.length && task.package_manager === "npm" ? ["--"] : []), ...args],
    task.cwd,
    task.package_manager_version,
  );
}

function dependencyTask(
  packageManager: PackageManagerSelection,
): TaskCatalogItem {
  const invocation = dependencyInvocation({
    package_manager: packageManager.name,
    ...(packageManager.version
      ? { package_manager_version: packageManager.version }
      : {}),
  });
  return {
    task_id: "dependencies",
    kind: "dependencies",
    command: [invocation.executable, ...invocation.args].join(" "),
    cwd: ".",
    package_manager: packageManager.name,
    ...(packageManager.version
      ? { package_manager_version: packageManager.version }
      : {}),
    supportsFileSelection: false,
    requiresNetwork: true,
    dependencyPolicy: "required",
  };
}

function dependencyInvocation(
  task: Pick<TaskCatalogItem, "package_manager" | "package_manager_version">,
) {
  if (!task.package_manager)
    throw new Error("No Node package manager was detected.");
  const args = dependencyArguments[task.package_manager];
  return taskCommand(
    task.package_manager,
    args,
    ".",
    task.package_manager_version,
  );
}

const dependencyArguments = {
  bun: ["install", "--frozen-lockfile"],
  npm: ["ci", "--prefer-offline", "--no-audit", "--no-fund"],
  pnpm: ["install", "--frozen-lockfile", "--prefer-offline"],
  yarn: ["install", "--immutable", "--cached"],
};

async function readPackageManifests(root: string, workspaceFiles?: string[]) {
  const files = workspaceFiles
    ? workspaceFiles.filter(isPackageManifest)
    : await discoverPackageManifests(root);
  const ordered = files.sort((left, right) => {
    if (left === "package.json") return -1;
    if (right === "package.json") return 1;
    return left.localeCompare(right);
  });
  const manifests = await Promise.all(
    ordered.slice(0, 200).map((file) => readPackageManifest(root, file)),
  );
  return manifests.filter((value): value is PackageManifest => !!value);
}

function discoverPackageManifests(root: string) {
  return fg(["package.json", "**/package.json"], {
    cwd: root,
    onlyFiles: true,
    unique: true,
    ignore: [
      "**/.git/**",
      "**/.blame/**",
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/.next/**",
    ],
  });
}

function isPackageManifest(path: string) {
  return path === "package.json" || path.endsWith("/package.json");
}

async function readPackageManifest(
  root: string,
  file: string,
): Promise<PackageManifest | undefined> {
  try {
    const value = JSON.parse(await readFile(join(root, file), "utf8")) as {
      name?: string;
      packageManager?: string;
      scripts?: Record<string, string>;
    };
    return {
      file,
      scripts: value.scripts ?? {},
      ...(value.name ? { name: value.name } : {}),
      ...(value.packageManager ? { packageManager: value.packageManager } : {}),
    };
  } catch {
    return undefined;
  }
}

function manifestTasks(
  manifest: PackageManifest,
  packageManager: PackageManagerSelection,
): CatalogCandidate[] {
  const cwd = dirname(manifest.file).replaceAll("\\", "/");
  const label = packageLabel(manifest, cwd);
  return Object.entries(manifest.scripts)
    .filter(validTask)
    .map(([script, command]) =>
      taskCandidate(packageManager, cwd, label, script, command),
    );
}

function taskCandidate(
  packageManager: PackageManagerSelection,
  cwd: string,
  label: string,
  script: string,
  command: string,
): CatalogCandidate {
  const inferredKind = taskKind(script, command);
  const compilerOnly = inferredKind !== "service" && plainCompilerCheck(command);
  const kind = compilerOnly ? "typecheck" : inferredKind;
  return {
    task_id: cwd === "." ? script : `${label}:${script}`,
    candidateId: cwd === "." ? script : `${label}:${script}`,
    pathId: cwd === "." ? script : `${cwd}:${script}`,
    script,
    kind,
    // A script name cannot establish which files its compiler actually checks.
    ...(kind === "typecheck" ? { validationScope: "invocation_only" as const } : {}),
    command,
    cwd,
    package_manager: packageManager.name,
    ...(packageManager.version
      ? { package_manager_version: packageManager.version }
      : {}),
    supportsFileSelection: kind === "test",
    requiresNetwork: false,
    dependencyPolicy: taskDependencyPolicy(kind),
  };
}

function taskDependencyPolicy(kind: TaskCatalogItem["kind"]) {
  return kind === "custom" || kind === "service"
    ? ("optional" as const)
    : ("required" as const);
}

function disambiguateTasks(candidates: CatalogCandidate[]) {
  const counts = new Map<string, number>();
  for (const task of candidates)
    counts.set(task.candidateId, (counts.get(task.candidateId) ?? 0) + 1);
  return candidates.map(({ candidateId, pathId, ...task }) => ({
    ...task,
    task_id: counts.get(candidateId) === 1 ? candidateId : pathId,
  }));
}

function packageLabel(manifest: PackageManifest, cwd: string) {
  const declared = manifest.name?.split("/").at(-1)?.trim();
  return declared || basename(cwd);
}

function taskCommand(
  executable: string,
  args: string[],
  cwd: string,
  packageManagerVersion?: string,
) {
  return {
    executable,
    args,
    cwd,
    ...(packageManagerVersion ? { packageManagerVersion } : {}),
  };
}

function validTask([taskId, command]: [string, string]) {
  return (
    Boolean(taskId.trim()) &&
    taskId.length <= 300 &&
    Boolean(command.trim()) &&
    command.length <= 2_000
  );
}

async function detectPackageManager(
  root: string,
  declared?: string,
): Promise<PackageManagerSelection> {
  const [name, version] = declaredPackageManager(declared);
  if (name === "bun" || name === "npm" || name === "pnpm" || name === "yarn")
    return { name, ...(version ? { version } : {}) };
  for (const [file, manager] of packageManagerFiles) {
    if (await fileExists(join(root, file))) return { name: manager };
  }
  return { name: "npm" };
}

function declaredPackageManager(value?: string) {
  const match = value
    ?.trim()
    .match(/^(bun|npm|pnpm|yarn)@([^+\s]+)(?:\+.*)?$/u);
  return match ? [match[1], match[2]] : [value?.split("@", 1)[0], undefined];
}

async function fileExists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const packageManagerFiles = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
] as const;

function taskKind(name: string, command: string): TaskCatalogItem["kind"] {
  if (
    /^(dev|preview|serve|start|watch)(:|$)/i.test(name) ||
    /\b--watch\b/.test(command)
  )
    return "service";
  if (/test/i.test(name)) return "test";
  if (/lint/i.test(name)) return "lint";
  if (
    /typecheck|check:type/i.test(name) ||
    (name === "types" && /^tsc[ \t]+--noEmit$/u.test(command.trim()))
  )
    return "typecheck";
  if (/build/i.test(name)) return "build";
  return "custom";
}

export function plainCompilerCheck(command: string) {
  // This establishes the compiler invocation, not which source files it checks.
  return /^(?:tsc|node[ \t]+(?:\.\/)?node_modules\/typescript\/bin\/tsc)[ \t]+--noEmit(?:[ \t]+(?:-p|--project)[ \t]+[A-Za-z0-9_./-]+)?$/u.test(command.trim());
}
