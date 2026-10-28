import {
  configurationName,
  nativeProjectEvidence,
} from "./project-configuration-evidence.js";
import { type Dirent } from "node:fs";
import { opendir, realpath } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";

const maxDiscoveredFiles = 30_000;
const maxPriorityFiles = 6_000;
const maxRootMarkerFiles = 6_000;
const maxScannedDirectories = 15_000;
const maxDirectoryEntries = 20_000;
const maxDirectoryDepth = 32;
const traversalConcurrency = 32;
const ignoredDirectoryNames = new Set([
  ".adonisjs",
  ".angular",
  ".bundle",
  ".blame",
  ".blame-preview",
  ".cache",
  ".carthage",
  ".code-review-graph",
  ".dart_tool",
  ".gradle",
  ".idea",
  ".mypy_cache",
  ".next",
  ".nox",
  ".nuxt",
  ".output",
  ".pnpm-store",
  ".pytest_cache",
  ".ruff_cache",
  ".svelte-kit",
  ".tox",
  ".turbo",
  ".venv",
  "__pycache__",
  "_build",
  "coverage",
  "deriveddata",
  "node_modules",
  "pods",
  "site-packages",
  "venv",
]);
const conditionallyIgnoredDirectories = new Map([
  ["deps", new Set(["mix.exs"])],
  ["target", new Set(["cargo.toml", "pom.xml"])],
  ["vendor", new Set(["composer.json", "gemfile", "go.mod"])],
]);
const generatedOutputDirectoryNames = new Set([
  "__generated__",
  "build",
  "dist",
  "generated",
  "out",
]);
const repositoryDirectoryNames = new Set([".git", ".hg", ".svn"]);
const manifestNames = new Set([
  "build.gradle",
  "build.gradle.kts",
  "build.sbt",
  "build.xml",
  "build.zig",
  "cabal.project",
  "cargo.toml",
  "cartfile",
  "chart.yaml",
  "cmakelists.txt",
  "composer.json",
  "conanfile.txt",
  "cpanfile",
  "deno.json",
  "deno.jsonc",
  "deps.edn",
  "description",
  "dune-project",
  "flake.nix",
  "gemfile",
  "go.mod",
  "go.work",
  "meson.build",
  "mix.exs",
  "module.bazel",
  "package.swift",
  "package.json",
  "podfile",
  "pipfile",
  "pom.xml",
  "project.clj",
  "project.toml",
  "pubspec.yaml",
  "pyproject.toml",
  "settings.gradle",
  "settings.gradle.kts",
  "setup.cfg",
  "setup.py",
  "stack.yaml",
  "vcpkg.json",
  "workspace",
  "workspace.bazel",
]);
const lockFileNames = new Set([
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "cabal.project.freeze",
  "cartfile.resolved",
  "composer.lock",
  "deno.lock",
  "gemfile.lock",
  "go.sum",
  "go.work.sum",
  "gradle.lockfile",
  "mix.lock",
  "manifest.toml",
  "package-lock.json",
  "packages.lock.json",
  "package.resolved",
  "pdm.lock",
  "pipfile.lock",
  "pnpm-lock.yaml",
  "poetry.lock",
  "podfile.lock",
  "pubspec.lock",
  "renv.lock",
  "stack.yaml.lock",
  ".terraform.lock.hcl",
  "uv.lock",
  "yarn.lock",
]);
const runtimeRootNames = new Set([
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
  "dockerfile",
  "gnumakefile",
  "justfile",
  "makefile",
  "procfile",
  "taskfile.yaml",
  "taskfile.yml",
]);
const runtimePinNames = new Set([
  ".java-version",
  ".node-version",
  ".nvmrc",
  ".python-version",
  ".ruby-version",
  ".sdkmanrc",
  ".tool-versions",
  "global.json",
  "mise.toml",
  "rust-toolchain",
  "rust-toolchain.toml",
]);
const workspaceMarkerNames = new Set([
  "lerna.json",
  "melos.yaml",
  "nx.json",
  "pnpm-workspace.yaml",
  "rush.json",
  "turbo.json",
  "workspace.json",
]);
const sourceExtensions = new Set([
  ".asm",
  ".adb",
  ".ads",
  ".bat",
  ".c",
  ".cc",
  ".cjs",
  ".clj",
  ".cljs",
  ".cmd",
  ".coffee",
  ".cpp",
  ".cs",
  ".css",
  ".cts",
  ".cr",
  ".d",
  ".dart",
  ".ejs",
  ".erl",
  ".erb",
  ".ex",
  ".exs",
  ".fs",
  ".fsx",
  ".go",
  ".gql",
  ".graphql",
  ".groovy",
  ".h",
  ".hbs",
  ".hpp",
  ".hs",
  ".htm",
  ".html",
  ".java",
  ".jl",
  ".js",
  ".jsx",
  ".kt",
  ".kts",
  ".less",
  ".lua",
  ".m",
  ".mjs",
  ".ml",
  ".mli",
  ".mm",
  ".mts",
  ".nim",
  ".nix",
  ".php",
  ".pas",
  ".pl",
  ".prisma",
  ".proto",
  ".ps1",
  ".py",
  ".r",
  ".rb",
  ".rs",
  ".s",
  ".sass",
  ".scala",
  ".scss",
  ".sh",
  ".sol",
  ".sql",
  ".svelte",
  ".sv",
  ".svh",
  ".swift",
  ".tf",
  ".ts",
  ".tsx",
  ".twig",
  ".v",
  ".vb",
  ".vue",
  ".vhd",
  ".vhdl",
  ".zig",
]);

