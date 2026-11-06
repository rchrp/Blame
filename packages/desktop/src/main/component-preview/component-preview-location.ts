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
import type { ComponentPreviewToolkit } from "./component-preview-server-script.ts";
import type {
  ComponentPreviewLocation,
  ComponentPreviewTarget,
} from "./component-preview-service.ts";

// Which package a preview file belongs to, which Vite serves it, and where
// its dependencies are installed: the story's workspace when they are
// there, otherwise the container of a local preview, whose node_modules
// live in volumes. A cloud preview's dependencies are in its sandbox: the
// server runs there. A package with a Vite config is served by its own
// Vite; a React, Vue 3 or Angular package without one, such as a Next.js,
// Vue CLI or Angular CLI app, by Blame's.

// The host in the story's cloud preview sandbox, or why there is none.
export type CloudComponentPreviewLocator = (
  target: ComponentPreviewTarget,
) => Promise<ComponentPreviewHost | { message: string }>;

// What a package.json declares: a framework Blame's own Vite renders, or
// one it does not: Vue 2, Angular 16 or earlier, or Angular without the
// builder whose compiler @analogjs/vite-plugin-angular uses.
type DeclaredFramework =
  | ComponentPreviewToolkit["framework"]
  | "angular-legacy"
  | "angular-without-builder"
  | "vue2";

const unsupportedFrameworks = new Set<DeclaredFramework>([
  "angular-legacy",
  "angular-without-builder",
  "vue2",
]);
const angularBuilders = ["@angular/build", "@angular-devkit/build-angular"];

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
  cloud?: CloudComponentPreviewLocator,
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
    : await toolkitFramework(worktree, packageDir);
  if (framework === "vue2")
    return {
      message: `Vue 2 is not supported: ${label} depends on Vue 2 and has no vite.config.* file. Without one, open_component_preview renders React, Vue 3 (vue 3.2.25 or later) and Angular 17 to 22 components only. Check this component in the app instead.`,
    };
  if (framework === "angular-legacy")
    return {
      message: `Angular 16 and earlier are not supported: ${label} depends on one of them and has no vite.config.* file. Without one, open_component_preview renders Angular 17 to 22 components only. Check this component in the app instead.`,
    };
  if (framework === "angular-without-builder")
    return {
      message: `${label} depends on Angular, but neither it nor the package.json files above it declare @angular/build or @angular-devkit/build-angular: @analogjs/vite-plugin-angular compiles with the compiler of that builder. Put the preview file in the package of an Angular CLI app.`,
    };
  if (!projectVite && !framework)
    return {
      message: `${label} has no vite.config.* file and does not depend on React, Vue 3 or Angular: open_component_preview renders files of a Vite package, or of a React, Vue 3 or Angular package such as a Next.js, Vue CLI or Angular CLI app. Put the preview file in the package of the component.`,
    };
  const toolkit = framework ? { toolkit: { framework } } : {};
  if (target.workspaceMode === "cloud-mirror") {
    // This computer has the files, never the dependencies.
    const host = cloud
      ? await cloud(target)
      : {
          message: "This cloud preview cannot run a component preview server.",
        };
    return "message" in host ? host : { host, packageDir, ...toolkit };
  }
  const { dependency, required } = requiredPackages(
    projectVite ? undefined : framework,
  );
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
    message: `${dependency} is not installed for ${label} in the story's workspace${target.workspaceMode === "direct" ? "" : ", and the story has no local preview container to run it in"}. open_component_preview never installs the project's dependencies: install them first.`,
  };
}

// What must be installed for the package, and its name in messages. The
// server checks the versions and the Angular builder itself.
function requiredPackages(
  framework: ComponentPreviewToolkit["framework"] | undefined,
) {
  if (!framework) return { dependency: "Vite", required: ["vite"] };
  if (framework === "vue") return { dependency: "Vue", required: ["vue"] };
  if (framework === "angular")
    return {
      dependency: "Angular",
      required: ["@angular/core", "@angular/compiler-cli"],
    };
  return { dependency: "React", required: ["react", "react-dom"] };
}

// Whether the project has a package the tool renders: one with a Vite
// config, or one that depends on React, Vue 3, or Angular 17 to 22 with
// its builder. Sessions of other projects, such as an Ember or Vue 2 app,
// are not offered the tool.
export async function hasComponentPreviewProject(worktree: string) {
  const markers = runtimeManagedPath(worktree)
    ? await projectMarkersInRuntime(worktree)
    : await projectMarkers(worktree);
  if (markers.viteConfig) return true;
  const manifests = await readExistingFiles(
    markers.manifests.slice(0, manifestReadLimit),
  );
  return Object.values(manifests).some((text) => {
    const framework = declaredFramework(manifestDependencies(text));
    return framework !== undefined && !unsupportedFrameworks.has(framework);
  });
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

// The framework of the closest package.json that declares one: the
// package's own, else its workspace root's. The Next.js shims only apply
// to the Next.js app itself. An Angular library declares @angular/core
// without a builder: the builder of its workspace root compiles it.
async function toolkitFramework(
  worktree: string,
  packageDir: string,
): Promise<DeclaredFramework | undefined> {
  const paths = ancestors(packageDir).map((directory) =>
    worktreePath(worktree, directory, "package.json"),
  );
  const files = await readExistingFiles(paths);
  let withoutBuilder: DeclaredFramework | undefined;
  for (const [index, path] of paths.entries()) {
    const framework = declaredFramework(manifestDependencies(files[path]));
    if (framework === "angular-without-builder") withoutBuilder ??= framework;
    else if (framework)
      return framework === "next" && index > 0 ? "react" : framework;
  }
  return withoutBuilder;
}

// The packages a package.json declares, with their version ranges. One
// that is not valid JSON declares none: the project's own tools report it.
function manifestDependencies(text: string | null | undefined) {
  const dependencies = new Map<string, string>();
  if (!text) return dependencies;
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    return dependencies;
  }
  if (!manifest || typeof manifest !== "object") return dependencies;
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    const value = (manifest as Record<string, unknown>)[field];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const [name, range] of Object.entries(value))
      if (!dependencies.has(name))
        dependencies.set(name, typeof range === "string" ? range : "");
  }
  return dependencies;
}

// An Angular CLI app, with @angular/core and its builder, renders as
// Angular even if it also depends on React. React wins over Vue in a
// package that declares both, as before Vue was supported.
function declaredFramework(
  dependencies: Map<string, string>,
): DeclaredFramework | undefined {
  const angular = dependencies.get("@angular/core");
  if (
    angular !== undefined &&
    angularBuilders.some((builder) => dependencies.has(builder))
  )
    return belowMajor(angular, 17) ? "angular-legacy" : "angular";
  if (dependencies.has("next")) return "next";
  if (dependencies.has("react")) return "react";
  const vue = dependencies.get("vue");
  if (vue !== undefined) return belowMajor(vue, 3) ? "vue2" : "vue";
  return angular === undefined ? undefined : "angular-without-builder";
}

// Whether every alternative of a range stays below a major, such as
// "^2.7.16" or "~2.6.14 || 2.7.x" below 3. A tag, an alias or a workspace
// range does not: the server checks the installed version before it
// compiles anything.
function belowMajor(range: string, major: number) {
  return range
    .split("||")
    .map((alternative) => /^\s*[\^~>=v\s]*(\d+)/u.exec(alternative)?.[1])
    .every((found) => found !== undefined && Number(found) < major);
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
