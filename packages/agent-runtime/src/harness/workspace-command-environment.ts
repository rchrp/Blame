import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";
import { bundledRipgrepDirectory } from "./lexical-search.js";

const pnpmOnlyNpmConfiguration = new Set([
  "npm_config__jsr_registry",
  "npm_config_catalog",
  "npm_config_globalconfig",
  "npm_config_npm_globalconfig",
  "npm_config_overrides",
  "npm_config_verify_deps_before_run",
]);

export function workspaceCommandEnvironment(
  environment = process.env,
  executable?: string,
) {
  const npmTask = executable && basename(executable).toLowerCase() === "npm";
  const filtered = Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) =>
        name !== "NODE_ENV" &&
        name !== "NODE_TEST_CONTEXT" &&
        !name.startsWith("BLAME_") &&
        !(npmTask && pnpmOnlyNpmConfiguration.has(name.toLowerCase())),
    ),
  );
  // pnpm 11+ reinstalls before `pnpm run` or `pnpm exec` when it finds
  // node_modules out of date. A test command must not change dependencies
  // (the dependency operation does, journaled), and where native builds
  // cannot run that install leaves node_modules half removed.
  if (!Object.keys(filtered).some((name) => name.toUpperCase() === "PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN"))
    filtered.PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN = "false";
  return filtered;
}

/**
 * Lets workspace commands find the ripgrep binary Blame ships, after any
 * installed one: models reach for `rg` even when the host does not provide it.
 */
export function withBundledTools(environment: NodeJS.ProcessEnv, directory = bundledRipgrepDirectory()) {
  if (!directory) return environment;
  const key = Object.keys(environment).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
  const entries = (environment[key] ?? "").split(delimiter).filter(Boolean);
  if (entries.includes(directory)) return environment;
  return { ...environment, [key]: [...entries, directory].join(delimiter) };
}

const managerNames = ["pnpm", "yarn", "npm"];

/**
 * Lets workspace commands and project tasks find the package managers the
 * runtime provisions outside PATH (/opt/blame/package-managers in the VM),
 * after any installed one: a task that runs `pnpm` failed with ENOENT there.
 * The version the nearest package.json pins wins, then one of its major, then
 * the newest.
 */
export function withProvisionedPackageManagers(environment: NodeJS.ProcessEnv, cwd: string) {
  const key = Object.keys(environment).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
  const entries = (environment[key] ?? "").split(delimiter).filter(Boolean);
  const pin = packageManagerPin(cwd);
  const added: string[] = [];
  for (const name of managerNames) {
    if (entries.some((entry) => existsSync(join(entry, name)))) continue;
    const directory = provisionedDirectory(name, pin?.name === name ? pin.version : undefined);
    if (directory && !entries.includes(directory)) added.push(directory);
  }
  return added.length ? { ...environment, [key]: [...entries, ...added].join(delimiter) } : environment;
}

function provisionedDirectory(name: string, pinned?: string) {
  for (const root of new Set([process.env.BLAME_PACKAGE_MANAGER_ROOT?.trim(), "/opt/blame/package-managers"])) {
    if (!root) continue;
    let versions: string[];
    try {
      versions = readdirSync(join(root, name)).filter((version) => existsSync(join(root, name, version, "bin", name)));
    } catch {
      continue;
    }
    const major = pinned?.split(".")[0];
    const chosen = (pinned && versions.find((version) => version === pinned)) ??
      newest(versions.filter((version) => major !== undefined && version.split(".")[0] === major)) ??
      newest(versions);
    if (chosen) return join(root, name, chosen, "bin");
  }
  return undefined;
}

function newest(versions: string[]) {
  return [...versions].sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))[0];
}

function packageManagerPin(cwd: string) {
  for (let directory = cwd; ; directory = dirname(directory)) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as { packageManager?: unknown };
      const match = typeof manifest.packageManager === "string"
        ? /^(pnpm|yarn|npm)@(\d+\.\d+\.\d+)/u.exec(manifest.packageManager)
        : null;
      if (match) return { name: match[1]!, version: match[2]! };
    } catch {
      // No manifest here: look further up.
    }
    if (dirname(directory) === directory) return undefined;
  }
}