type PendingDirectory = {
  depth: number;
  path: string;
};

type DiscoveryState = {
  root: string;
  files: string[];
  priorityFiles: Set<string>;
  rootMarkerFiles: Set<string>;
  directories: string[];
  repositoryRoots: Set<string>;
  ignoredDirectoryCount: number;
  scannedDirectoryCount: number;
  truncated: boolean;
};

export type ProjectRootEvidence = {
  path: string;
  markers: string[];
};

export type ProjectFileDiscovery = {
  files: string[];
  directories: string[];
  projectRoots: ProjectRootEvidence[];
  repositoryRoots: string[];
  ignoredDirectoryCount: number;
  scannedDirectoryCount: number;
  truncated: boolean;
};

const activeDiscoveries = new Map<string, Promise<ProjectFileDiscovery>>();

export async function discoverProjectFiles(root: string) {
  const key = await canonicalRoot(root);
  const current = activeDiscoveries.get(key);
  if (current) return current;
  const discovery = scanProjectFiles(root).finally(() => {
    if (activeDiscoveries.get(key) === discovery) activeDiscoveries.delete(key);
  });
  activeDiscoveries.set(key, discovery);
  return discovery;
}

export async function canonicalRoot(root: string) {
  try {
    return await realpath(root);
  } catch {
    return resolve(root);
  }
}

async function scanProjectFiles(root: string): Promise<ProjectFileDiscovery> {
  const state = discoveryState(root);
  const pending: PendingDirectory[] = [{ depth: 0, path: "" }];
  while (
    pending.length &&
    state.scannedDirectoryCount < maxScannedDirectories
  ) {
    const remainingDirectories =
      maxScannedDirectories - state.scannedDirectoryCount;
    const batch = pending.splice(
      0,
      Math.min(traversalConcurrency, remainingDirectories),
    );
    await visitDirectoryBatch(state, pending, batch);
  }
  if (pending.length) state.truncated = true;
  return completeDiscovery(state);
}

function discoveryState(root: string): DiscoveryState {
  return {
    root,
    files: [],
    priorityFiles: new Set(),
    rootMarkerFiles: new Set(),
    directories: [],
    repositoryRoots: new Set(),
    ignoredDirectoryCount: 0,
    scannedDirectoryCount: 0,
    truncated: false,
  };
}

async function visitDirectoryBatch(
  state: DiscoveryState,
  pending: PendingDirectory[],
  batch: PendingDirectory[],
) {
  const results = await Promise.all(
    batch.map(async (directory) => ({
      directory,
      entries: await directoryEntries(join(state.root, directory.path)),
    })),
  );
  const childGroups: PendingDirectory[][] = [];
  for (const result of results) {
    state.scannedDirectoryCount += 1;
    if (result.entries.truncated) state.truncated = true;
    childGroups.push(
      visitDirectoryEntries(state, result.directory, result.entries.entries),
    );
  }
  appendDirectoryGroups(pending, childGroups);
}

