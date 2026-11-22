import { createHash } from "node:crypto";
import { posix, relative, sep } from "node:path";
import type { PreviewExecutionPlan } from "@blame/preview-runtime";
import {
  ignoredProjectSearchDirectories,
  joinWorkspacePath,
  readExistingFiles,
  run,
} from "../../workspace-runtime.ts";

// What decides a worktree's dependency key, and what else an install reads.
// Worktrees whose manifests are identical share their node_modules volumes,
// and a story can skip an install another story ran there only when nothing
// the install reads differs either.

export const dependencyManifestFiles = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
];

// Settings that change what an install does or where it puts things.
const packageManagerConfigFiles = [
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".pnpmfile.cjs",
  ".pnpmfile.mjs",
  "bunfig.toml",
];

const maxResults = 30_000;

export type DependencyFile = { file: string; content: string };

/**
 * The key of the node_modules volumes (the manifests at the root and every
 * package.json) and, for shared setup, a hash of what else an install reads
 * (see `sharedInstallInputs`).
 */
export async function dependencyInputs(
  worktree: string,
  plan: Pick<PreviewExecutionPlan, "setup">,
) {
  const searched = await findDependencyFiles(worktree);
  const found = searched ?? [];
  const isManifest = (path: string) => posix.basename(path) === "package.json";
  const manifests = found.filter(isManifest).slice(0, maxResults);
  const others = found.filter((path) => !isManifest(path));
  const keyed = new Map<string, string>();
  for (const file of dependencyManifestFiles)
    keyed.set(joinWorkspacePath(worktree, file), file);
  for (const path of manifests) keyed.set(path, relativePath(worktree, path));
  const contents = await readExistingFiles([
    ...new Set([...keyed.keys(), ...others]),
  ]);
  const read = (entries: Array<[string, string]>) =>
    entries.flatMap(([path, file]) =>
      typeof contents[path] === "string"
        ? [{ file, content: contents[path] as string }]
        : [],
    );
  return {
    key: dependencyKey(read([...keyed]), plan),
    // A search that failed (an unreadable folder) shows no manifest, no
    // lifecycle script and no nested lockfile: nothing is known.
    sharedInstall: searched
      ? sharedInstallInputs(
          read(manifests.map((path) => [path, relativePath(worktree, path)])),
          read(others.map((path) => [path, relativePath(worktree, path)])),
        )
      : undefined,
  };
}

/** Worktrees whose dependency manifests are identical share installs. */
export function dependencyKey(
  files: DependencyFile[],
  plan: Pick<PreviewExecutionPlan, "setup">,
) {
  const hash = createHash("sha256");
  const inputs = [...files].sort(byFile);
  if (!inputs.length) hash.update(JSON.stringify(plan.setup));
  for (const { file, content } of inputs) {
    hash.update(file).update("\0").update(content).update("\0");
  }
  return hash.digest("hex").slice(0, 12);
}

// What an install can run beyond fetching packages: lifecycle scripts of the
// project's own packages (`prepare`, `postinstall`: code generation, git
// hooks, patches, all reading the worktree), and dependencies that are
// folders of the worktree.
const lifecycleScripts = new Set([
  "preinstall",
  "install",
  "postinstall",
  "prepublish",
  "preprepare",
  "prepare",
  "postprepare",
  "pnpm:devPreinstall",
]);
const dependencyFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "resolutions",
  "overrides",
  "pnpm",
];

/**
 * A hash of every lockfile and package manager setting in the worktree, at
 * any depth: the dependency key only reads the lockfiles at the root, and a
 * nested project's lockfile or an `.npmrc` changes what an install puts in a
 * volume. Undefined when an install reads something no hash covers, so a
 * story must run it itself: a lifecycle script in any manifest, a dependency
 * that is a folder of the worktree, a manifest that does not parse, a Yarn
 * release or plugin kept in the repository.
 */
export function sharedInstallInputs(
  manifests: DependencyFile[],
  others: DependencyFile[],
) {
  if (
    !manifests.length ||
    !manifests.every(({ content }) => installsPackagesOnly(content))
  )
    return undefined;
  if (
    others.some(
      ({ file, content }) =>
        /(^|\/)\.yarnrc(\.yml)?$/.test(file) &&
        /^\s*(yarnPath|plugins)\b/m.test(content),
    )
  )
    return undefined;
  const hash = createHash("sha256").update("shared-install-v1\0");
  for (const { file, content } of [...others].sort(byFile))
    hash.update(file).update("\0").update(content).update("\0");
  return hash.digest("hex");
}

function installsPackagesOnly(content: string) {
  let manifest: unknown;
  try {
    manifest = JSON.parse(content);
  } catch {
    return false;
  }
  if (!manifest || typeof manifest !== "object") return false;
  const { scripts } = manifest as { scripts?: unknown };
  if (
    scripts &&
    typeof scripts === "object" &&
    Object.keys(scripts).some((name) => lifecycleScripts.has(name))
  )
    return false;
  return !dependencyFields.some((field) =>
    pointsToFolder((manifest as Record<string, unknown>)[field]),
  );
}

function pointsToFolder(value: unknown): boolean {
  if (typeof value === "string") return /^(file|link|portal):/.test(value);
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some(pointsToFolder);
}

async function findDependencyFiles(worktree: string) {
  const names = [...dependencyManifestFiles, ...packageManagerConfigFiles];
  const any = (flag: string, values: string[]) =>
    values.flatMap((value, index) =>
      index ? ["-o", flag, value] : [flag, value],
    );
  try {
    const { stdout } = await run(
      "find",
      [
        worktree,
        "-type",
        "d",
        "(",
        ...any("-name", ignoredProjectSearchDirectories),
        ")",
        "-prune",
        "-o",
        "-type",
        "f",
        "(",
        ...any("-name", names),
        ")",
        "-print",
      ],
      { cwd: worktree },
    );
    return [...new Set(stdout.split("\n").filter(Boolean))];
  } catch {
    return undefined;
  }
}

function byFile(left: DependencyFile, right: DependencyFile) {
  return left.file.localeCompare(right.file);
}

function relativePath(root: string, path: string) {
  return root.startsWith("/")
    ? posix.relative(root, path)
    : relative(root, path).split(sep).join("/");
}
