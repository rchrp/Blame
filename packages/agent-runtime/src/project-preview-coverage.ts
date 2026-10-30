import type { ProjectInitializationScan } from "./project-initialization-scan.js";
import type { PreviewManifest } from "./types.js";

// Checks that a manifest runs what the project needs, from the scan:
// an image Prisma works in, the database settings each backend reads, and
// the backends and desktop apps the project has.

type Issue = {
  severity: "blocking" | "warning";
  rule: string;
  warning: string;
};

type Task =
  PreviewManifest["setup"][number] | PreviewManifest["services"][number];

// Prisma's engines need OpenSSL. Slim and Alpine images leave it out, and
// a cloud preview cannot install system packages.
export function prismaImageIssues(
  manifest: PreviewManifest,
  scan: ProjectInitializationScan | undefined,
): Issue[] {
  if (
    !scan ||
    !packageFiles(scan).some(([, json]) =>
      usesPackage(json, "prisma", "@prisma/client"),
    )
  )
    return [];
  const images = tasks(manifest)
    .map(({ container }) => container.image ?? "")
    .filter((image) => /(?:^|\/)node:[^@\s]*(?:slim|alpine)/.test(image));
  if (!images.length) return [];
  return [
    {
      severity: "blocking",
      rule: `must run Prisma in an image that ships OpenSSL, such as node:24-bookworm, instead of ${[...new Set(images)].join(", ")}: slim and alpine images leave OpenSSL out and cloud previews cannot install it`,
      warning: "Prisma cannot run in a slim or alpine image.",
    },
  ];
}

// Previews never read a developer's env files for their database: every
// task that runs a backend gets the database settings its env example
// lists, under those exact names.
export function databaseEnvironmentIssues(
  manifest: PreviewManifest,
  scan: ProjectInitializationScan | undefined,
): Issue[] {
  if (!scan) return [];
  const issues: Issue[] = [];
  for (const [path, content] of Object.entries(scan.files)) {
    if (!/(?:^|\/)\.env\.(?:example|sample|template)$/.test(path)) continue;
    const directory = dirname(path);
    const keys = envKeys(content).filter(databaseKey);
    if (!keys.length) continue;
    const name = packageName(scan, directory);
    for (const task of databaseClients(manifest)) {
      if (!runsIn(task, directory, name)) continue;
      const set = new Set([
        ...Object.keys(task.environment ?? {}),
        ...("bindings" in task
          ? (task.bindings ?? []).map(({ target }) => target.key)
          : []),
      ]);
      const missing = keys.filter((key) => !set.has(key));
      if (!missing.length) continue;
      issues.push({
        severity: "warning",
        rule: `must give ${task.id} the database settings ${directory}/${basename(path)} lists, under those names (${missing.join(", ")}): previews never read the developer's env files for their database`,
        warning: `${task.id} may not find its database settings.`,
      });
    }
  }
  return issues;
}

const backendMarkers: Array<[RegExp, string]> = [
  [/(?:^|\/)adonisrc\.ts$/, "AdonisJS"],
  [/(?:^|\/)nest-cli\.json$/, "NestJS"],
  [/(?:^|\/)manage\.py$/, "Django"],
  [/(?:^|\/)artisan$/, "Laravel"],
  [/(?:^|\/)config\/application\.rb$/, "Rails"],
];

// A backend the scan found must run as a service: a host script that
// tunnels to a remote database is no reason to leave it out.
export function backendCoverageIssues(
  manifest: PreviewManifest,
  scan: ProjectInitializationScan | undefined,
): Issue[] {
  if (!scan) return [];
  const issues: Issue[] = [];
  for (const path of Object.keys(scan.files)) {
    const marker = backendMarkers.find(([pattern]) => pattern.test(path));
    if (!marker || ignoredEvidence(path)) continue;
    const directory = dirname(path);
    const name = packageName(scan, directory);
    if (manifest.services.some((service) => runsIn(service, directory, name)))
      continue;
    issues.push({
      severity: "warning",
      rule: `must run the ${marker[1]} backend in ${directory} as a service, with an isolated database if it needs one; a host script that reaches a remote or tunnelled database is no reason to leave it out`,
      warning: `The ${marker[1]} backend in ${directory} has no preview service.`,
    });
  }
  return issues;
}

// An Electron app runs on Linux: it gets a screen preview, not a host-only
// configuration.
export function electronCoverageIssues(
  manifest: PreviewManifest,
  scan: ProjectInitializationScan | undefined,
): Issue[] {
  if (!scan) return [];
  if (manifest.services.some(({ surface }) => surface?.type === "display"))
    return [];
  return electronApps(scan).map(([path]) => ({
    severity: "warning" as const,
    rule: `must give the Electron app in ${dirname(path)} a Linux screen preview service (surface display, image previewImages.electron) instead of a host-only configuration`,
    warning: `The Electron app in ${dirname(path)} has no screen preview.`,
  }));
}

