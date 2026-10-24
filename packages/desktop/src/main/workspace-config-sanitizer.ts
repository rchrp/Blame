import { readdir as readdirHost } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  dirnameWorkspacePath,
  joinWorkspacePath,
  pathExists,
  readFile,
  rm,
  run,
  runtimeManagedPath,
  writeFile,
} from "./workspace-runtime.ts";

async function findPnpmWorkspaceYamlFilesHost(
  dir: string,
  readdirFn = readdirHost,
): Promise<string[]> {
  const result: string[] = [];
  const queue = [dir];
  while (queue.length > 0) {
    const curr = queue.shift()!;
    try {
      const entries = await readdirFn(curr, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(curr, entry.name);
        if (entry.isDirectory()) {
          const name = entry.name;
          if (
            name.startsWith(".") ||
            name === "node_modules" ||
            name === "dist" ||
            name === "build" ||
            name === "out"
          ) {
            continue;
          }
          queue.push(fullPath);
        } else if (entry.isFile() && entry.name === "pnpm-workspace.yaml") {
          result.push(fullPath);
        }
      }
    } catch {
      // Ignore reading errors
    }
  }
  return result;
}

async function findDuplicateLockFilesHost(
  dir: string,
  lockfileNames: string[],
  readdirFn = readdirHost,
): Promise<string[]> {
  const result: string[] = [];
  const queue = [dir];
  while (queue.length > 0) {
    const curr = queue.shift()!;
    try {
      const entries = await readdirFn(curr, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(curr, entry.name);
        if (entry.isDirectory()) {
          const name = entry.name;
          if (
            name.startsWith(".") ||
            name === "node_modules" ||
            name === "dist" ||
            name === "build" ||
            name === "out"
          ) {
            continue;
          }
          queue.push(fullPath);
        } else if (entry.isFile() && lockfileNames.includes(entry.name)) {
          if (curr !== dir) {
            result.push(fullPath);
          }
        }
      }
    } catch {
      // Ignore reading errors
    }
  }
  return result;
}

export async function sanitizeWorkspaceConfigFiles(
  worktree: string,
  fns = {
    run,
    readFile,
    writeFile,
    pathExists,
    joinWorkspacePath,
    rm,
    readdirHost,
    platform: process.platform,
  },
): Promise<void> {
  try {
    const platform = fns.platform;
    let paths: string[] = [];
    if (!runtimeManagedPath(worktree, platform)) {
      paths = await findPnpmWorkspaceYamlFilesHost(worktree, fns.readdirHost);
    } else {
      const { stdout } = await fns.run("find", [
        worktree,
        "-type",
        "f",
        "-name",
        "pnpm-workspace.yaml",
      ]);
      paths = stdout.split("\n").filter(Boolean);
    }
    const rootConfigPath = fns.joinWorkspacePath(
      worktree,
      "pnpm-workspace.yaml",
    );

    for (const configPath of paths) {
      if (configPath === rootConfigPath) {
        continue;
      }
      try {
        if (await fns.pathExists(rootConfigPath)) {
          const subContent = await fns.readFile(configPath);
          const subYaml = parseYaml(subContent);

          if (
            subYaml &&
            (subYaml.allowBuilds || subYaml.ignoredBuiltDependencies)
          ) {
            const rootContent = await fns.readFile(rootConfigPath);
            const rootYaml = parseYaml(rootContent) || {};

            let changed = false;
            if (subYaml.allowBuilds) {
              rootYaml.allowBuilds = {
                ...(rootYaml.allowBuilds || {}),
                ...subYaml.allowBuilds,
              };
              changed = true;
            }
            if (subYaml.ignoredBuiltDependencies) {
              const rootIgnored = new Set(
                rootYaml.ignoredBuiltDependencies || [],
              );
              for (const dep of subYaml.ignoredBuiltDependencies) {
                rootIgnored.add(dep);
              }
              rootYaml.ignoredBuiltDependencies = Array.from(rootIgnored);
              changed = true;
            }

            if (changed) {
              await fns.writeFile(rootConfigPath, stringifyYaml(rootYaml));
            }
          }
        }
      } catch {
        // If merge fails, proceed to delete to make Turbopack work
      }

      try {
        await fns.rm(configPath);
      } catch {
        // Ignore deletion failure
      }
    }

    // Now, sanitize duplicate lockfiles
    let lockfilePaths: string[] = [];
    const lockfileNames = [
      "pnpm-lock.yaml",
      "package-lock.json",
      "yarn.lock",
      "bun.lock",
      "bun.lockb",
    ];
    if (!runtimeManagedPath(worktree, platform)) {
      lockfilePaths = await findDuplicateLockFilesHost(
        worktree,
        lockfileNames,
        fns.readdirHost,
      );
    } else {
      for (const name of lockfileNames) {
        try {
          const { stdout } = await fns.run("find", [
            worktree,
            "-type",
            "f",
            "-name",
            name,
          ]);
          const found = stdout.split("\n").filter(Boolean);
          for (const p of found) {
            const rootLockPath = fns.joinWorkspacePath(worktree, name);
            if (p !== rootLockPath) {
              lockfilePaths.push(p);
            }
          }
        } catch {
          // Ignore find errors
        }
      }
    }

    for (const lockPath of lockfilePaths) {
      try {
        await fns.rm(lockPath);
      } catch {
        // Ignore deletion failure
      }
    }
  } catch {
    // Ignore overall failure
  }
}
