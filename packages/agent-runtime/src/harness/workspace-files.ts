import { createHash } from "node:crypto";
import { createReadStream, realpathSync } from "node:fs";
import { execFile } from "node:child_process";
import {
  lstat,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  stat,
} from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { sha256, type SourceRevisionRef } from "./light-identity.js";

const execFileAsync = promisify(execFile);
const ignoredDirectories = new Set([
  ".blame",
  ".code-review-graph",
  ".git",
  ".next",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "target",
  ".turbo",
  ".vercel",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);
const maxWorkspaceFiles = 50_000;

export type WorkspaceChange = {
  path: string;
  status: "added" | "deleted" | "modified";
};

export type WorkspaceSnapshot = {
  branch?: string;
  changes: WorkspaceChange[];
  files: string[];
  fileStates: Array<{ hash: string; path: string }>;
  git: boolean;
  revision: SourceRevisionRef;
};

export class WorkspaceFiles {
  readonly root: string;
  // Tools and stack traces may report the symlink-free spelling of the root
  // (for example /private/var for /var on macOS).
  private readonly physicalRoot: string;

  constructor(root: string) {
    this.root = resolve(root);
    this.physicalRoot = physicalPath(this.root);
  }

  async snapshot(signal?: AbortSignal): Promise<WorkspaceSnapshot> {
    signal?.throwIfAborted();
    const git = await this.isGitRepository();
    const baseCommit = git
      ? await this.gitOptional(["rev-parse", "HEAD"], signal)
      : undefined;
    const files = git
      ? await this.gitFiles(signal)
      : await this.walkFiles(this.root, signal);
    const changedPaths = git
      ? await this.gitChangedPaths(Boolean(baseCommit), signal)
      : files;
    const state = await this.changedState(changedPaths, baseCommit, signal);
    if (git) await this.markUntracked(state.changes, signal);
    const branch = git
      ? await this.gitOptional(["branch", "--show-current"], signal)
      : undefined;
    const revision = sourceRevision(baseCommit, state.entries);
    return {
      ...(branch ? { branch } : {}),
      changes: state.changes,
      files,
      fileStates: state.fileStates,
      git,
      revision,
    };
  }

  private async changedState(
    paths: string[],
    baseCommit: string | undefined,
    signal?: AbortSignal,
  ) {
    const entries: string[] = [];
    const fileStates: WorkspaceSnapshot["fileStates"] = [];
    const changes: WorkspaceChange[] = [];
    for (const path of paths.sort()) {
      signal?.throwIfAborted();
      const state = await this.pathState(path, signal);
      entries.push(`${path}\0${state.digest}\0${state.kind}`);
      fileStates.push({
        path,
        hash:
          state.kind === "file" ? state.contentHash :
          (state.kind === "gone" ? "absent" : state.digest),
      });
      changes.push({ path, status: changeStatus(state.kind, baseCommit) });
    }
    return { changes, entries, fileStates };
  }

  private async markUntracked(
    changes: WorkspaceChange[],
    signal?: AbortSignal,
  ) {
    const output = await this.git(
      ["ls-files", "--others", "--exclude-standard", "-z"],
      signal,
    );
    const untracked = new Set(nulList(output).filter(isHarnessSourcePath));
    for (const change of changes)
      if (untracked.has(change.path)) change.status = "added";
  }

  async read(path: string) {
    const absolute = await this.resolveExisting(path);
    const info = await stat(absolute);
    const content = await readFile(absolute);
    return {
      absolute,
      content,
      mode: info.mode & 0o777,
      path: this.normalizePath(path),
    };
  }

  async fileSize(path: string) {
    return (await stat(await this.resolveExisting(path))).size;
  }

  async readRange(path: string, range: [number, number]) {
    const file = await open(await this.resolveExisting(path), "r");
    const content = Buffer.alloc(range[1] - range[0]);
    try {
      const { bytesRead } = await file.read(
        content,
        0,
        content.byteLength,
        range[0],
      );
      return content.subarray(0, bytesRead);
    } finally {
      await file.close();
    }
  }

  async pathProfile(path: string) {
    const { metadata } = await this.resolveExistingPath(path);
    return { directory: metadata.isDirectory(), size: metadata.size };
  }

  async blobHash(path: string) {
    return sha256((await this.read(path)).content);
  }

  async baseline(path: string, signal?: AbortSignal, revision = "HEAD") {
    const normalized = this.normalizePath(path);
    const treeEntry = await this.gitOptional(
      ["ls-tree", revision, "--", normalized],
      signal,
    );
    if (!treeEntry) return null;
    const mode = Number.parseInt(treeEntry.split(/\s+/u)[0]!, 8) & 0o777;
    const content = await this.gitBuffer(
      ["show", `${revision}:${normalized}`],
      signal,
    );
    return { content, mode };
  }

  async committedChanges(previous?: string, current?: string) {
    if (previous === current) return [];
    const args = previous && current
      ? ["diff", "--no-renames", "--name-only", "-z", previous, current, "--"]
      : ["ls-tree", "-r", "--name-only", "-z", (previous ?? current)!];
    return nulList(await this.git(args)).filter(isHarnessSourcePath);
  }

  resolveForWrite(path: string) {
    const normalized = this.normalizePath(path);
    assertMutableWorkspacePath(normalized);
    return { absolute: resolve(this.root, normalized), path: normalized };
  }

  async resolveForWriteVerified(path: string) {
    const target = this.resolveForWrite(path);
    const root = await realpath(this.root);
    let ancestor = target.absolute;
    while (ancestor !== this.root) {
      try {
        const resolvedAncestor = await realpath(ancestor);
        const local = relative(root, resolvedAncestor);
        if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local))
          throw new Error("Write target resolves outside the workspace root.");
        return target;
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
        ancestor = resolve(ancestor, "..");
      }
    }
    return target;
  }

  normalizePath(path: string) {
    if (typeof path !== "string" || !path.trim() || path.includes("\0"))
      throw new Error("A non-empty workspace path is required.");
    const portable = path.replaceAll("\\", "/").replace(/^\.\//, "");
    const absolute = resolve(this.root, portable);
    const local = this.localPath(absolute);
    if (!local || local === ".") return ".";
    if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local))
      throw new Error("Path escapes the workspace root.");
    return local.split(sep).join("/");
  }

  private localPath(absolute: string) {
    const local = relative(this.root, absolute);
    if (this.physicalRoot === this.root || !escapesRoot(local)) return local;
    const physical = relative(this.physicalRoot, absolute);
    return escapesRoot(physical) ? local : physical;
  }

  private async resolveExisting(path: string) {
    const { metadata, resolved } = await this.resolveExistingPath(path);
    if (!metadata.isFile()) throw new Error("Target is not a regular file.");
    return resolved;
  }

  private async resolveExistingPath(path: string) {
    const normalized = this.normalizePath(path);
    const candidate = resolve(this.root, normalized);
    if ((await lstat(candidate)).isSymbolicLink())
      throw new Error(
        "Symbolic-link files are not supported by exact harness reads.",
      );
    const resolved = await realpath(candidate);
    const local = relative(await realpath(this.root), resolved);
    if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local))
      throw new Error("Resolved path escapes the workspace root.");
    const metadata = await stat(resolved);
    return { metadata, resolved };
  }

  private async pathState(path: string, signal?: AbortSignal) {
    try {
      const absolute = resolve(this.root, path);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        const target = await readlink(absolute);
        return { digest: sha256(target), kind: "symlink" as const };
      }
      if (!info.isFile())
        return { digest: sha256("non-file"), kind: "other" as const };
      return {
        ...await hashFileState(absolute, info.mode, signal),
        kind: "file" as const,
      };
    } catch (error) {
      if (errorCode(error) === "ENOENT")
        return { digest: sha256("gone"), kind: "gone" as const };
      throw error;
    }
  }

  private async isGitRepository() {
    return Boolean(await this.gitOptional(["rev-parse", "--show-toplevel"]));
  }

  private async gitFiles(signal?: AbortSignal) {
    const output = await this.git(
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      signal,
    );
    return unique(nulList(output).filter(isHarnessSourcePath)).slice(
      0,
      maxWorkspaceFiles,
    );
  }

  private async gitChangedPaths(hasHead: boolean, signal?: AbortSignal) {
    const tracked = hasHead
      ? nulList(
          await this.git(["diff", "--no-renames", "--name-only", "-z", "HEAD", "--"], signal),
        )
      : nulList(await this.git(["ls-files", "--cached", "-z"], signal));
    const untracked = nulList(
      await this.git(
        ["ls-files", "--others", "--exclude-standard", "-z"],
        signal,
      ),
    );
    return unique([...tracked, ...untracked].filter(isHarnessSourcePath));
  }

  private async walkFiles(
    directory: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const files: string[] = [];
    const visit = async (current: string) => {
      signal?.throwIfAborted();
      if (files.length >= maxWorkspaceFiles) return;
      for (const entry of await readdir(current, { withFileTypes: true })) {
        if (ignoredDirectories.has(entry.name)) continue;
        const absolute = resolve(current, entry.name);
        if (entry.isDirectory()) await visit(absolute);
        else if (entry.isFile())
          files.push(relative(this.root, absolute).split(sep).join("/"));
      }
    };
    await visit(directory);
    return files.sort();
  }

  private async git(args: string[], signal?: AbortSignal) {
    const { stdout } = await execFileAsync("git", args, {
      cwd: this.root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      signal,
    });
    return stdout;
  }

  private async gitBuffer(args: string[], signal?: AbortSignal) {
    const { stdout } = await execFileAsync("git", args, {
      cwd: this.root,
      encoding: null,
      maxBuffer: 32 * 1024 * 1024,
      signal,
    });
    return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  }

  private async gitOptional(args: string[], signal?: AbortSignal) {
    try {
      return (await this.git(args, signal)).trim() || undefined;
    } catch {
      return undefined;
    }
  }
}

