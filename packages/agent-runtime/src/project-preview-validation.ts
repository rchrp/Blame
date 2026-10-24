import type { ProjectInitializationScan } from "./project-initialization-scan.js";
import type { PreviewManifest } from "./types.js";
import {
  hostOrchestratedManifestCommand,
  hostOrchestrationError,
} from "./project-host-orchestration.js";

// Checks that an initialized manifest can run its project, from what the
// scan found in the repository. Blame renders and runs the Compose project
// itself, so only what the manifest decides is checked: dependency
// installs, builds, migrations and the values its services read.

export function validatePreviewSetup(
  manifest: PreviewManifest,
  scan?: ProjectInitializationScan,
) {
  const hostOrchestration =
    scan && hostOrchestratedManifestCommand(manifest, scan.files);
  if (hostOrchestration) {
    throw new Error(hostOrchestrationError(hostOrchestration));
  }
  const commands = manifestCommands(manifest);
  if (forcesHostUidUser(manifest)) {
    throw invalid("must not force BLAME_HOST_UID as the container user");
  }
  if (missingNodeDependencyInstall(manifest, commands, scan)) {
    throw invalid(
      "must install detected Node dependencies before starting services",
    );
  }
  if (usesNuxtPreviewWithoutBuild(commands, scan, manifest)) {
    throw invalid(
      "must build Nuxt before running its preview script or use the development script",
    );
  }
  if (seedsPrismaWithoutGeneratedClient(commands, scan, manifest)) {
    throw invalid(
      "must generate the Prisma client in a setup task (for example `prisma generate` or the project's db:generate script) before running database seeds",
    );
  }
  if (overridesEnvironmentDrivenServeCommand(manifest)) {
    throw invalid(
      "must not append host or port flags to serve commands when HOST and PORT environment variables are already configured",
    );
  }
  if (usesInterpolatedContainerHost(manifest)) {
    throw invalid(
      "must bind preview services to a literal 0.0.0.0 instead of preserving an existing HOST value",
    );
  }
  if (usesInterpolatedServiceUrl(manifest)) {
    throw invalid(
      "must use literal service URLs for inter-container runtime configuration instead of preserving existing localhost values",
    );
  }
  if (
    requiresDatabaseMigration(manifest, scan) &&
    !runsDatabaseMigration(commands)
  ) {
    throw invalid(
      "must run detected database migrations before starting backend services",
    );
  }
  // `npm ci` removes node_modules first, which is a mounted volume.
  if (/\bnpm\s+ci\b/.test(commands)) {
    throw invalid("must use npm install --no-package-lock instead of npm ci");
  }
}

function invalid(rule: string) {
  return new Error(`Initialization result previewManifest ${rule}`);
}

function manifestCommands(manifest: PreviewManifest) {
  return [
    ...manifest.setup.map(({ command }) => command),
    ...manifest.services.map(({ command }) => command ?? ""),
  ]
    .join("\n")
    .toLowerCase();
}

function images(manifest: PreviewManifest) {
  return [...manifest.setup, ...manifest.services].map(
    ({ container }) => container.image ?? "",
  );
}

function forcesHostUidUser(manifest: PreviewManifest) {
  return manifest.services.some(({ user }) =>
    /\$\{?blame_host_uid\}?/i.test(user ?? ""),
  );
}

function missingNodeDependencyInstall(
  manifest: PreviewManifest,
  commands: string,
  scan: ProjectInitializationScan | undefined,
) {
  if (!scan || !images(manifest).some((image) => /(?:^|\/)node:/.test(image)))
    return false;
  const files = relevantInitializationFiles(scan, manifest);
  if (!files.some(([path]) => path.endsWith("package.json"))) return false;
  return !/\b(?:npm\s+(?:ci|install)|(?:corepack\s+)?pnpm\s+install|yarn\s+install|bun\s+install)\b/.test(
    commands,
  );
}

function usesNuxtPreviewWithoutBuild(
  commands: string,
  scan: ProjectInitializationScan | undefined,
  manifest: PreviewManifest,
) {
  if (!scan || !/\bnpm\s+run\s+preview\b/.test(commands)) return false;
  const usesNuxt = relevantInitializationFiles(scan, manifest).some(
    ([path, content]) =>
      path.endsWith("package.json") && /"nuxt"\s*:/.test(content.toLowerCase()),
  );
  return usesNuxt && !/\b(?:npm\s+run\s+build|nuxt\s+build)\b/.test(commands);
}

// Seeds import the generated Prisma client, which a fresh worktree lacks until
// `prisma generate` runs; projects often only generate it in their dev script.
function seedsPrismaWithoutGeneratedClient(
  commands: string,
  scan: ProjectInitializationScan | undefined,
  manifest: PreviewManifest,
) {
  if (
    !scan ||
    !/\b(?:db:seed|prisma\s+db\s+seed|seed\.[cm]?[jt]s)\b/.test(commands)
  )
    return false;
  if (/\b(?:prisma\s+generate|db:generate)\b/.test(commands)) return false;
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

function overridesEnvironmentDrivenServeCommand(manifest: PreviewManifest) {
  return manifest.services.some(
    ({ command, environment }) =>
      environment?.HOST === "0.0.0.0" &&
      /^\d+$/.test(environment?.PORT ?? "") &&
      /\b(?:node\s+ace|ace)\s+serve\b[^\n]*(?:--host|--port)\b/.test(
        command ?? "",
      ),
  );
}

function usesInterpolatedContainerHost(manifest: PreviewManifest) {
  return manifest.services.some(({ environment }) =>
    /^\$\{host:-0\.0\.0\.0\}$/i.test(environment?.HOST ?? ""),
  );
}

function usesInterpolatedServiceUrl(manifest: PreviewManifest) {
  return manifest.services.some(({ environment }) =>
    Object.entries(environment ?? {}).some(
      ([key, value]) =>
        /(?:api|backend)[a-z0-9_]*url$/i.test(key) &&
        /^\$\{[a-z0-9_]+:-http:\/\/[a-z0-9_-]+:[0-9]+[^}]*\}$/i.test(value),
    ),
  );
}

function requiresDatabaseMigration(
  manifest: PreviewManifest,
  scan: ProjectInitializationScan | undefined,
) {
  if (!scan || !usesRelationalDatabase(manifest)) return false;
  const scopes = initializationEvidenceScopes(manifest);
  if (
    scan.discovery?.migrationPaths.some((path) => pathInScopes(path, scopes))
  ) {
    return true;
  }
  return relevantInitializationFiles(scan, manifest).some(
    ([path, content]) =>
      path.endsWith("/migrations/") && content.trim().length > 0,
  );
}

function usesRelationalDatabase(manifest: PreviewManifest) {
  return images(manifest).some((image) =>
    /(?:^|\/)(?:mysql|mariadb|postgres|postgresql|postgis)(?::|@|$)/.test(
      image,
    ),
  );
}

function runsDatabaseMigration(commands: string) {
  return /\b(?:migration:run|migrate\s+(?:deploy|dev|up|latest|run)|db:migrate|drizzle-kit\s+migrate|knex\s+migrate:latest)\b/.test(
    commands,
  );
}

function relevantInitializationFiles(
  scan: ProjectInitializationScan,
  manifest: PreviewManifest,
) {
  const scopes = initializationEvidenceScopes(manifest);
  return Object.entries(scan.files).filter(([path]) =>
    pathInScopes(path, scopes),
  );
}

function initializationEvidenceScopes(manifest: PreviewManifest) {
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
