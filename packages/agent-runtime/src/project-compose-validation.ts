import type { ProjectInitializationScan } from "./project-initialization-scan.js";
import type { PreviewManifest } from "./types.js";
import {
  hostOrchestratedManifestCommand,
  hostOrchestrationError,
} from "./project-host-orchestration.js";

export function validateDockerCompose(
  compose: string,
  scan?: ProjectInitializationScan,
  manifest?: PreviewManifest,
) {
  const duplicateKey = duplicateYamlMappingKey(compose);
  if (duplicateKey) {
    throw new Error(
      `Initialization result dockerCompose must not define duplicate YAML key "${duplicateKey}" in the same mapping`,
    );
  }
  if (!compose.includes("services:")) {
    throw new Error("Initialization result dockerCompose must define services");
  }
  const hostOrchestration =
    scan && manifest && hostOrchestratedManifestCommand(manifest, scan.files);
  if (hostOrchestration) {
    throw new Error(hostOrchestrationError(hostOrchestration));
  }
  if (usesManualHostPort(compose)) {
    throw new Error(
      "Initialization result dockerCompose must let the runtime allocate host ports",
    );
  }
  if (
    requiresRuntimeAllocatedPort(manifest) &&
    !hasRuntimeAllocatedPortMapping(compose)
  ) {
    throw new Error(
      "Initialization result dockerCompose must expose runtime-allocated host ports",
    );
  }
  if (forcesHostUidUser(compose)) {
    throw new Error(
      "Initialization result dockerCompose must not force BLAME_HOST_UID as the container user",
    );
  }
  if (!previewWorkspaceMountsProject(compose)) {
    throw new Error(
      "Initialization result dockerCompose preview service must mount the project source at /workspace",
    );
  }
  if (missingNodeDependencyInstall(compose, scan, manifest)) {
    throw new Error(
      "Initialization result dockerCompose must install detected Node dependencies before starting services",
    );
  }
  if (usesNuxtPreviewWithoutBuild(compose, scan, manifest)) {
    throw new Error(
      "Initialization result dockerCompose must build Nuxt before running its preview script or use the development script",
    );
  }
  if (seedsPrismaWithoutGeneratedClient(compose, scan, manifest)) {
    throw new Error(
      "Initialization result dockerCompose must generate the Prisma client in a setup task (for example `prisma generate` or the project's db:generate script) before running database seeds",
    );
  }
  if (usesUnescapedContainerHome(compose)) {
    throw new Error(
      "Initialization result dockerCompose must escape container HOME references as $$HOME or $${HOME}",
    );
  }
  if (overridesEnvironmentDrivenServeCommand(compose)) {
    throw new Error(
      "Initialization result dockerCompose must not append host or port flags to serve commands when HOST and PORT environment variables are already configured",
    );
  }
  if (usesInterpolatedContainerHost(compose)) {
    throw new Error(
      "Initialization result dockerCompose must bind preview services to a literal 0.0.0.0 instead of preserving an existing HOST value",
    );
  }
  if (usesInterpolatedServiceUrl(compose)) {
    throw new Error(
      "Initialization result dockerCompose must use literal service URLs for inter-container runtime configuration instead of preserving existing localhost values",
    );
  }
  if (
    requiresDatabaseMigration(compose, scan, manifest) &&
    !runsDatabaseMigration(compose)
  ) {
    throw new Error(
      "Initialization result dockerCompose must run detected database migrations before starting backend services",
    );
  }
  if (usesBarePnpm(compose)) {
    throw new Error(
      "Initialization result dockerCompose must run pnpm through corepack",
    );
  }
  if (usesNpmCi(compose)) {
    throw new Error(
      "Initialization result dockerCompose must use npm install --no-package-lock instead of npm ci",
    );
  }
  if (usesNumericSuUser(compose)) {
    throw new Error(
      "Initialization result dockerCompose must not run commands through su with numeric BLAME_HOST_UID users",
    );
  }
  if (
    usesNodeModulesVolumes(compose) &&
    !initializesNodeModulesVolumes(compose)
  ) {
    throw new Error(
      "Initialization result dockerCompose must make node_modules volumes writable by the host user before package installs",
    );
  }
}

function requiresRuntimeAllocatedPort(manifest: PreviewManifest | undefined) {
  if (!manifest) return true;
  return manifest.services.some(({ kind }) => kind === "preview");
}