function sourceRevision(baseCommit: string | undefined, entries: string[]) {
  const overlayMerkleRoot = sha256(entries.join("\n"));
  const sourceRevisionId = `src_${sha256(
    `${baseCommit ?? "no-git"}\0${overlayMerkleRoot}`,
  ).slice(0, 32)}`;
  return {
    source_revision_id: sourceRevisionId,
    ...(baseCommit ? { base_commit: baseCommit } : {}),
    overlay_merkle_root: overlayMerkleRoot,
  };
}

function changeStatus(
  kind: string,
  baseCommit: string | undefined,
): WorkspaceChange["status"] {
  if (kind === "gone") return "deleted";
  return baseCommit ? "modified" : "added";
}

export function languageName(path: string) {
  return languageByExtension[extname(path).toLowerCase()] ?? "unknown";
}

function isHarnessSourcePath(path: string) {
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.split("/");
  const basename = segments.at(-1)?.toLowerCase() ?? "";
  return (
    Boolean(path) &&
    !segments.some((segment) => ignoredDirectories.has(segment)) &&
    !segments.includes(".ssh") &&
    !(basename.startsWith(".env") && basename !== ".env.example") &&
    ![".npmrc", "id_rsa", "id_ed25519", "known_hosts"].includes(basename)
  );
}