function visitDirectoryEntries(
  state: DiscoveryState,
  directory: PendingDirectory,
  entries: Dirent[],
) {
  const children: PendingDirectory[] = [];
  const siblingFiles = new Set(
    entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name.toLowerCase()),
  );
  if (directory.path) state.directories.push(directory.path);
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const path = relativePath(directory.path, entry.name);
    if (entry.isDirectory()) {
      visitSubdirectory(state, children, directory, path, siblingFiles);
    }
    if (entry.isFile()) visitFile(state, directory.path, path);
  }
  return children;
}

function appendDirectoryGroups(
  pending: PendingDirectory[],
  groups: PendingDirectory[][],
) {
  const longestGroup = Math.max(0, ...groups.map(({ length }) => length));
  for (let index = 0; index < longestGroup; index += 1) {
    for (const group of groups) {
      const directory = group[index];
      if (directory) pending.push(directory);
    }
  }
}

function visitSubdirectory(
  state: DiscoveryState,
  children: PendingDirectory[],
  parent: PendingDirectory,
  path: string,
  siblingFiles: Set<string>,
) {
  const name = fileName(path);
  if (repositoryDirectoryNames.has(name)) {
    if (name === ".git") state.repositoryRoots.add(parent.path || ".");
    state.ignoredDirectoryCount += 1;
    return;
  }
  if (shouldIgnoreDirectory(name, siblingFiles)) {
    state.ignoredDirectoryCount += 1;
    return;
  }
  if (parent.depth >= maxDirectoryDepth) {
    state.truncated = true;
    return;
  }
  children.push({ path, depth: parent.depth + 1 });
}

function shouldIgnoreDirectory(name: string, siblingFiles: Set<string>) {
  if (ignoredDirectoryNames.has(name)) return true;
  const dependencyMarkers = conditionallyIgnoredDirectories.get(name);
  if (!dependencyMarkers) return false;
  return [...dependencyMarkers].some((marker) => siblingFiles.has(marker));
}

function visitFile(state: DiscoveryState, directory: string, path: string) {
  if (fileName(path) === ".git") {
    state.repositoryRoots.add(directory || ".");
    return;
  }
  if (state.files.length < maxDiscoveredFiles) {
    state.files.push(path);
    return;
  }
  if (isProjectRootMarkerPath(path)) {
    addRootMarkerFile(state, path);
  } else if (isPriorityProjectFilePath(path)) {
    addPriorityFile(state, path);
  }
  state.truncated = true;
}

function addRootMarkerFile(state: DiscoveryState, path: string) {
  if (state.rootMarkerFiles.size < maxRootMarkerFiles) {
    state.rootMarkerFiles.add(path);
    return;
  }
  state.truncated = true;
}

function addPriorityFile(state: DiscoveryState, path: string) {
  if (state.priorityFiles.size < maxPriorityFiles) {
    state.priorityFiles.add(path);
    return;
  }
  state.truncated = true;
}

