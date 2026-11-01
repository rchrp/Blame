import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { withoutTelemetryEnvironment } from "@blame/telemetry";
import type { CloudPreviewIgnoreRule } from "./project-cloud-ignore.js";

const execFileAsync = promisify(execFile);

// A cloud preview sends the files Git would commit: tracked and untracked
// files that are not ignored, minus .blameignore. The desktop refuses an
// archive over 256 MB once compressed, and each file travels twice in it
// (as a file and in the Git snapshot): media and PDFs barely compress, so
// about 128 MB of them is already too much.
const transferWarningBytes = 128 * 1024 * 1024;

export type CloudTransferSize = {
  bytes: number;
  files: number;
  /** The largest directories, none inside another, and the largest files. */
  largest: Array<{ path: string; bytes: number; directory: boolean }>;
  /** Sizes of the largest directories and files, nested ones included. */
  sizes: Record<string, number>;
};

export async function measureCloudTransfer(
  root: string,
): Promise<CloudTransferSize | undefined> {
  let listing: string;
  try {
    ({ stdout: listing } = await execFileAsync(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      {
        cwd: root,
        env: withoutTelemetryEnvironment(process.env),
        maxBuffer: 64 * 1024 * 1024,
      },
    ));
  } catch {
    return undefined;
  }
  const paths = [...new Set(listing.split("\0").filter(Boolean))];
  const directories = new Map<string, number>();
  const files: Array<{ path: string; bytes: number }> = [];
  let bytes = 0;
  for (let start = 0; start < paths.length; start += 64) {
    const sizes = await Promise.all(
      paths.slice(start, start + 64).map(async (path) => {
        const info = await lstat(join(root, path)).catch(() => undefined);
        return info?.isFile() ? { path, bytes: info.size } : undefined;
      }),
    );
    for (const file of sizes) {
      if (!file) continue;
      bytes += file.bytes;
      files.push(file);
      const parts = file.path.split("/").slice(0, -1);
      for (let depth = 1; depth <= parts.length; depth++) {
        const directory = parts.slice(0, depth).join("/");
        directories.set(
          directory,
          (directories.get(directory) ?? 0) + file.bytes,
        );
      }
    }
  }
  const candidates = [
    ...[...directories].map(([path, size]) => ({
      path,
      bytes: size,
      directory: true,
    })),
    ...files.map((file) => ({ ...file, directory: false })),
  ].sort((left, right) => right.bytes - left.bytes);
  // A parent that holds nearly all of a child's bytes says the same thing.
  const largest: CloudTransferSize["largest"] = [];
  for (const candidate of candidates) {
    if (largest.length >= 12) break;
    if (largest.some((taken) => contains(taken.path, candidate.path))) continue;
    largest.push(candidate);
  }
  const sizes = Object.fromEntries(
    [
      ...candidates.filter(({ directory }) => directory).slice(0, 60),
      ...candidates.filter(({ directory }) => !directory).slice(0, 20),
    ].map(({ path, bytes: size }) => [path, size]),
  );
  return { bytes, files: files.length, largest, sizes };
}

export function cloudTransferIssues(
  transfer: CloudTransferSize | undefined,
  existingBlameignore: string | undefined,
  rules: CloudPreviewIgnoreRule[] | undefined,
) {
  if (!transfer) return [];
  const excluded = [
    ...new Set(
      [
        ...(rules ?? []).map(({ pattern }) => pattern),
        ...manualRootedRules(existingBlameignore),
      ].map((pattern) =>
        pattern.replace(/^\//, "").replace(/\/(?:\*\*)?$/, ""),
      ),
    ),
  ];
  const covered = (path: string) =>
    excluded.some((rule) => path === rule || contains(rule, path));
  // Count each excluded path once, without the ones inside another.
  const removed = excluded
    .filter((rule) => !excluded.some((other) => contains(other, rule)))
    .reduce((total, rule) => total + (transfer.sizes[rule] ?? 0), 0);
  const kept = transfer.largest.filter(({ path }) => !covered(path));
  const remaining = transfer.bytes - removed;
  if (remaining <= transferWarningBytes) return [];
  const listed = kept
    .slice(0, 5)
    .map(
      ({ path, bytes, directory }) =>
        `/${path}${directory ? "/**" : ""} (${megabytes(bytes)} MB)`,
    )
    .join(", ");
  return [
    {
      severity: "warning" as const,
      rule: `should keep what a cloud preview sends under its transfer limit: about ${megabytes(remaining)} MB of files remain, and media or PDFs barely compress. Exclude in cloudPreviewIgnore the large paths that installs, builds, setup tasks and services never read, such as source documents or media only one-off scripts or tests use. Largest: ${listed}`,
      warning: `Cloud previews may exceed the transfer limit (about ${megabytes(remaining)} MB of files).`,
    },
  ];
}

// Manual .blameignore rules outside the generated block that name a root
// path, such as `/personal/`; other Gitignore patterns are not counted.
function manualRootedRules(blameignore: string | undefined) {
  // The generated block is replaced by the submitted rules.
  return (blameignore ?? "")
    .replace(
      /# BEGIN BLAME GENERATED CLOUD EXCLUSIONS[\s\S]*?# END BLAME GENERATED CLOUD EXCLUSIONS/,
      "",
    )
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\/[^*?[\]!#]+(?:\/\*\*|\/)?$/.test(line));
}

function contains(directory: string, path: string) {
  return path.startsWith(`${directory}/`);
}

function megabytes(bytes: number) {
  return Math.round(bytes / (1024 * 1024));
}
