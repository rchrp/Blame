import type { PreviewManifest } from "./types.js";

// Containers bootstrap pnpm or Yarn with `corepack prepare <name>@<version>`.
// Corepack then runs the version the project pins in its packageManager
// field, so a different prepared version is only an extra download, and an
// initialization written before the project bumped its version drifts. The
// pinned version always wins.

type PackageManagerName = "pnpm" | "yarn" | "npm";

export type ProjectPackageManager = {
  name: PackageManagerName;
  version: string;
};

export function projectPackageManager(
  packageJson: string | undefined,
): ProjectPackageManager | undefined {
  if (!packageJson) return undefined;
  let field: unknown;
  try {
    field = (JSON.parse(packageJson) as { packageManager?: unknown })
      .packageManager;
  } catch {
    return undefined;
  }
  if (typeof field !== "string") return undefined;
  const match =
    /^(pnpm|yarn|npm)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+.*)?$/.exec(
      field.trim(),
    );
  if (!match) return undefined;
  return { name: match[1] as PackageManagerName, version: match[2]! };
}

export function commandWithProjectPackageManager(
  command: string,
  packageManager: ProjectPackageManager,
) {
  return command.replace(
    /\b(corepack\s+prepare\s+)(pnpm|yarn|npm)@[^\s"'`;&|)]+/g,
    (match, prefix: string, name: string) =>
      name === packageManager.name
        ? `${prefix}${name}@${packageManager.version}`
        : match,
  );
}

export function manifestWithProjectPackageManager(
  manifest: PreviewManifest,
  packageManager: ProjectPackageManager | undefined,
): PreviewManifest {
  if (!packageManager) return manifest;
  const pin = <T extends { command?: string }>(item: T): T =>
    item.command
      ? {
          ...item,
          command: commandWithProjectPackageManager(
            item.command,
            packageManager,
          ),
        }
      : item;
  return {
    ...manifest,
    setup: manifest.setup.map(pin),
    services: manifest.services.map(pin),
  };
}