export function launchesCompose(script: string) {
  return composeCommandPresent(script) && composeLifecyclePresent(script);
}

export function requiresDockerRuntime(script: string) {
  return /\b(?:command\s+-v\s+docker|docker\s+--version|docker\s+compose\s+version|docker-compose\s+--version)\b/.test(
    script,
  );
}

function usesUnescapedContainerHome(compose: string) {
  return /(?<!\$)\$(?:home\b|\{home\})/.test(compose);
}

function usesNpmCi(compose: string) {
  return /\bnpm\s+ci\b/.test(compose);
}

function usesManualHostPort(compose: string) {
  return (
    /\$\{[a-z0-9_]*port\}:/.test(compose) ||
    /(?:127\.0\.0\.1|localhost):[0-9]+:[0-9]+/.test(compose)
  );
}

function hasRuntimeAllocatedPortMapping(compose: string) {
  return includesOneOf(compose, ["127.0.0.1::", "localhost::"]);
}

function forcesHostUidUser(compose: string) {
  return /user\s*:\s*["']?\$\{?blame_host_uid\}?/i.test(compose);
}

function previewWorkspaceMountsProject(compose: string) {
  if (
    !compose.includes("blame.preview") ||
    !compose.includes("working_dir: /workspace")
  ) {
    return true;
  }
  return /(?:-\s*[^:\n]+:\s*\/workspace|target:\s*\/workspace)\s*(?:#.*)?$/m.test(
    compose,
  );
}

function missingNodeDependencyInstall(
  compose: string,
  scan: ProjectInitializationScan | undefined,
  manifest: PreviewManifest | undefined,
) {
  if (!scan || !compose.includes("image: node:")) return false;
  const files = relevantInitializationFiles(scan, manifest);
  if (!files.some(([path]) => path.endsWith("package.json"))) {
    return false;
  }
  return !/\b(?:npm\s+(?:ci|install)|corepack\s+pnpm\s+install|yarn\s+install|bun\s+install)\b/.test(
    compose,
  );
}

function usesNuxtPreviewWithoutBuild(
  compose: string,
  scan: ProjectInitializationScan | undefined,
  manifest: PreviewManifest | undefined,
) {
  if (!scan || !/\bnpm\s+run\s+preview\b/.test(compose)) return false;
  const usesNuxt = relevantInitializationFiles(scan, manifest).some(
    ([path, content]) =>
      path.endsWith("package.json") && /"nuxt"\s*:/.test(content.toLowerCase()),
  );
  return usesNuxt && !/\b(?:npm\s+run\s+build|nuxt\s+build)\b/.test(compose);
}

// Seeds import the generated Prisma client, which a fresh worktree lacks until
// `prisma generate` runs; projects often only generate it in their dev script.
function seedsPrismaWithoutGeneratedClient(
  compose: string,
  scan: ProjectInitializationScan | undefined,
  manifest: PreviewManifest | undefined,
) {
  if (
    !scan ||
    !/\b(?:db:seed|prisma\s+db\s+seed|seed\.[cm]?[jt]s)\b/.test(compose)
  )
    return false;
  if (/\b(?:prisma\s+generate|db:generate)\b/.test(compose)) return false;
  const packages = relevantInitializationFiles(scan, manifest).filter(
    ([path]) => path.endsWith("package.json"),
  );
  const usesPrisma = packages.some(([, content]) =>
    /"(?:prisma|@prisma\/client)"\s*:/.test(content),
  );
  const generatesImplicitly = packages.some(([, content]) =>
    /"(?:postinstall|[^"]*seed[^"]*)"\s*:\s*"[^"]*prisma generate/.test(
      content,
    ),
  );
  return usesPrisma && !generatesImplicitly;
}

function usesBarePnpm(compose: string) {
  return /(^|[\s;&|])pnpm\s/.test(compose.replace(/corepack\s+pnpm/g, ""));
}

function usesNumericSuUser(compose: string) {
  return /\bsu\s+-s\s+\/bin\/bash\s+-c\b[\s\S]*['"]#\$\{blame_host_uid\}['"]/.test(
    compose,
  );
}

function overridesEnvironmentDrivenServeCommand(compose: string) {
  if (!/\bhost:\s*0\.0\.0\.0\b/.test(compose)) return false;
  if (!/\bport:\s*[0-9]+\b/.test(compose)) return false;
  return /\b(?:node\s+ace|ace)\s+serve\b[^\n]*(?:--host|--port)\b/.test(
    compose,
  );
}

