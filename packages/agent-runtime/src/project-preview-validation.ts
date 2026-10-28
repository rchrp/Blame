import type { ProjectInitializationScan } from "./project-initialization-scan.js";
import type { PreviewManifest, ProjectRunConfiguration } from "./types.js";

export function validateRunConfigurationPreview(
  configuration: ProjectRunConfiguration,
  manifest: PreviewManifest,
) {
  if (configuration.previewTarget && configuration.previewService)
    throw new Error(
      "A run configuration must select at most one preview service or device target",
    );
  if (configuration.previewTarget) {
    if (configuration.category !== "mobile")
      throw new Error("A device preview needs category mobile");
    if (!manifest.devices?.some((d) => d.id === configuration.previewTarget))
      throw new Error("Run configuration previewTarget is unknown");
    if (configuration.previewUrl)
      throw new Error("A device preview has no previewUrl");
  }
  const service = manifest.services.find(
    (s) => s.id === configuration.previewService,
  );
  if (
    configuration.previewUrl &&
    service?.surface &&
    service.surface.type !== "web"
  )
    throw new Error("previewUrl is only accepted for a web surface");
}
import {
  hostOrchestratedManifestCommand,
  hostOrchestrationError,
} from "./project-host-orchestration.js";

// Checks that an initialized manifest can run its project, from what the
// scan found in the repository. Blame renders and runs the Compose project
// itself, so only what the manifest decides is checked: dependency
// installs, builds, migrations and the values its services read.

export type PreviewSetupIssue = {
  /**
   * Blocking issues make an unusable or unsafe setup. Warnings come from
   * heuristics that can be wrong about a project: the agent is asked to fix
   * them, but a setup that keeps them is still saved, with the warning.
   */
  severity: "blocking" | "warning";
  /** The rule, as told to the agent. */
  rule: string;
  /** What may go wrong, as told to the user. */
  warning: string;
};

/**
 * A rejected setup. Its message is the first issue; `issues` holds every
 * one, so the agent can fix them all in one go.
 */
export class PreviewSetupError extends Error {
  readonly issues: PreviewSetupIssue[];

  constructor(issues: PreviewSetupIssue[]) {
    super(`Initialization result previewManifest ${issues[0]!.rule}`);
    this.issues = issues;
  }
}

/**
 * Throws the first issue of an initialized manifest. With `acceptWarnings`,
 * only blocking issues throw and the warnings are returned.
 */
export function validatePreviewSetup(
  manifest: PreviewManifest,
  scan?: ProjectInitializationScan,
  options: { acceptWarnings?: boolean } = {},
) {
  const hostOrchestration =
    scan && hostOrchestratedManifestCommand(manifest, scan.files);
  if (hostOrchestration) {
    throw new Error(hostOrchestrationError(hostOrchestration));
  }
  const issues = previewSetupIssues(manifest, scan);
  const blocking = issues.filter(({ severity }) => severity === "blocking");
  const warnings = issues.filter(({ severity }) => severity === "warning");
  if (blocking.length || (warnings.length && !options.acceptWarnings)) {
    throw new PreviewSetupError([...blocking, ...warnings]);
  }
  return warnings;
}

export function previewSetupIssues(
  manifest: PreviewManifest,
  scan?: ProjectInitializationScan,
): PreviewSetupIssue[] {
  const commands = manifestCommands(manifest);
  const issues: PreviewSetupIssue[] = [];
  const add = (
    severity: PreviewSetupIssue["severity"],
    rule: string,
    warning: string,
  ) => issues.push({ severity, rule, warning });
  if (forcesHostUidUser(manifest)) {
    add(
      "blocking",
      "must not force BLAME_HOST_UID as the container user",
      "A service forces the host user id.",
    );
  }
  // `npm ci` removes node_modules first, which is a mounted volume.
  if (/\bnpm\s+ci\b/.test(commands)) {
    add(
      "blocking",
      "must use npm install --no-package-lock instead of npm ci",
      "npm ci cannot run on the shared dependency volume.",
    );
  }
  if (missingNodeDependencyInstall(manifest, commands, scan)) {
    add(
      "warning",
      "must install detected Node dependencies before starting services",
      "No setup task seems to install the Node dependencies.",
    );
  }
  if (usesNuxtPreviewWithoutBuild(commands, scan, manifest)) {
    add(
      "warning",
      "must build Nuxt before running its preview script or use the development script",
      "Nuxt's preview script may run without a build.",
    );
  }
  if (seedsPrismaWithoutGeneratedClient(commands, scan, manifest)) {
    add(
      "warning",
      "must generate the Prisma client in a setup task (for example `prisma generate` or the project's db:generate script) before running database seeds",
      "The database seed may run before the Prisma client is generated.",
    );
  }
  if (overridesEnvironmentDrivenServeCommand(manifest)) {
    add(
      "warning",
      "must not append host or port flags to serve commands when HOST and PORT environment variables are already configured",
      "A serve command sets its own host or port next to HOST and PORT.",
    );
  }
  if (usesInterpolatedContainerHost(manifest)) {
    add(
      "warning",
      "must bind preview services to a literal 0.0.0.0 instead of preserving an existing HOST value",
      "A service may not listen on all interfaces.",
    );
  }
  if (usesInterpolatedServiceUrl(manifest)) {
    add(
      "warning",
      "must use literal service URLs for inter-container runtime configuration instead of preserving existing localhost values",
      "A service may call another one at a localhost address.",
    );
  }
  if (
    requiresDatabaseMigration(manifest, scan) &&
    !runsDatabaseMigration(commands)
  ) {
    add(
      "warning",
      "must run detected database migrations before starting backend services",
      "No setup task seems to run the database migrations: the backend may start on an empty database.",
    );
  }
  for (const service of manifest.services) {
    if (
      service.surface?.type === "terminal" &&
      service.endpoints.some((e) => e.protocol !== "tcp")
    )
      add(
        "warning",
        "should not declare its own HTTP endpoint for a terminal surface",
        "A terminal preview does not need its own HTTP endpoint",
      );
  }
  return issues;
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

// Migration commands across ecosystems, and package scripts named after
// migrations. Commands are lowercased.
const migrationCommandPatterns = [
  /\bmigration:(?:run|fresh|refresh|up|latest)\b/,
  /\bmigrate:(?:latest|up|fresh|refresh|deploy|run|reset)\b/,
  /\bmigrate\s+(?:deploy|dev|up|latest|run|reset)\b/,
  /\b(?:db|ecto)[:.]migrate\b/,
  /\b(?:artisan|manage\.py|django-admin)\s+migrate\b/,
  /\balembic\s+upgrade\b/,
  /\bflask\s+db\s+upgrade\b/,
  /\bprisma\s+db\s+push\b/,
  /\bdrizzle-kit\s+(?:migrate|push)\b/,
  /\b(?:goose|dbmate)\s+(?:up|migrate)\b/,
  /\bflyway\s+migrate\b/,
  /\bliquibase\s+update\b/,
  /\bdiesel\s+migration\s+run\b/,
  /\b(?:npm|pnpm|yarn|bun)\b[^\n;&|]*\bmigrat/,
];

function runsDatabaseMigration(commands: string) {
  return migrationCommandPatterns.some((pattern) => pattern.test(commands));
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
