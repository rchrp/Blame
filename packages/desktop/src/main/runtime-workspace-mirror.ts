import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  run,
  runtimeHostPath,
  runtimeManagedPath,
} from "./workspace-runtime.ts";

// Project scans read files with Node on this machine, but a local-container
// story worktree lives inside the runtime VM. On macOS the VM copies the
// worktree's source files into a cache folder of the mounted home directory;
// on Windows the WSL path is readable as is. Large files become empty
// placeholders: scans need their names, not their content.

const maximumMirroredFileBytes = 256 * 1024;
const maximumMirroredFiles = 20_000;

export type ProjectScanRoot = { root: string; release(): Promise<void> };

export async function projectScanRoot(
  workspace: string,
  platform: NodeJS.Platform = process.platform,
): Promise<ProjectScanRoot> {
  if (!runtimeManagedPath(workspace, platform)) {
    return { root: workspace, release: async () => undefined };
  }
  if (platform !== "darwin") {
    return {
      root: runtimeHostPath(workspace, platform),
      release: async () => undefined,
    };
  }
  const mirrors = join(homedir(), "Library", "Caches", "Blame", "scan-mirrors");
  await removeAbandonedMirrors(mirrors);
  const root = join(mirrors, randomUUID());
  await mkdir(root, { recursive: true, mode: 0o700 });
  const release = () => rm(root, { recursive: true, force: true });
  try {
    await run(
      "bash",
      [
        "-c",
        mirrorScript,
        "blame-scan-mirror",
        workspace,
        root,
        String(maximumMirroredFileBytes),
        String(maximumMirroredFiles),
      ],
      { cwd: workspace, maxBuffer: 1024 * 1024 },
    );
  } catch (error) {
    await release();
    throw error;
  }
  return { root, release };
}

// Copies left by a process that stopped before releasing them.
async function removeAbandonedMirrors(directory: string) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const entry of await readdir(directory).catch(() => [])) {
    const path = join(directory, entry);
    const info = await stat(path).catch(() => undefined);
    if (info && info.mtimeMs < cutoff) {
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

// Missing tracked files and an early end of the listing must not fail the
// copy, so the pipelines do not use pipefail.
const mirrorScript = String.raw`set -eu
source_directory=$1
destination=$2
maximum_bytes=$3
maximum_files=$4
small=$(mktemp)
large=$(mktemp)
trap 'rm -f "$small" "$large"' EXIT
cd "$source_directory"
git ls-files --cached --others --exclude-standard -z |
  head -z -n "$maximum_files" |
  xargs -0 -r stat --printf '%F\t%s\t%n\0' -- 2>/dev/null |
  while IFS=$'\t' read -r -d '' kind size path; do
    case $kind in
      "symbolic link") printf '%s\0' "$path" >>"$small" ;;
      "regular file" | "regular empty file")
        if [ "$size" -le "$maximum_bytes" ]; then
          printf '%s\0' "$path" >>"$small"
        else
          printf '%s\0' "$path" >>"$large"
        fi
        ;;
    esac
  done
if [ -s "$small" ]; then
  tar --null -T "$small" -cf - | tar -xf - -C "$destination"
fi
while IFS= read -r -d '' path; do
  mkdir -p "$destination/$(dirname -- "$path")"
  : >"$destination/$path"
done <"$large"`;