async function directoryEntries(path: string) {
  const entries: Dirent[] = [];
  let truncated = false;
  try {
    const directory = await opendir(path);
    for await (const entry of directory) {
      if (entries.length >= maxDirectoryEntries) {
        truncated = true;
        break;
      }
      entries.push(entry);
    }
  } catch {
    return { entries, truncated };
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  return { entries, truncated };
}

function completeDiscovery(state: DiscoveryState): ProjectFileDiscovery {
  const files = [
    ...new Set([
      ...state.rootMarkerFiles,
      ...state.priorityFiles,
      ...state.files,
    ]),
  ].sort();
  const repositoryRoots = [...state.repositoryRoots].sort();
  return {
    files,
    directories: [...new Set(state.directories)].sort(),
    projectRoots: deriveProjectRoots(files, repositoryRoots),
    repositoryRoots,
    ignoredDirectoryCount: state.ignoredDirectoryCount,
    scannedDirectoryCount: state.scannedDirectoryCount,
    truncated: state.truncated,
  };
}

function deriveProjectRoots(files: string[], repositoryRoots: string[]) {
  const markers = new Map<string, Set<string>>();
  const rootMarkerPaths = files.filter(isProjectRootMarkerPath);
  for (const root of repositoryRoots) addRootMarker(markers, root, ".git");
  for (const path of rootMarkerPaths) {
    if (isRedundantGeneratedRootMarker(path, rootMarkerPaths)) continue;
    addRootMarker(markers, parentPath(path), path);
  }
  addUnstructuredEntrypointRoots(files, markers);
  if (!markers.size) addRootMarker(markers, ".", "unstructured-source");
  return [...markers.entries()]
    .map(([path, values]) => ({ path, markers: [...values].sort() }))
    .sort(compareProjectRoots);
}

function addUnstructuredEntrypointRoots(
  files: string[],
  markers: Map<string, Set<string>>,
) {
  const nestedRoots = [...markers.keys()].filter((root) => root !== ".");
  const rootDefinesProject = [...(markers.get(".") ?? [])].some(
    (marker) => marker !== ".git",
  );
  for (const path of files.filter(isProjectEntrypointPath)) {
    if (nearestProjectRoot(path, nestedRoots)) continue;
    if (rootDefinesProject) continue;
    addRootMarker(markers, parentPath(path), path);
  }
}

function isRedundantGeneratedRootMarker(path: string, markers: string[]) {
  const generatedDirectory = generatedOutputDirectory(path);
  if (!generatedDirectory || parentPath(path) !== generatedDirectory)
    return false;
  const ancestor = parentPath(generatedDirectory);
  return markers.some(
    (candidate) =>
      candidate !== path &&
      parentPath(candidate) === ancestor &&
      fileName(candidate) === fileName(path),
  );
}

function addRootMarker(
  markers: Map<string, Set<string>>,
  root: string,
  marker: string,
) {
  const values = markers.get(root) ?? new Set<string>();
  values.add(marker);
  markers.set(root, values);
}

function compareProjectRoots(
  left: ProjectRootEvidence,
  right: ProjectRootEvidence,
) {
  const depth = pathDepth(left.path) - pathDepth(right.path);
  return depth || left.path.localeCompare(right.path);
}

export function isProjectManifestPath(path: string) {
  const name = fileName(path);
  return (
    manifestNames.has(name) ||
    /(?:^|\/)(?:Project\.swift|project\.yml)$/.test(path) ||
    /^requirements(?:[-_.].*)?\.txt$/.test(name) ||
    /\.(cabal|csproj|fsproj|vbproj|sln|slnx|gemspec|opam|rockspec|uproject)$/.test(
      name,
    ) ||
    path.toLowerCase().endsWith(".xcodeproj/project.pbxproj")
  );
}

export function isProjectLockFilePath(path: string) {
  return lockFileNames.has(fileName(path));
}

export function isProjectConfigurationPath(path: string) {
  const name = fileName(path);
  const lower = path.toLowerCase();
  if (isProjectManifestPath(path) || isProjectLockFilePath(path)) return false;
  if (name.endsWith(".tsbuildinfo")) return false;
  if (/(^|\/)\.github\/workflows\//.test(lower)) return /\.ya?ml$/.test(name);
  return configurationName(name, lower);
}

export function isRuntimeEvidencePath(path: string) {
  const name = fileName(path);
  return (
    runtimeRootNames.has(name) ||
    nativeProjectEvidence(path) ||
    runtimePinNames.has(name) ||
    workspaceMarkerNames.has(name) ||
    isEnvironmentTemplatePath(path) ||
    runtimeConfigurationName(name, path.toLowerCase())
  );
}

function runtimeConfigurationName(name: string, path: string) {
  return (
    /^(adonisrc|angular\.json|appsettings|application\.|astro\.config|bunfig|config\.ru|dockerfile|electron-vite\.config|fly\.toml|lerna\.json|melos\.yaml|netlify\.toml|next\.config|nuxt\.config|nx\.json|railway\.json|render\.yaml|rocket\.toml|rush\.json|samconfig|serverless|svelte\.config|turbo\.json|vercel\.json|vite\.config|webpack\.config|workspace\.json|wrangler\.toml)/.test(
      name,
    ) ||
    /(^|\/)(config|start)\/(env|routes)\.[^/]+$/.test(path) ||
    /(^|\/)(scripts?\/)?(bootstrap|dev|develop|run|serve|start)\.(bat|cmd|ps1|sh)$/.test(
      path,
    ) ||
    /(^|\/)properties\/launchsettings\.json$/.test(path)
  );
}

export function isEnvironmentTemplatePath(path: string) {
  const name = fileName(path);
  return (
    /^\.env(?:\.[a-z0-9_-]+)*\.(example|sample|template)$/.test(name) ||
    /^(example|sample|template)\.env(?:\.[a-z0-9_-]+)*$/.test(name) ||
    /^[a-z0-9_-]+\.env\.(example|sample|template)$/.test(name) ||
    /^\.env\.(example|sample|template)$/.test(name)
  );
}

export function isSourceCodePath(path: string) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".d.ts")) return false;
  if (fileName(path) === "artisan") return true;
  return sourceExtensions.has(extname(lower));
}

