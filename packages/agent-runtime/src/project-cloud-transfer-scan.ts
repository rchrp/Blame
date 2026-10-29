import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { readProjectCloudIgnore } from "./project-cloud-ignore.js";

type SizedPath = { path: string; bytes: number };
export type ProjectCloudTransferScan = {
  existingBlameignore?: string;
  largestFiles: SizedPath[];
  largestDirectories: (SizedPath & { files: number })[];
  /** Discovery is bounded; these totals may be partial. */
  discoveredBytes: number;
};

export async function scanProjectCloudTransfer(
  root: string,
  paths: string[],
): Promise<ProjectCloudTransferScan> {
  const largestFiles: SizedPath[] = [];
  const directories = new Map<string, { bytes: number; files: number }>();
  let discoveredBytes = 0;
  for (let start = 0; start < paths.length; start += 32) {
    const batch = await Promise.all(
      paths.slice(start, start + 32).map(async (path) => {
        try {
          const info = await lstat(join(root, path));
          return info.isFile() ? { path, bytes: info.size } : undefined;
        } catch (error) {
          if (
            ["ENOENT", "ENOTDIR"].includes(
              (error as NodeJS.ErrnoException).code ?? "",
            )
          )
            return undefined;
          throw error;
        }
      }),
    );
    for (const file of batch) {
      if (!file) continue;
      discoveredBytes += file.bytes;
      largestFiles.push(file);
      const parts = file.path.split("/").slice(0, -1);
      for (let depth = 1; depth <= parts.length; depth++) {
        const directory = parts.slice(0, depth).join("/");
        const current = directories.get(directory) ?? { bytes: 0, files: 0 };
        current.bytes += file.bytes;
        current.files++;
        directories.set(directory, current);
      }
    }
    largestFiles.sort(bySize);
    largestFiles.length = Math.min(largestFiles.length, 20);
  }
  return {
    existingBlameignore: await readProjectCloudIgnore(root),
    discoveredBytes,
    largestFiles,
    largestDirectories: [...directories]
      .map(([path, size]) => ({ path, ...size }))
      .sort(bySize)
      .slice(0, 20),
  };
}

function bySize(left: SizedPath, right: SizedPath) {
  return (
    right.bytes - left.bytes ||
    (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  );
}
