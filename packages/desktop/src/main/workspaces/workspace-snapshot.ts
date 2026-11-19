import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
  compareWorkspacePaths,
  currentWorkspaceSnapshotPolicy,
  blameignoreFileName,
  gitignoreFileName,
  WorkspaceIgnore,
  workspaceSnapshotHash,
  type WorkspaceSnapshotPolicy,
} from "@blame/preview-runtime/workspace-ignore";

export type WorkspaceFileMetadata = {
  type: "file" | "symlink";
  sha256: string;
  mode: number;
  size: number;
  target?: string;
};

export type WorkspaceSnapshot = {
  hash: string;
  files: Record<string, WorkspaceFileMetadata>;
  /** Absent on snapshots persisted before policies existed: "legacy". */
  policy?: WorkspaceSnapshotPolicy;
};

// A file's hash, kept while its size, times and inode stay the same: a
// sync of a mirrored worktree, 450 ms after each change, then reads only
// the files that changed. As Git does with its index, a file changed
// within moments of its hash is read again, in case a second change kept
// its times.
type FileHash = {
  changed: number;
  hashedAt: number;
  inode: number;
  modified: number;
  sha256: string;
  size: number;
};
const fileHashes = new Map<string, Map<string, FileHash>>();
const racyMilliseconds = 2_000;

// The cloud sandbox runner hashes its copy with the same rule (see
// @blame/preview-runtime/workspace-ignore); both hashes must match.
export async function snapshotWorkspace(
  root: string,
  policy: WorkspaceSnapshotPolicy = currentWorkspaceSnapshotPolicy,
): Promise<WorkspaceSnapshot> {
  const files: Record<string, WorkspaceFileMetadata> = {};
  const casePaths = new Map<string, string>();
  const hashes = {
    previous: fileHashes.get(root) ?? new Map<string, FileHash>(),
    next: new Map<string, FileHash>(),
  };
  await visit(
    root,
    root,
    files,
    casePaths,
    new WorkspaceIgnore(policy),
    hashes,
  );
  fileHashes.set(root, hashes.next);
  const compare = compareWorkspacePaths(policy);
  const sortedFiles = Object.fromEntries(
    Object.entries(files).sort(([left], [right]) => compare(left, right)),
  );
  return {
    hash: workspaceSnapshotHash(sortedFiles, policy),
    files: sortedFiles,
    policy,
  };
}

export async function readWorkspaceCloudIgnore(root: string) {
  const path = join(root, blameignoreFileName);
  try {
    if (!(await lstat(path)).isFile())
      throw new Error(".blameignore must be a regular file");
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}

export function forbiddenWorkspacePath(path: string) {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  const segments = normalized.split("/");
  const basename = segments.at(-1) ?? "";
  return (
    segments.includes(".git") ||
    segments.includes(".ssh") ||
    segments.includes("node_modules") ||
    segments.includes(".next") ||
    segments.includes(".turbo") ||
    segments.includes(".cache") ||
    segments.includes(".vite") ||
    segments.includes(".parcel-cache") ||
    segments.includes("dist") ||
    segments.includes("out") ||
    segments.includes("coverage") ||
    (segments.includes(".blame") && segments.includes("runtime-tools")) ||
    (basename.startsWith(".env") && basename !== ".env.example") ||
    [".npmrc", "id_rsa", "id_ed25519", "known_hosts"].includes(basename) ||
    normalized === ".docker/config.json" ||
    normalized.endsWith(".log")
  );
}

async function visit(
  root: string,
  directory: string,
  files: Record<string, WorkspaceFileMetadata>,
  casePaths: Map<string, string>,
  rules: WorkspaceIgnore,
  hashes: { previous: Map<string, FileHash>; next: Map<string, FileHash> },
) {
  const entries = await readdir(directory, { withFileTypes: true });
  if (
    directory === root &&
    entries.some(
      (entry) => entry.isFile() && entry.name === blameignoreFileName,
    )
  )
    rules.addCloud(await readFile(join(root, blameignoreFileName), "utf8"));
  if (
    rules.policy !== "legacy" &&
    entries.some((entry) => entry.isFile() && entry.name === gitignoreFileName)
  ) {
    rules.add(
      relative(root, directory).split(sep).join("/"),
      await readFile(join(directory, gitignoreFileName), "utf8"),
    );
  }
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    const path = relative(root, absolute).split(sep).join("/");
    if (forbiddenWorkspacePath(path)) continue;
    if (rules.ignores(path, entry.isDirectory())) continue;
    const folded = path.normalize("NFC").toLocaleLowerCase("en-US");
    const collision = casePaths.get(folded);
    if (collision && collision !== path)
      throw new Error(
        `Workspace paths collide by case: ${collision} and ${path}`,
      );
    casePaths.set(folded, path);
    const stat = await lstat(absolute);
    if (stat.isDirectory())
      await visit(root, absolute, files, casePaths, rules, hashes);
    else if (stat.isSymbolicLink()) {
      const target = await readlink(absolute);
      assertSafeSymlink(path, target);
      files[path] = {
        type: "symlink",
        sha256: createHash("sha256").update(target).digest("hex"),
        mode: stat.mode & 0o777,
        size: Buffer.byteLength(target),
        target,
      };
    } else if (stat.isFile()) {
      const hash = await fileHash(absolute, stat, hashes.previous.get(path));
      hashes.next.set(path, hash);
      files[path] = {
        type: "file",
        sha256: hash.sha256,
        mode: stat.mode & 0o777,
        size: stat.size,
      };
    }
  }
}

async function fileHash(
  absolute: string,
  stat: Stats,
  previous: FileHash | undefined,
): Promise<FileHash> {
  if (
    previous &&
    previous.size === stat.size &&
    previous.modified === stat.mtimeMs &&
    previous.changed === stat.ctimeMs &&
    previous.inode === stat.ino &&
    previous.hashedAt - Math.max(stat.mtimeMs, stat.ctimeMs) > racyMilliseconds
  )
    return previous;
  const hashedAt = Date.now();
  const content = await readFile(absolute);
  return {
    changed: stat.ctimeMs,
    hashedAt,
    inode: stat.ino,
    modified: stat.mtimeMs,
    sha256: createHash("sha256").update(content).digest("hex"),
    size: stat.size,
  };
}

export function assertSafeSymlink(path: string, target: string) {
  if (!target || target.startsWith("/") || /^[a-z]:/i.test(target))
    throw new Error(`Unsafe symlink: ${path}`);
  const stack = path.split("/").slice(0, -1);
  for (const segment of target.replaceAll("\\", "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!stack.length) throw new Error(`Symlink escapes workspace: ${path}`);
      stack.pop();
    } else stack.push(segment);
  }
}
