import { basename, delimiter } from "node:path";
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
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) =>
        name !== "NODE_ENV" &&
        name !== "NODE_TEST_CONTEXT" &&
        !name.startsWith("BLAME_") &&
        !(npmTask && pnpmOnlyNpmConfiguration.has(name.toLowerCase())),
    ),
  );
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