// Recent Electron versions download their binary on the first
// require("electron"), not at install, and electron-vite and Forge only read
// its path: the setup must trigger that download or the app never starts.
export function electronBinaryIssues(
  manifest: PreviewManifest,
  scan: ProjectInitializationScan | undefined,
): Issue[] {
  if (!scan) return [];
  const downloads = manifest.setup.some(({ command }) =>
    /require\(\s*\\?["']electron\\?["']\s*\)|install-electron|electron\/install\.js/.test(
      command ?? "",
    ),
  );
  if (downloads) return [];
  const services = electronApps(scan).flatMap(([path]) => {
    const directory = dirname(path);
    const name = packageName(scan, directory);
    return manifest.services.filter(
      (service) =>
        service.surface?.type === "display" && runsIn(service, directory, name),
    );
  });
  return [...new Set(services.map(({ id }) => id))].map((id) => ({
    severity: "blocking" as const,
    rule: `must download Electron's binary in the install setup task, after installing dependencies, by running node -e "require('electron')" in the app's package (with pnpm: pnpm --filter <app> exec node -e "require('electron')"), so ${id} can start: recent Electron versions only download it on first use and electron-vite fails with "Electron uninstall"`,
    warning: `${id} cannot start Electron without its binary.`,
  }));
}

function electronApps(scan: ProjectInitializationScan) {
  return packageFiles(scan).filter(
    ([path, json]) =>
      !ignoredEvidence(path) &&
      (usesPackage(json, "electron", "electron-vite") ||
        /\belectron-(?:vite|forge)\b/.test(json)) &&
      /"dev"\s*:/.test(json),
  );
}

// Scanned package manifests can be cut short: read them as text.
function packageFiles(scan: ProjectInitializationScan) {
  return Object.entries(scan.files).filter(([path]) =>
    /(?:^|\/)package\.json$/.test(path),
  );
}

function usesPackage(json: string, ...names: string[]) {
  return names.some((name) => new RegExp(`"${escape(name)}"\\s*:`).test(json));
}

function packageName(scan: ProjectInitializationScan, directory: string) {
  const path = directory === "." ? "package.json" : `${directory}/package.json`;
  return /"name"\s*:\s*"([^"]+)"/.exec(scan.files[path] ?? "")?.[1];
}

function tasks(manifest: PreviewManifest): Task[] {
  return [...manifest.setup, ...manifest.services];
}

// The services that run project code, and the setup tasks that wait for a
// database (migrations, seeds).
function databaseClients(manifest: PreviewManifest): Task[] {
  const databases = new Set(
    manifest.services
      .filter(({ kind }) => kind === "dependency")
      .map(({ id }) => id),
  );
  return [
    ...manifest.setup.filter(({ dependsOn }) =>
      (dependsOn ?? []).some((id) => databases.has(id)),
    ),
    ...manifest.services.filter(({ kind }) => kind !== "dependency"),
  ];
}

// Whether a task runs code of a directory: it works there, or it filters
// the workspace on that package.
function runsIn(task: Task, directory: string, name: string | undefined) {
  const workingDir = (task.workingDir ?? "").replace(/^\/workspace\/?/, "");
  if (
    directory !== "." &&
    (workingDir === directory || workingDir.startsWith(`${directory}/`))
  )
    return true;
  if (directory === "." && !workingDir) return true;
  const command = task.command ?? "";
  if (
    name &&
    new RegExp(`(?:--filter|-F)[= ]["']?${escape(name)}(?:["'\\s]|$)`).test(
      command,
    )
  )
    return true;
  return (
    command.includes(`${directory}/`) || command.includes(`cd ${directory}`)
  );
}

const databaseEnvironmentKey =
  /^(?:DB|DATABASE|MYSQL|MARIADB|POSTGRES|POSTGRESQL|PG|MONGO|MONGODB|REDIS|MSSQL)(?:_|$)|^(?:PGHOST|PGPORT|PGUSER|PGPASSWORD|PGDATABASE)$|_DATABASE_URL$/;

function databaseKey(key: string) {
  return databaseEnvironmentKey.test(key);
}

function envKeys(content: string) {
  return [
    ...new Set(
      content
        .split("\n")
        .map(
          (line) =>
            /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1],
        )
        .filter((key): key is string => Boolean(key)),
    ),
  ];
}

// Fixtures, build output and experiments are not the project.
function ignoredEvidence(path: string) {
  return /(?:^|\/)(?:dist|build|out|node_modules|fixtures?|test-fixtures|tools|docs|examples?)\//.test(
    path,
  );
}

function dirname(path: string) {
  const index = path.lastIndexOf("/");
  return index < 0 ? "." : path.slice(0, index);
}

function basename(path: string) {
  return path.slice(path.lastIndexOf("/") + 1);
}

function escape(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}