export function isTestCodePath(path: string) {
  const lower = path.toLowerCase();
  const name = fileName(path);
  if (/(^|\/)(__tests__|tests?|specs?)(\/|$)/.test(lower)) return true;
  if (/\.(test|spec|tests)\.[^/]+$/.test(lower)) return true;
  if (/^(test_[^/]+|[^/]+_test)\.[^/]+$/.test(name)) return true;
  return /(?:tests?|specs?)\.(cs|fs|vb|java|kt)$/.test(name);
}

export function isArchitectureCodePath(path: string) {
  return /(^|\/)(adapters?|application|controllers?|core|domain|entities|handlers?|infrastructure|ports?|presentation|repositories|repository|services?|use[-_]?cases?)(\/|\.|-|_)/i.test(
    path,
  );
}

export function isProjectEntrypointPath(path: string) {
  const lower = path.toLowerCase();
  const name = fileName(path);
  if (/^(app|application|main|program|server|startup|index)\.[^/]+$/.test(name))
    return isSourceCodePath(path) || /\.html?$/.test(name);
  return /(^|\/)(__main__\.py|manage\.py|wsgi\.py|asgi\.py|artisan|config\.ru|bin\/console|src\/main\.rs|lib\/main\.dart|public\/index\.php|web\/index\.html)$/.test(
    lower,
  );
}

export function isProjectDocumentationPath(path: string) {
  return /^(readme|getting-started)(\.[a-z0-9_-]+)?\.md$/i.test(fileName(path));
}

export function isDatabaseEvidencePath(path: string) {
  return /(^|\/)(alembic|db\/migrate|drizzle|migrations?|prisma|priv\/repo\/migrations)(\/|$)/i.test(
    path,
  );
}

export function isMigrationEvidencePath(path: string) {
  return /(^|\/)(alembic\/versions|db\/migrate|drizzle\/migrations?|migrations?|priv\/repo\/migrations)(\/|$)/i.test(
    path,
  );
}

function isProjectRootMarkerPath(path: string) {
  const name = fileName(path);
  return (
    isProjectManifestPath(path) ||
    runtimeRootNames.has(name) ||
    workspaceMarkerNames.has(name)
  );
}

function isPriorityProjectFilePath(path: string) {
  return (
    isProjectRootMarkerPath(path) ||
    isProjectLockFilePath(path) ||
    isProjectConfigurationPath(path) ||
    isRuntimeEvidencePath(path) ||
    isProjectEntrypointPath(path) ||
    isTestCodePath(path) ||
    isProjectDocumentationPath(path) ||
    isDatabaseEvidencePath(path)
  );
}

export function selectBalancedProjectPaths(
  paths: string[],
  projectRoots: ProjectRootEvidence[],
  limit: number,
  compare: (left: string, right: string) => number = compareShortPaths,
) {
  const groups = projectPathGroups(paths, projectRoots, compare);
  return takeBalancedGroups(groups, limit);
}

export function preferNonGeneratedProjectPaths(
  paths: string[],
  projectRoots: ProjectRootEvidence[],
) {
  const groups = new Map<string, string[]>();
  for (const path of paths) {
    const groupName = projectPreferenceGroup(path, projectRoots);
    const group = groups.get(groupName) ?? [];
    group.push(path);
    groups.set(groupName, group);
  }
  return [...groups.values()].flatMap(preferredProjectPaths);
}