export function assertMutableWorkspacePath(path: string) {
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.toLowerCase().split("/");
  const basename = segments.at(-1) ?? "";
  if (segments.includes("node_modules"))
    throw new Error(
      "Dependency internals are runtime-managed and excluded from code navigation and edits.",
    );
  if (
    segments.includes(".blame") ||
    segments.includes(".code-review-graph") ||
    segments.includes(".git") ||
    segments.includes(".ssh") ||
    (basename.startsWith(".env") && basename !== ".env.example") ||
    [".npmrc", "id_rsa", "id_ed25519", "known_hosts"].includes(basename)
  )
    throw new Error("Harness policy protects metadata and secret paths.");
}

function nulList(output: string) {
  return output.split("\0").filter(Boolean);
}

function unique(values: string[]) {
  return [...new Set(values)];
}

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}

const languageByExtension: Record<string, string> = {
  ".bash": "bash",
  ".bats": "bash",
  ".c": "c",
  ".cc": "cpp",
  ".cjs": "javascript",
  ".cpp": "cpp",
  ".cs": "csharp",
  ".css": "css",
  ".cts": "typescript",
  ".cxx": "cpp",
  ".go": "go",
  ".html": "html",
  ".htm": "html",
  ".h": "c",
  ".java": "java",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".mts": "typescript",
  ".hpp": "cpp",
  ".py": "python",
  ".rs": "rust",
  ".sh": "bash",
  ".svelte": "svelte",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".vue": "vue",
};

async function hashFileState(path: string, mode: number, signal?: AbortSignal) {
  const content = createHash("sha256");
  const state = createHash("sha256").update(`${mode & 0o777}\0`);
  for await (const chunk of createReadStream(path, { signal })) {
    content.update(chunk);
    state.update(chunk);
  }
  return { contentHash: content.digest("hex"), digest: state.digest("hex") };
}

function escapesRoot(local: string) {
  return local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local);
}

function physicalPath(path: string) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
