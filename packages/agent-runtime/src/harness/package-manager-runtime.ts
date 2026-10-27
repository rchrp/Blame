import { constants } from "node:fs";
import { access, readFile, readdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { execa } from "execa";

export type PackageManagerName = "bun" | "npm" | "pnpm" | "yarn";
export type PackageManagerCompatibility = "exact" | "pnpm_same_major";

export type ResolvedPackageManager = {
  argsPrefix: string[];
  executable: string;
  readonlyRoots: string[];
  requestedVersion?: string;
  resolvedVersion: string;
  resolutionStrategy: "compatible_same_major" | "exact" | "unversioned";
};

type PackageManagerCandidate = Pick<
  ResolvedPackageManager,
  "argsPrefix" | "executable" | "readonlyRoots" | "resolvedVersion"
>;

type PackageManagerRequest = {
  compatibility?: PackageManagerCompatibility;
  name: PackageManagerName;
  version?: string;
};

const require = createRequire(import.meta.url);
const managedPackageNames = new Set<PackageManagerName>([
  "npm",
  "pnpm",
  "yarn",
]);

export async function resolvePackageManager(
  input: PackageManagerRequest,
): Promise<ResolvedPackageManager> {
  const exact = await exactManager(input);
  if (exact)
    return resolvedManager(
      exact,
      input,
      input.version ? "exact" : "unversioned",
    );
  const compatible = await compatibleManager(input);
  if (compatible)
    return resolvedManager(compatible, input, "compatible_same_major");
  const identity = input.version
    ? `${input.name}@${input.version}`
    : input.name;
  const compatibility =
    input.compatibility === "pnpm_same_major"
      ? " No trusted stable pnpm from the requested major is available."
      : "";
  throw new Error(
    `PACKAGE_MANAGER_UNAVAILABLE:${identity} is not provisioned in this runtime.${compatibility} Corepack and package-manager self-downloads are disabled.`,
  );
}

async function exactManager(input: PackageManagerRequest) {
  if (!input.version)
    return (
      (await defaultProvisionedManager(input.name)) ??
      (await systemManager(input)) ??
      (await bundledManager(input))
    );
  return (
    (await provisionedManager(input)) ??
    (await bundledManager(input)) ??
    (await systemManager(input))
  );
}

async function defaultProvisionedManager(name: PackageManagerName) {
  const candidates = await provisionedManagerCandidates(name);
  return candidates.sort(compareVersionsDescending)[0];
}

function compareVersionsDescending(
  left: PackageManagerCandidate,
  right: PackageManagerCandidate,
) {
  return right.resolvedVersion.localeCompare(left.resolvedVersion, undefined, {
    numeric: true,
  });
}

async function provisionedManager(input: PackageManagerRequest) {
  if (!input.version) return undefined;
  for (const root of packageManagerRoots()) {
    const executable = join(root, input.name, input.version, "bin", input.name);
    if (
      (await executableFile(executable)) &&
      (await managerVersion(executable)) === input.version
    )
      return {
        executable,
        argsPrefix: [],
        readonlyRoots: [dirname(dirname(executable))],
        resolvedVersion: input.version,
      };
  }
  return undefined;
}

async function bundledManager(input: PackageManagerRequest) {
  if (!managedPackageNames.has(input.name)) return undefined;
  const current = await bundledManagerPackage(input, input.name);
  return (
    current ??
    (["npm", "pnpm"].includes(input.name)
      ? bundledManagerPackage(input, `${input.name}-legacy`)
      : undefined)
  );
}

async function bundledManagerPackage(
  input: PackageManagerRequest,
  packageName: string,
) {
  const resolvedManifestPath = bundledManifestPath(packageName);
  if (!resolvedManifestPath) return undefined;
  const manifestPath = await physicalBundledPath(resolvedManifestPath);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    bin?: Record<string, string> | string;
    version?: string;
  };
  if (
    !manifest.version ||
    (input.version && manifest.version !== input.version)
  )
    return undefined;
  const entry = managerBin(manifest.bin, input.name);
  if (!entry) return undefined;
  const packageRoot = dirname(manifestPath);
  if (input.name === "pnpm" && Number(manifest.version.split(".")[0]) >= 11) {
    // Resolve only the installed native binary; never invoke the downloading wrapper.
    const native = await import(
      pathToFileURL(join(packageRoot, "native-binary.mjs")).href
    );
    const installed: string | null = native.resolveInstalledBinary();
    if (!installed) return undefined;
    const executable = await realpath(await physicalBundledPath(installed));
    if (!(await executableFile(executable))) return undefined;
    return {
      executable,
      argsPrefix: [],
      readonlyRoots: [packageRoot, dirname(executable)],
      resolvedVersion: manifest.version,
    };
  }
  const executable = await resolveStableNodeExecutable();
  if (!executable) return undefined;
  return {
    executable,
    argsPrefix: [join(packageRoot, entry)],
    readonlyRoots: [packageRoot, dirname(executable)],
    resolvedVersion: manifest.version,
  };
}

