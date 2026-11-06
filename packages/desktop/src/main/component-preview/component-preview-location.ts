import { readdir } from "node:fs/promises";
import { join, posix } from "node:path";
import {
  joinWorkspacePath,
  pathExists,
  readExistingFiles,
  run,
  runtimeManagedPath,
} from "../workspace-runtime.ts";
import {
  componentPreviewToolkitRoot,
  containerComponentPreviewHost,
  ensureComponentPreviewToolkitRoot,
  workspaceComponentPreviewHost,
  type ComponentPreviewHost,
} from "./component-preview-hosts.ts";
import type {
  ComponentPreviewLocation,
  ComponentPreviewTarget,
} from "./component-preview-service.ts";

// Which package a preview file belongs to, which Vite serves it, and where
// its dependencies are installed: the story's workspace when they are
// there, otherwise the container of a local preview, whose node_modules
// live in volumes. A package with a Vite config is served by its own Vite;
// a React package without one, such as a Next.js app, by Blame's.

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
const manifestReadLimit = 200;

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
  const projectVite = await hasViteConfig(worktree, packageDir);
  const framework = projectVite
    ? undefined
    : await reactFramework(worktree, packageDir);
  if (!projectVite && !framework)
    return {
      message: `${label} has no vite.config.* file and does not depend on React: open_component_preview renders files of a Vite package, or of a React package such as a Next.js app. Put the preview file in the package of the component.`,
    };
  const toolkit = framework ? { toolkit: { framework } } : {};
  const required = projectVite ? ["vite"] : ["react", "react-dom"];
  if (await installed(worktree, packageDir, required))
    return {
      host: workspaceComponentPreviewHost(worktree),
      packageDir,
      ...toolkit,
    };
  if (target.workspaceMode !== "direct") {
    // Blame's own Vite is mounted from the runtime, where the container's
    // user can write it.
    const toolkitRoot = framework
      ? componentPreviewToolkitRoot(worktree)
      : undefined;
    const container = await previewContainerHost(worktree, toolkitRoot);
    if (container && toolkitRoot) {
      try {
        await ensureComponentPreviewToolkitRoot(worktree, toolkitRoot);
      } catch (error) {
        return {
          message: `Blame could not create ${toolkitRoot}, the folder of its own Vite: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    if (container) return { host: container, packageDir, ...toolkit };
  }
  return {
    message: `${projectVite ? "Vite" : "React"} is not installed for ${label} in the story's workspace${target.workspaceMode === "direct" ? "" : ", and the story has no local preview container to run it in"}. open_component_preview never installs the project's dependencies: install them first.`,
  };
}

// Whether the project has a package the tool renders: one with a Vite
// config, or one that depends on React. Sessions of other projects, such
// as an Angular app, are not offered the tool.
export async function hasComponentPreviewProject(worktree: string) {
  const markers = runtimeManagedPath(worktree)
    ? await projectMarkersInRuntime(worktree)
    : await projectMarkers(worktree);
  if (markers.viteConfig) return true;
  const manifests = await readExistingFiles(
    markers.manifests.slice(0, manifestReadLimit),
  );
  return Object.values(manifests).some((text) =>
    dependsOnReact(manifestDependencies(text)),
  );
}

type ProjectMarkers = { manifests: string[]; viteConfig: boolean };

async function projectMarkers(worktree: string): Promise<ProjectMarkers> {
  const manifests: string[] = [];
  let level = [worktree];
  let visited = 0;
  for (let depth = 0; depth < searchDepth && level.length; depth += 1) {
    const next: string[] = [];
    for (const directory of level) {
      if (++visited > searchedDirectoryLimit)
        return { manifests, viteConfig: false };
      const entries = await readdir(directory, { withFileTypes: true }).catch(
        () => [],
      );
      for (const entry of entries) {
        if (entry.isFile() && viteConfigNames.includes(entry.name))
          return { manifests, viteConfig: true };
        if (entry.isFile() && entry.name === "package.json")
          manifests.push(join(directory, entry.name));
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
  return { manifests, viteConfig: false };
}

async function projectMarkersInRuntime(
  worktree: string,
): Promise<ProjectMarkers> {
  const pruned = [...ignoredDirectories].flatMap((name, index) =>
    index ? ["-o", "-name", name] : ["-name", name],
  );
  const names = [...viteConfigNames, "package.json"].flatMap((name, index) =>
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
  ]);
  const files = stdout.split("\n").filter(Boolean);
  return {
    manifests: files.filter((path) => posix.basename(path) === "package.json"),
    viteConfig: files.some((path) =>
      viteConfigNames.includes(posix.basename(path)),
    ),
  };
}

// "next" for a package that depends on Next.js, "react" for one that, or
// whose workspace root, depends on React.
async function reactFramework(worktree: string, packageDir: string) {
  const paths = ancestors(packageDir).map((directory) =>
    worktreePath(worktree, directory, "package.json"),
  );
  const files = await readExistingFiles(paths);
  const [own, ...parents] = paths.map((path) =>
    manifestDependencies(files[path]),
  );
  if (own?.has("next")) return "next" as const;
  if ([own, ...parents].some((names) => names && dependsOnReact(names)))
    return "react" as const;
  return undefined;
}

// The packages a package.json declares. One that is not valid JSON
// declares none: the project's own tools report it.
function manifestDependencies(text: string | null | undefined) {
  if (!text) return new Set<string>();
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    return new Set<string>();
  }
  const fields = ["dependencies", "devDependencies", "peerDependencies"];
  return new Set(
    fields.flatMap((field) => {
      const value =
        manifest && typeof manifest === "object"
          ? (manifest as Record<string, unknown>)[field]
          : undefined;
      return value && typeof value === "object" && !Array.isArray(value)
        ? Object.keys(value)
        : [];
    }),
  );
}

function dependsOnReact(dependencies: Set<string>) {
  return dependencies.has("react") || dependencies.has("next");
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

// Node resolves each package from the package folder up to the root.
async function installed(
  worktree: string,
  packageDir: string,
  packageNames: string[],
) {
  const found = await Promise.all(
    packageNames.flatMap((name) =>
      ancestors(packageDir).map(async (directory) =>
        (await pathExists(
          worktreePath(
            worktree,
            directory,
            "node_modules",
            name,
            "package.json",
          ),
        ))
          ? name
          : undefined,
      ),
    ),
  );
  return packageNames.every((name) => found.includes(name));
}

// A service of the story's local preview that runs project code: the
// browser preview's, else the first preview or worker service.
async function previewContainerHost(
  worktree: string,
  toolkitRoot: string | undefined,
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
    ...(toolkitRoot ? { toolkitRoot } : {}),
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
