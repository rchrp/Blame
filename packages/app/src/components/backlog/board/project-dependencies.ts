import { terminalText } from "../../../lib/terminal-text.ts"

// Whether the Node packages a run configuration needs are installed, read
// from the project folder, and the signs of missing ones in its output. The
// runner uses it to offer the install instead of leaving a bare error in
// the logs.

export type DependencyManager = "pnpm" | "npm" | "yarn" | "bun"

export type ProjectDependencies = {
  manager: DependencyManager
  // Where the install runs, relative to the project ("" for its root): the
  // folder with the lockfile (a workspace root), or the package's own one.
  root: string
  // The package the configuration runs, relative to the project.
  packageDir: string
  // Every package name its manifests (and the root's) declare.
  declared: string[]
  // Nothing installed yet: no node_modules (or Yarn PnP files).
  missing: boolean
}

export type DependencyFiles = {
  // Paths are relative to the project ("" for its root).
  exists(path: string): Promise<boolean>
  read(path: string): Promise<string | undefined>
}

type Manifest = {
  dependencies?: Record<string, unknown>
  devDependencies?: Record<string, unknown>
  optionalDependencies?: Record<string, unknown>
  packageManager?: unknown
  workspaces?: unknown
}

const managers: DependencyManager[] = ["pnpm", "npm", "yarn", "bun"]
const lockfiles: [string, DependencyManager][] = [
  ["pnpm-lock.yaml", "pnpm"],
  ["pnpm-workspace.yaml", "pnpm"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
]

export async function projectDependencies(
  files: DependencyFiles,
  input: { cwd: string; command: string }
): Promise<ProjectDependencies | undefined> {
  const segments = folderSegments(input.cwd)
  if (!segments) return undefined
  // From the configuration's folder up to the project's root.
  const folders = segments.map((_, index) =>
    segments.slice(0, segments.length - index).join("/")
  )
  folders.push("")
  let packageIndex = -1
  for (const [index, folder] of folders.entries()) {
    if (await files.exists(join(folder, "package.json"))) {
      packageIndex = index
      break
    }
  }
  if (packageIndex < 0) return undefined
  const packageDir = folders[packageIndex]!
  let root = packageDir
  let lockManager: DependencyManager | undefined
  search: for (const folder of folders.slice(packageIndex)) {
    for (const [file, manager] of lockfiles) {
      if (await files.exists(join(folder, file))) {
        root = folder
        lockManager = manager
        break search
      }
    }
  }
  const packageManifest = await readManifest(files, packageDir)
  const rootManifest =
    root === packageDir ? packageManifest : await readManifest(files, root)
  const declared = [
    ...new Set([
      ...declaredPackages(packageManifest),
      ...declaredPackages(rootManifest),
    ]),
  ]
  if (!declared.length && !rootManifest?.workspaces) return undefined
  const manager =
    declaredManager(rootManifest?.packageManager) ??
    declaredManager(packageManifest?.packageManager) ??
    lockManager ??
    commandManager(input.command) ??
    "npm"
  // node_modules alone proves nothing (Vite keeps its cache there): one of
  // the package's own dependencies must be in it, where the manager links
  // it (the package's folder for pnpm, the root when hoisted).
  const ownPackages = declaredPackages(packageManifest)
  const probes = (
    ownPackages.length ? ownPackages : declaredPackages(rootManifest)
  ).slice(0, 3)
  const installed =
    (await files.exists(join(root, ".pnp.cjs"))) ||
    (await files.exists(join(root, ".pnp.js"))) ||
    (probes.length
      ? await anyInstalled(files, [packageDir, root], probes)
      : await files.exists(join(root, "node_modules")))
  return {
    manager,
    root,
    packageDir,
    declared,
    missing: !installed,
  }
}

export function dependencyInstallCommand(manager: DependencyManager) {
  // pnpm would otherwise stop to ask before rebuilding node_modules, and
  // nobody types in the runner's logs.
  return manager === "pnpm"
    ? "pnpm install --config.confirm-modules-purge=false"
    : `${manager} install`
}

// The packages among these that the project declares but that are not in
// node_modules: an install brings them. Others are the code's own mistakes.
export async function packagesNotInstalled(
  files: DependencyFiles,
  dependencies: ProjectDependencies,
  names: string[]
) {
  const result: string[] = []
  for (const name of names) {
    if (!dependencies.declared.includes(name)) continue
    const installed =
      (await files.exists(
        join(dependencies.packageDir, `node_modules/${name}`)
      )) ||
      (await files.exists(join(dependencies.root, `node_modules/${name}`)))
    if (!installed) result.push(name)
  }
  return result
}

// Packages the output says it cannot find, by name ("react-dom" for
// "react-dom/client"). Relative imports and Node's own modules are left out:
// installing would not bring them.
export function missingPackagesInOutput(output: string) {
  const text = terminalText(output)
  const names = new Set<string>()
  for (const pattern of missingPackagePatterns) {
    for (const match of text.matchAll(pattern)) {
      const name = packageName(match[1] ?? "")
      if (name) names.add(name)
    }
  }
  return [...names]
}

// pnpm 11 stops (ERR_PNPM_IGNORED_BUILDS) until someone decides about the
// build scripts it skipped. The packages it names, without their versions.
export function blockedBuildScripts(output: string) {
  const list =
    /ERR_PNPM_IGNORED_BUILDS\]?:?\s*Ignored build scripts: ([^\n]+)/.exec(
      terminalText(output)
    )?.[1]
  if (!list) return []
  const names = list
    .split(/,\s*/)
    .map((item) => item.trim().replace(/\.$/, ""))
    .map((item) => packageName(item.replace(/(.)@[^@/]*$/, "$1")))
  return [...new Set(names.filter((name): name is string => Boolean(name)))]
}