export async function physicalBundledPath(path: string) {
  if (!path.includes("app.asar")) return path;
  const unpacked = path.replace(/app\.asar(?=[/\\])/u, "app.asar.unpacked");
  return (await readableFile(unpacked)) ? unpacked : path;
}

export async function resolveStableNodeExecutable(
  environment: NodeJS.ProcessEnv = process.env,
  processExecutable = process.execPath,
  platform = process.platform,
) {
  for (const candidate of nodeExecutableCandidates(
    environment,
    processExecutable,
    platform,
  )) {
    const executable = await resolvedExecutable(candidate, environment);
    if (executable && !temporaryRuntimePath(executable, platform))
      return executable;
  }
  return undefined;
}

export function nodeExecutableCandidates(
  environment: NodeJS.ProcessEnv,
  processExecutable: string,
  platform: NodeJS.Platform,
) {
  const configured = environment.BLAME_NODE_EXECUTABLE?.trim();
  const system = platform === "linux" ? ["/usr/bin/node", "/bin/node"] : [];
  const path = (environment.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((root) => join(resolve(root), "node"));
  return [
    ...new Set([configured, ...system, ...path, processExecutable]),
  ].filter((candidate): candidate is string => Boolean(candidate));
}

async function resolvedExecutable(
  candidate: string,
  environment: NodeJS.ProcessEnv,
) {
  if (candidate.includes("/") || candidate.includes("\\")) {
    return (await executableFile(candidate)) ? realpath(candidate) : undefined;
  }
  for (const root of (environment.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)) {
    const path = join(root, candidate);
    if (await executableFile(path)) return realpath(path);
  }
  return undefined;
}

function temporaryRuntimePath(path: string, platform: NodeJS.Platform) {
  if (platform !== "linux") return false;
  const temporaryRoot = `${resolve(tmpdir())}/`;
  return resolve(path).startsWith(temporaryRoot);
}

function bundledManifestPath(name: string) {
  try {
    if (name === "pnpm") {
      try {
        return require.resolve("pnpm/package.json");
      } catch {
        return require.resolve("pnpm");
      }
    }
    if (name === "pnpm-legacy") return require.resolve("pnpm-legacy");
    if (name === "npm-legacy")
      return require.resolve("npm-legacy/package.json");
    if (name === "npm")
      return join(dirname(require.resolve("npm")), "package.json");
    if (name === "yarn") return require.resolve("yarn/package.json");
    return undefined;
  } catch {
    return undefined;
  }
}

function managerBin(
  value: Record<string, string> | string | undefined,
  name: PackageManagerName,
) {
  if (typeof value === "string") return value;
  return value?.[name];
}

async function systemManager(input: PackageManagerRequest) {
  for (const root of systemPathRoots()) {
    const candidate = join(root, input.name);
    if (!(await executableFile(candidate))) continue;
    const executable = await realpath(candidate);
    if (isCorepackShim(executable)) continue;
    const resolvedVersion = await managerVersion(executable);
    if (
      !resolvedVersion ||
      (input.version && resolvedVersion !== input.version)
    )
      continue;
    return {
      executable,
      argsPrefix: [],
      readonlyRoots: [dirname(executable)],
      resolvedVersion,
    };
  }
  return undefined;
}

async function managerVersion(executable: string) {
  const result = await execa(executable, ["--version"], {
    reject: false,
    timeout: 5_000,
    stdin: "ignore",
  });
  return result.failed ? undefined : String(result.stdout).trim();
}

async function compatibleManager(input: PackageManagerRequest) {
  if (
    input.name !== "pnpm" ||
    input.compatibility !== "pnpm_same_major" ||
    !input.version
  )
    return undefined;
  const compatibility = input.compatibility;
  const requestedVersion = input.version;
  const requested = semanticVersion(requestedVersion);
  if (!requested) return undefined;
  const candidates = await compatibleCandidates(input.name);
  return candidates
    .filter((candidate) =>
      packageManagerVersionsCompatible({
        candidateVersion: candidate.resolvedVersion,
        compatibility,
        name: input.name,
        requestedVersion,
      }),
    )
    .sort((left, right) =>
      compareCandidateProximity(left, right, requested),
    )[0];
}

export function packageManagerVersionsCompatible(input: {
  candidateVersion: string;
  compatibility: PackageManagerCompatibility;
  name: PackageManagerName;
  requestedVersion: string;
}) {
  if (input.name !== "pnpm" || input.compatibility !== "pnpm_same_major")
    return false;
  const requested = semanticVersion(input.requestedVersion);
  const candidate = semanticVersion(input.candidateVersion);
  return Boolean(requested && candidate && requested.major === candidate.major);
}

async function compatibleCandidates(name: PackageManagerName) {
  const provisioned = await provisionedManagerCandidates(name);
  const bundled = await bundledManager({ name });
  const legacy =
    name === "pnpm"
      ? await bundledManagerPackage({ name }, "pnpm-legacy")
      : undefined;
  const system = await systemManager({ name });
  return uniqueCandidates([
    ...provisioned,
    ...(bundled ? [bundled] : []),
    ...(legacy ? [legacy] : []),
    ...(system ? [system] : []),
  ]);
}

async function provisionedManagerCandidates(name: PackageManagerName) {
  const candidates: PackageManagerCandidate[] = [];
  for (const root of packageManagerRoots()) {
    const versions = await directoryNames(join(root, name));
    for (const version of versions) {
      const candidate = await provisionedManager({ name, version });
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates;
}

function resolvedManager(
  candidate: PackageManagerCandidate,
  input: PackageManagerRequest,
  resolutionStrategy: ResolvedPackageManager["resolutionStrategy"],
): ResolvedPackageManager {
  return {
    ...candidate,
    ...(input.version ? { requestedVersion: input.version } : {}),
    resolutionStrategy,
  };
}

function semanticVersion(value: string) {
  const match = value.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u);
  if (!match) return undefined;
  const [major, minor, patch] = match.slice(1).map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) return undefined;
  return {
    major,
    minor,
    patch,
  };
}

function compareCandidateProximity(
  left: PackageManagerCandidate,
  right: PackageManagerCandidate,
  requested: NonNullable<ReturnType<typeof semanticVersion>>,
) {
  const leftVersion = semanticVersion(left.resolvedVersion)!;
  const rightVersion = semanticVersion(right.resolvedVersion)!;
  const minorDifference =
    Math.abs(leftVersion.minor - requested.minor) -
    Math.abs(rightVersion.minor - requested.minor);
  if (minorDifference !== 0) return minorDifference;
  return (
    Math.abs(leftVersion.patch - requested.patch) -
    Math.abs(rightVersion.patch - requested.patch)
  );
}

function uniqueCandidates(candidates: PackageManagerCandidate[]) {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.executable}\0${candidate.resolvedVersion}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function directoryNames(path: string) {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function packageManagerRoots() {
  const configured = process.env.BLAME_PACKAGE_MANAGER_ROOT?.trim();
  return [
    ...new Set([configured, "/opt/blame/package-managers"].filter(Boolean)),
  ] as string[];
}

function systemPathRoots() {
  return (process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin")
    .split(delimiter)
    .filter(Boolean)
    .map((path) => resolve(path));
}

function isCorepackShim(path: string) {
  return /(?:^|[/\\])corepack(?:[/\\]|$)/iu.test(path);
}

async function executableFile(path: string) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function readableFile(path: string) {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
