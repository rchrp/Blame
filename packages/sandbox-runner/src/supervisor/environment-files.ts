import { chown, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, posix } from "node:path";
import {
  safeRelativePath,
  type PreviewEnvironmentSecrets,
} from "@blame/preview-runtime";

// The variables a cloud preview gets from the developer's computer, written
// under /run (memory, not the sandbox disk) instead of the Compose file, the
// plan or the workspace, so a snapshot of the sandbox does not keep them.
// Each service's variables are a raw env file Compose reads; env files are
// mounted over their workspace paths, readable by the project user.

export const environmentDirectory = "/run/blame/environment";

export type EnvironmentTargets = {
  environmentFiles: Record<string, string>;
  fileMounts: Array<{ source: string; target: string }>;
  /** Values a raw env file cannot hold, such as several lines. */
  skipped: string[];
};

export async function writeEnvironmentFiles(
  secrets: PreviewEnvironmentSecrets | undefined,
  owner: { uid: number; gid: number },
  directory = environmentDirectory,
): Promise<EnvironmentTargets> {
  await rm(directory, { recursive: true, force: true });
  const targets: EnvironmentTargets = {
    environmentFiles: {},
    fileMounts: [],
    skipped: [],
  };
  if (!secrets) return targets;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const [service, variables] of Object.entries(secrets.variables)) {
    const lines: string[] = [];
    for (const [key, value] of Object.entries(variables)) {
      if (/[\r\n]/.test(value)) targets.skipped.push(`${service}:${key}`);
      else lines.push(`${key}=${value}`);
    }
    const path = posix.join(directory, "services", `${service}.env`);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, `${lines.join("\n")}\n`, { mode: 0o600 });
    targets.environmentFiles[service] = path;
  }
  const files = posix.join(directory, "files");
  for (const file of secrets.files) {
    if (!safeRelativePath(file.path)) continue;
    const path = posix.join(files, file.path);
    await mkdir(dirname(path), { recursive: true, mode: 0o755 });
    await writeFile(path, file.content, { mode: 0o400 });
    await chown(path, owner.uid, owner.gid);
    targets.fileMounts.push({ source: path, target: file.path });
  }
  return targets;
}

export function removeEnvironmentFiles(directory = environmentDirectory) {
  return rm(directory, { recursive: true, force: true });
}
