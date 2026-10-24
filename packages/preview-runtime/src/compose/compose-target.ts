import { posix } from "node:path";
import type {
  CachePlan,
  PreviewExecutionPlan,
  ServiceLaunchPlan,
  SetupTaskPlan,
} from "../domain/execution-plan.js";
import { installsPackages } from "../compilation/command-normalization.js";

// Where a plan runs. Targets differ only in how the workspace reaches the
// containers, how endpoints are published and how caches are named; the
// services, their environment, dependencies and healthchecks are the same.

/** A Vercel sandbox: the runner owns `/workspace` and a gateway fronts it. */
export type SandboxComposeTarget = {
  kind: "sandbox";
  projectUser: string;
  proxyCertificatePath: string;
  /** Public URL of each browser-bound endpoint, keyed `service:endpoint`. */
  browserBindingUrls: Record<string, string>;
};

/** The Blame Runtime VM: the story worktree is bind-mounted. */
export type LocalComposeTarget = {
  kind: "local";
  projectName: string;
  /** The worktree path on the Docker host. */
  workspacePath: string;
  projectUser: string;
  /** Host port on 127.0.0.1 of every endpoint, keyed `service:endpoint`. */
  hostPorts: Record<string, number>;
  /** Hash of the dependency manifests: worktrees that share it share installs. */
  dependencyKey: string;
  /** Host files mounted over workspace paths, such as materialized env files. */
  fileMounts?: Array<{ source: string; target: string }>;
};

export type ComposeTarget = SandboxComposeTarget | LocalComposeTarget;

export const sandboxProjectName = "blame-preview";

// Volumes the engine creates before Compose runs, so it can give them to the
// project user. Shared volumes outlive the preview. A setup task records
// that it ran in the volumes it fills (`setupMarker`), so a recreated volume
// reruns it and a worktree sharing the volume skips it.
export type EngineVolume = {
  name: string;
  owner: "project" | "root";
  shared: boolean;
  setupMarker: boolean;
};

export type MountedVolume = EngineVolume & { alias: string; target: string };

const sharedPackageCaches = new Set([
  "blame_bun_cache",
  "blame_cargo_cache",
  "blame_corepack_cache",
  "blame_npm_cache",
  "blame_pip_cache",
  "blame_pnpm_store",
  "blame_yarn_cache",
]);

export function projectName(target: ComposeTarget) {
  return target.kind === "sandbox" ? sandboxProjectName : target.projectName;
}

export function cacheVolumes(
  plan: PreviewExecutionPlan,
  target: ComposeTarget,
): MountedVolume[] {
  return plan.caches.map((cache) => cacheVolume(cache, target));
}

function cacheVolume(cache: CachePlan, target: ComposeTarget): MountedVolume {
  const alias = `cache-${safeId(cache.name)}`;
  if (target.kind === "sandbox") {
    return {
      alias,
      name: `${sandboxProjectName}_${alias}`,
      target: cache.target,
      owner: "project",
      shared: false,
      setupMarker: true,
    };
  }
  if (cache.target === "/workspace/node_modules") {
    return {
      alias,
      name: nodeModulesVolumeName(target, cache.target),
      target: cache.target,
      owner: "project",
      shared: true,
      setupMarker: true,
    };
  }
  const shared = sharedPackageCaches.has(cache.name);
  return {
    alias,
    name: shared ? cache.name : `${target.projectName}_${alias}`,
    target: cache.target,
    owner: "project",
    shared,
    setupMarker: !shared,
  };
}

// Locally, the node_modules of each package a service works in lives in a
// volume keyed by the dependency hash, so a new story worktree reuses the
// install of any worktree with the same lockfile. Services that install
// packages mount every package's volume; the others mount their own.
export function packageNodeModulesVolumes(
  plan: PreviewExecutionPlan,
  target: ComposeTarget,
  item: ServiceLaunchPlan | SetupTaskPlan,
): MountedVolume[] {
  if (target.kind !== "local" || !rootNodeModulesCached(plan)) return [];
  const targets = packageDirectories(plan).map(
    (directory) => `${directory}/node_modules`,
  );
  const own = `${item.workingDir.replace(/\/$/, "")}/node_modules`;
  return targets
    .filter((path) => installsPackages(item.command ?? "") || path === own)
    .map((path) => ({
      alias: `deps-${safeId(path.slice("/workspace/".length, -"/node_modules".length))}`,
      name: nodeModulesVolumeName(target, path),
      target: path,
      owner: "project" as const,
      shared: true,
      setupMarker: true,
    }));
}

function rootNodeModulesCached(plan: PreviewExecutionPlan) {
  return plan.caches.some(({ target }) => target === "/workspace/node_modules");
}

function packageDirectories(plan: PreviewExecutionPlan) {
  const directories = [...plan.setup, ...plan.services]
    .map(({ workingDir }) => posix.normalize(workingDir).replace(/\/$/, ""))
    .filter((directory) => directory.startsWith("/workspace/"));
  return [...new Set(directories)].sort();
}

function nodeModulesVolumeName(target: LocalComposeTarget, path: string) {
  const suffix = path
    .slice("/workspace".length)
    .replace(/\/node_modules$/, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  const key = target.dependencyKey.replace(/[^a-zA-Z0-9]/g, "");
  return suffix
    ? `blame_node_modules_${key}_${suffix}`
    : `blame_node_modules_${key}`;
}

/** Whether a volume belongs to Blame's dependency caches (for cleanup). */
export function dependencyVolumeKey(name: string) {
  return /^blame_node_modules_([a-zA-Z0-9]+)(?:_|$)/.exec(name)?.[1];
}

export function safeId(value: string) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "-");
}