function usesInterpolatedContainerHost(compose: string) {
  return /\bhost:\s*\$\{host:-0\.0\.0\.0\}/.test(compose);
}

function usesInterpolatedServiceUrl(compose: string) {
  return /\b[a-z0-9_]*(?:api|backend)[a-z0-9_]*url:\s*\$\{[a-z0-9_]+:-http:\/\/[a-z0-9_-]+:[0-9]+[^}]*\}/.test(
    compose,
  );
}

function requiresDatabaseMigration(
  compose: string,
  scan: ProjectInitializationScan | undefined,
  manifest: PreviewManifest | undefined,
) {
  if (!scan || !usesRelationalDatabase(compose)) return false;
  const scopes = initializationEvidenceScopes(manifest);
  if (
    scan.discovery?.migrationPaths.some((path) => pathInScopes(path, scopes))
  ) {
    return true;
  }
  return relevantInitializationFiles(scan, manifest).some(([path, content]) => {
    return path.endsWith("/migrations/") && content.trim().length > 0;
  });
}

function relevantInitializationFiles(
  scan: ProjectInitializationScan,
  manifest: PreviewManifest | undefined,
) {
  const scopes = initializationEvidenceScopes(manifest);
  return Object.entries(scan.files).filter(([path]) =>
    pathInScopes(path, scopes),
  );
}

function initializationEvidenceScopes(manifest: PreviewManifest | undefined) {
  if (!manifest) return ["."];
  const root = normalizedEvidenceScope(manifest.project.root);
  if (root !== ".") return [root];
  const serviceScopes = manifest.services.flatMap(({ workingDir }) =>
    workingDir ? [normalizedEvidenceScope(workingDir)] : [],
  );
  if (serviceScopes.includes(".")) return ["."];
  return serviceScopes.length ? [...new Set(serviceScopes)] : ["."];
}

function normalizedEvidenceScope(path: string | undefined) {
  const normalized = path?.replaceAll("\\", "/").replace(/^\/workspace\/?/, "");
  return normalized?.replace(/^\.\//, "").replace(/\/$/, "") || ".";
}

function pathInScopes(path: string, scopes: string[]) {
  return scopes.some(
    (scope) => scope === "." || path === scope || path.startsWith(`${scope}/`),
  );
}

function usesRelationalDatabase(compose: string) {
  return /\b(?:mysql|mariadb|postgres|postgresql):/.test(compose);
}

function runsDatabaseMigration(compose: string) {
  return /\b(?:migration:run|migrate\s+(?:deploy|dev|up|latest|run)|db:migrate|drizzle-kit\s+migrate|knex\s+migrate:latest)\b/.test(
    compose,
  );
}

function usesNodeModulesVolumes(compose: string) {
  return /:\s*\/[^\n]*node_modules\b|target:\s*\/[^\n]*node_modules\b/.test(
    compose,
  );
}

function initializesNodeModulesVolumes(compose: string) {
  return /\bchown\b[\s\S]*node_modules\b/.test(compose);
}

function composeCommandPresent(value: string) {
  return /docker\s+compose|docker-compose|compose_cmd|docker_compose|compose command|compose binary/.test(
    value,
  );
}

function composeLifecyclePresent(value: string) {
  return /\bup\b|\brun\b|\bstart\b/.test(value);
}

function includesOneOf(value: string, candidates: string[]) {
  return candidates.some((candidate) => value.includes(candidate));
}

function duplicateYamlMappingKey(compose: string) {
  const stack: Array<{ indent: number; keys: Set<string> }> = [
    { indent: -1, keys: new Set() },
  ];
  for (const line of compose.split("\n")) {
    const key = yamlMappingKey(line);
    if (!key) continue;
    while (stack.length > 1 && stack[stack.length - 1].indent >= key.indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    if (parent.keys.has(key.name)) return key.name;
    parent.keys.add(key.name);
    stack.push({ indent: key.indent, keys: new Set() });
  }
  return undefined;
}

function yamlMappingKey(line: string) {
  const match = /^(\s*)([a-z0-9_.-]+):(?:\s|$)/.exec(line);
  if (!match?.[2] || line.trimStart().startsWith("-")) return undefined;
  return { indent: match[1].length, name: match[2] };
}
