import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import {
  gitignoreFileName,
  parseWorkspaceSnapshotPolicy,
  WorkspaceIgnore,
  workspaceSnapshotHash,
  type WorkspaceSnapshotPolicy,
} from "@blame/preview-runtime/workspace-ignore";
import { runtimePaths } from "../runtime-paths.js";

export type WorkspaceFileSnapshot = {
  type: "file" | "symlink";
  sha256: string;
  mode: number;
  size: number;
  target?: string;
};

export type WorkspaceSnapshot = {
  hash: string;
  files: Record<string, WorkspaceFileSnapshot>;
  policy?: WorkspaceSnapshotPolicy;
};

/**
 * Hashes the workspace with the snapshot rule its source declared (see
 * @blame/preview-runtime/workspace-ignore). Without an explicit policy, the
 * rule of the last imported source applies, so the change journal, exports
 * and setup caches agree with the desktop.
 */
export async function snapshotWorkspace(
  root: string = runtimePaths.workspace,
  policy?: WorkspaceSnapshotPolicy,
): Promise<WorkspaceSnapshot> {
  const files: Record<string, WorkspaceFileSnapshot> = {};
  const casePaths = new Map<string, string>();
  const effectivePolicy = policy ?? (await readWorkspaceSnapshotPolicy());
  const rules = new WorkspaceIgnore(effectivePolicy);
  await visit(root, root, files, casePaths, rules);
  return {
    hash: workspaceSnapshotHash(files, effectivePolicy),
    files,
    policy: effectivePolicy,
  };
}

export async function readWorkspaceSnapshotPolicy() {
  try {
    return parseWorkspaceSnapshotPolicy(
      (await readFile(runtimePaths.snapshotPolicy, "utf8")).trim(),
    );
  } catch {
    return parseWorkspaceSnapshotPolicy(undefined);
  }
}

export async function writeWorkspaceSnapshotPolicy(
  policy: WorkspaceSnapshotPolicy,
) {
  await mkdir(dirname(runtimePaths.snapshotPolicy), {
    recursive: true,
    mode: 0o700,
  });
  const temporary = `${runtimePaths.snapshotPolicy}.${process.pid}.tmp`;
  await writeFile(temporary, policy, { mode: 0o600, flush: true });
  await rename(temporary, runtimePaths.snapshotPolicy);
}

/** Adds `<directory>/.gitignore` to the rules when the directory has one. */
export async function addDirectoryGitignore(
  rules: WorkspaceIgnore,
  root: string,
  directory: string,
  entries: { name: string; isFile(): boolean }[],
) {
  if (rules.policy === "legacy") return;
  if (
    !entries.some((entry) => entry.isFile() && entry.name === gitignoreFileName)
  )
    return;
  const path = relative(root, directory).split(sep).join("/");
  rules.add(path, await readFile(join(directory, gitignoreFileName), "utf8"));
}

async function visit(
  root: string,
  directory: string,
  files: Record<string, WorkspaceFileSnapshot>,
  casePaths: Map<string, string>,
  rules: WorkspaceIgnore,
) {
  const entries = await readdir(directory, { withFileTypes: true });
  await addDirectoryGitignore(rules, root, directory, entries);
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    const path = relative(root, absolute).split(sep).join("/");
    if (path === ".git" || path.startsWith(".git/") || ignored(path)) continue;
    if (rules.ignores(path, entry.isDirectory())) continue;
    const folded = path.normalize("NFC").toLocaleLowerCase("en-US");
    const collision = casePaths.get(folded);
    if (collision && collision !== path) {
      throw new Error(
        `Workspace paths collide by case: ${collision} and ${path}.`,
      );
    }
    casePaths.set(folded, path);
    const stat = await lstat(absolute);
    if (stat.isDirectory()) {
      await visit(root, absolute, files, casePaths, rules);
    } else if (stat.isSymbolicLink()) {
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
      const content = await readFile(absolute);
      files[path] = {
        type: "file",
        sha256: createHash("sha256").update(content).digest("hex"),
        mode: stat.mode & 0o777,
        size: stat.size,
      };
    }
  }
}

export function forbiddenWorkspacePath(path: string) {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  const segments = normalized.split("/");
  const basename = segments.at(-1) ?? "";
  return (
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

function ignored(path: string) {
  return forbiddenWorkspacePath(path);
}

export function assertSafeSymlink(path: string, target: string) {
  if (!target || target.startsWith("/") || /^[a-z]:/i.test(target)) {
    throw new Error(`Unsafe workspace symlink: ${path}.`);
  }
  const stack = path.split("/").slice(0, -1);
  for (const segment of target.replaceAll("\\", "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!stack.length)
        throw new Error(`Workspace symlink escapes workspace: ${path}.`);
      stack.pop();
    } else stack.push(segment);
  }
}
