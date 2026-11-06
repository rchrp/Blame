import { readdir } from "node:fs/promises";
import { join, posix } from "node:path";
import {
  joinWorkspacePath,
  pathExists,
  run,
  runtimeManagedPath,
} from "../workspace-runtime.ts";
import {
  containerComponentPreviewHost,
  workspaceComponentPreviewHost,
  type ComponentPreviewHost,
} from "./component-preview-hosts.ts";
import type {
  ComponentPreviewLocation,
  ComponentPreviewTarget,
} from "./component-preview-service.ts";

// Which package a preview file belongs to, and where its dependencies are
// installed: the story's workspace when Vite is there, otherwise the
// container of a local preview, whose node_modules live in volumes.

export const viteConfigNames = [
  "vite.config.ts",
  "vite.config.mts",
  "vite.config.cts",
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.cjs",
];
const ignoredDirectories = new Set([
  ".blame",
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "vendor",
]);
const searchDepth = 6;
const searchedDirectoryLimit = 5_000;

export async function locateComponentPreview(
  target: ComponentPreviewTarget,
  file: string,
): Promise<ComponentPreviewLocation> {
  const { worktree } = target;
  if (!(await pathExists(worktreePath(worktree, file))))
    return {
      message: `${file} does not exist. Write the preview file first, then call open_component_preview again.`,
    };
  const packageDir = await nearestPackageDirectory(worktree, file);
  if (packageDir === undefined)
    return {
      message: `${file} is in no package: there is no package.json between it and the worktree root.`,
    };
  const label = packageDir || "the worktree root";
  if (!(await hasViteConfig(worktree, packageDir)))
    return {
      message: `${label} has no vite.config.* file: open_component_preview only renders files of a Vite package. Put the preview file in the package that has the Vite config.`,
    };
  if (await viteInstalled(worktree, packageDir))
    return { host: workspaceComponentPreviewHost(worktree), packageDir };
  const container =
    target.workspaceMode === "direct"
      ? undefined
      : await previewContainerHost(worktree);
  if (container) return { host: container, packageDir };
  return {
    message: `Vite is not installed for ${label} in the story's workspace${target.workspaceMode === "direct" ? "" : ", and the story has no local preview container to run it in"}. open_component_preview never installs dependencies: install them first.`,
  };
}

// Whether the project has a Vite package at all: sessions of other
// projects are not offered the tool.
export async function hasViteProject(worktree: string) {
  if (runtimeManagedPath(worktree)) return hasViteProjectInRuntime(worktree);
  let level = [worktree];
  let visited = 0;
  for (let depth = 0; depth < searchDepth && level.length; depth += 1) {
    const next: string[] = [];
    for (const directory of level) {
      if (++visited > searchedDirectoryLimit) return false;
      const entries = await readdir(directory, { withFileTypes: true }).catch(
        () => [],
      );
      for (const entry of entries) {
        if (entry.isFile() && viteConfigNames.includes(entry.name)) return true;
        if (
          entry.isDirectory() &&
          !entry.name.startsWith(".") &&
          !ignoredDirectories.has(entry.name)
        )
          next.push(join(directory, entry.name));
      }
    }
    level = next;
  }
  return false;
}

async function hasViteProjectInRuntime(worktree: string) {
  const pruned = [...ignoredDirectories].flatMap((name, index) =>
    index ? ["-o", "-name", name] : ["-name", name],
  );
  const names = viteConfigNames.flatMap((name, index) =>
    index ? ["-o", "-name", name] : ["-name", name],
  );
  const { stdout } = await run("find", [
    worktree,
    "-maxdepth",
    String(searchDepth),
    "-type",
    "d",
    "(",
    ...pruned,
    ")",
    "-prune",
    "-o",
    "-type",
    "f",
    "(",
    ...names,
    ")",
    "-print",
    "-quit",
  ]);
  return Boolean(stdout.trim());
}

// The closest folder with a package.json, from the file's folder up to the
// worktree root, as a worktree-relative path ("" for the root).
async function nearestPackageDirectory(worktree: string, file: string) {
  for (const directory of ancestors(posix.dirname(file))) {
    if (await pathExists(worktreePath(worktree, directory, "package.json")))
      return directory;
  }
  return undefined;
}

async function hasViteConfig(worktree: string, packageDir: string) {
  const found = await Promise.all(
    viteConfigNames.map((name) =>
      pathExists(worktreePath(worktree, packageDir, name)),
    ),
  );
  return found.some(Boolean);
}

// Node resolves vite from the package folder up to the root.
async function viteInstalled(worktree: string, packageDir: string) {
  const found = await Promise.all(
    ancestors(packageDir).map((directory) =>
      pathExists(
        worktreePath(
          worktree,
          directory,
          "node_modules",
          "vite",
          "package.json",
        ),
      ),
    ),
  );
  return found.some(Boolean);
}

// A service of the story's local preview that runs project code: the
// browser preview's, else the first preview or worker service.
async function previewContainerHost(
  worktree: string,
): Promise<ComponentPreviewHost | undefined> {
  const [{ localPreviewContext, localPreviewEngine }, { previewEndpoint }] =
    await Promise.all([
      import("../preview-runtime/local/local-preview-runner.ts"),
      import("../preview-runtime/local/local-preview-render.ts"),
    ]);
  const engine = localPreviewEngine(worktree);
  const [project, context] = await Promise.all([
    engine.prepared().catch(() => undefined),
    localPreviewContext(worktree).catch(() => undefined),
  ]);
  if (!project || !context) return undefined;
  const serviceId =
    previewEndpoint(context.plan, context.selected)?.serviceId ??
    context.plan.services.find(({ kind }) => kind === "preview")?.id ??
    context.plan.services.find(({ kind }) => kind === "worker")?.id;
  if (!serviceId) return undefined;
  return containerComponentPreviewHost({
    composeFile: engine.composeFile,
    projectName: project.projectName,
    serviceId,
    worktree,
  });
}

// "a/b/c" gives ["a/b/c", "a/b", "a", ""].
function ancestors(directory: string) {
  const segments = directory === "." || !directory ? [] : directory.split("/");
  return Array.from({ length: segments.length + 1 }, (_, index) =>
    segments.slice(0, segments.length - index).join("/"),
  );
}

function worktreePath(worktree: string, ...relativePaths: string[]) {
  const segments = relativePaths.flatMap((path) =>
    path ? path.split("/") : [],
  );
  return segments.length ? joinWorkspacePath(worktree, ...segments) : worktree;
}