export function approveBuildsCommand(packages: string[]) {
  return `pnpm approve-builds ${packages.join(" ")}`
}

// pnpm says it outright when a script runs before any install.
export function outputSaysNothingInstalled(output: string) {
  return /node_modules missing, did you mean to install/i.test(
    terminalText(output)
  )
}

const missingPackagePatterns = [
  // Node: require and import.
  /Cannot find (?:module|package) '([^']+)'/g,
  // Vite's import analysis.
  /Failed to resolve import "([^"]+)"/g,
  // Vite's dependency scan: "  react-router (imported by …)".
  /^\s+(\S+) \(imported by [^)]*\)$/gm,
  // webpack, Next.js.
  /Module not found: (?:Error: )?Can't resolve '([^']+)'/g,
]

export function packageName(specifier: string) {
  const value = specifier.trim()
  if (!value || /^[./\\~#]|^[a-z]:/i.test(value) || value.startsWith("node:"))
    return undefined
  const parts = value.split("/")
  const name = value.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!
  if (!/^(?:@[\w.-]+\/)?[\w.-]+$/.test(name)) return undefined
  return name
}

// What the install output shows: pnpm counts the packages it adds, the
// others only say what they are doing.
export function dependencyInstallProgress(output: string) {
  const lines = terminalText(output.slice(-8_000))
    .split("\n")
    // npm and others draw a spinner before what they are doing.
    .map((line) => line.replace(/^[\u2800-\u28ff]+/, "").trim())
    .filter(Boolean)
  const detail = lines.at(-1)?.slice(0, 120)
  const total = lastNumber(lines, /^Packages: \+(\d+)/)
  const added = lastNumber(lines, /^Progress: resolved \d+.*\badded (\d+)/)
  const percent =
    total && added !== undefined
      ? Math.min(99, Math.round((added / total) * 100))
      : undefined
  return { detail, percent }
}

// The line that says why an install failed, for its notification.
export function dependencyInstallFailure(output: string) {
  const lines = terminalText(output.slice(-16_000))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && line !== "exit")
  // An error code first (pnpm's ERR_PNPM_…, npm's "npm error"), then any
  // line about an error.
  const error =
    lines.findLast((line) => /\bERR_|\bERR!|^(?:npm )?error\b/i.test(line)) ??
    lines.findLast((line) => /\berror\b|\bfailed\b/i.test(line))
  return (error ?? lines.at(-1))?.slice(0, 200)
}

function lastNumber(lines: string[], pattern: RegExp) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = pattern.exec(lines[index]!)
    if (match) return Number(match[1])
  }
  return undefined
}

async function anyInstalled(
  files: DependencyFiles,
  folders: string[],
  names: string[]
) {
  for (const folder of new Set(folders))
    for (const name of names)
      if (await files.exists(join(folder, `node_modules/${name}`))) return true
  return false
}

async function readManifest(files: DependencyFiles, folder: string) {
  const text = await files.read(join(folder, "package.json"))
  if (!text) return undefined
  try {
    const value: unknown = JSON.parse(text)
    return value && typeof value === "object" ? (value as Manifest) : undefined
  } catch {
    return undefined
  }
}

function declaredPackages(manifest: Manifest | undefined) {
  if (!manifest) return []
  return [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.optionalDependencies,
  ].flatMap((group) =>
    group && typeof group === "object" ? Object.keys(group) : []
  )
}

function declaredManager(value: unknown) {
  if (typeof value !== "string") return undefined
  const name = value.split("@")[0]
  return managers.find((manager) => manager === name)
}

function commandManager(command: string) {
  const first = command.trim().split(/\s+/)[0]
  return managers.find((manager) => manager === first)
}

// The configuration's folder as path segments, or undefined when it leaves
// the project.
function folderSegments(cwd: string) {
  const segments = cwd.split(/[\\/]+/).filter((part) => part && part !== ".")
  if (segments.includes("..") || /^[a-z]:$/i.test(segments[0] ?? ""))
    return undefined
  if (/^[\\/]/.test(cwd)) return undefined
  return segments
}

function join(folder: string, name: string) {
  return folder ? `${folder}/${name}` : name
}