function projectPreferenceGroup(path: string, roots: ProjectRootEvidence[]) {
  const root = nearestProjectRoot(
    path,
    roots.map(({ path }) => path),
  );
  return root ?? projectPathGroup(path, roots);
}

function preferredProjectPaths(paths: string[]) {
  const sourcePaths = paths.filter((path) => !isGeneratedOutputPath(path));
  return sourcePaths.length ? sourcePaths : paths;
}

export function isGeneratedOutputPath(path: string) {
  if (path.toLowerCase().endsWith(".map")) return true;
  return generatedOutputAncestor(path) !== undefined;
}

function generatedOutputAncestor(path: string) {
  const directory = generatedOutputDirectory(path);
  return directory ? parentPath(directory) : undefined;
}

function generatedOutputDirectory(path: string) {
  const directories = path.toLowerCase().split("/").slice(0, -1);
  const generatedIndex = directories.findIndex((directory) =>
    generatedOutputDirectoryNames.has(directory),
  );
  if (generatedIndex < 0) return undefined;
  return directories.slice(0, generatedIndex + 1).join("/");
}

export function takeBalancedGroups(groups: string[][], limit: number) {
  const selected: string[] = [];
  let foundPath = true;
  while (selected.length < limit && foundPath) {
    foundPath = takeGroupRound(groups, selected, limit);
  }
  return selected;
}

function projectPathGroups(
  paths: string[],
  projectRoots: ProjectRootEvidence[],
  compare: (left: string, right: string) => number,
) {
  const groups = new Map<string, string[]>();
  for (const path of [...new Set(paths)].sort(compare)) {
    const groupName = projectPathGroup(path, projectRoots);
    const group = groups.get(groupName) ?? [];
    group.push(path);
    groups.set(groupName, group);
  }
  return [...groups.values()];
}

function takeGroupRound(groups: string[][], selected: string[], limit: number) {
  const initialLength = selected.length;
  for (const group of groups) {
    const path = group.shift();
    if (path) selected.push(path);
    if (selected.length >= limit) break;
  }
  return selected.length > initialLength;
}

function projectPathGroup(path: string, roots: ProjectRootEvidence[]) {
  const root = nearestProjectRoot(
    path,
    roots.map(({ path }) => path),
  );
  if (root && root !== ".") return root;
  const firstSegment = path.split("/")[0];
  return firstSegment && path.includes("/") ? firstSegment : ".";
}

function nearestProjectRoot(path: string, roots: string[]) {
  return roots
    .filter(
      (root) => root === "." || path === root || path.startsWith(`${root}/`),
    )
    .sort((left, right) => pathDepth(right) - pathDepth(left))[0];
}

export function fileCountsByExtension(paths: string[]) {
  return paths.reduce<Record<string, number>>((counts, path) => {
    const extension = extname(path).toLowerCase() || "[no extension]";
    counts[extension] = (counts[extension] ?? 0) + 1;
    return counts;
  }, {});
}

export function projectDirectories(paths: string[]) {
  const directories = new Set<string>();
  for (const path of paths) addParentDirectories(directories, path);
  return [...directories].sort().slice(0, 500);
}

function addParentDirectories(directories: Set<string>, path: string) {
  const parts = parentPath(path)
    .split("/")
    .filter((part) => part !== ".");
  for (let depth = 1; depth <= Math.min(parts.length, 5); depth += 1) {
    directories.add(parts.slice(0, depth).join("/"));
  }
}

export function topLevelProjectEntries(discovery: ProjectFileDiscovery) {
  const directories = new Set(
    discovery.directories.map((path) => path.split("/")[0]).filter(Boolean),
  );
  const files = discovery.files.filter((path) => !path.includes("/"));
  return [...[...directories].map((path) => `${path}/`), ...files]
    .sort()
    .slice(0, 100);
}

function compareShortPaths(left: string, right: string) {
  return left.length - right.length || left.localeCompare(right);
}

function parentPath(path: string) {
  const parent = dirname(path).replaceAll("\\", "/");
  return parent === "" ? "." : parent;
}

function pathDepth(path: string) {
  return path === "." ? 0 : path.split("/").length;
}

export function fileName(path: string) {
  return path.split("/").at(-1)?.toLowerCase() ?? "";
}

function relativePath(directory: string, name: string) {
  return directory ? `${directory}/${name}` : name;
}
