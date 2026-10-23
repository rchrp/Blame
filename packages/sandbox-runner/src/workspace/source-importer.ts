import { createHash } from "node:crypto";
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { extract } from "tar-stream";
import {
  chmod,
  chown,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import type { SourceArtifact } from "@blame/preview-runtime";
import { runtimePaths } from "../runtime-paths.js";
import {
  checkpointChangeJournal,
  initializeChangeJournal,
  localView,
} from "./change-journal.js";
import { runnerError } from "../protocol/runner-errors.js";
import {
  addDirectoryGitignore,
  snapshotWorkspace,
  writeWorkspaceSnapshotPolicy,
} from "./workspace-snapshot.js";
import {
  parseWorkspaceSnapshotPolicy,
  WorkspaceIgnore,
  type WorkspaceSnapshotPolicy,
} from "@blame/preview-runtime/workspace-ignore";

type SourceManifest = {
  version: 1;
  baseCommit: string;
  workspaceHash: string;
  cleanWorkspaceHash?: string;
  snapshotPolicy?: string;
  files: Record<
    string,
    {
      type: "file" | "symlink";
      sha256: string;
      mode: number;
      size: number;
      target?: string;
    }
  >;
};

export async function importSourceArtifact(source: SourceArtifact) {
  if (!source.downloadUrl) throw runnerError("SOURCE_URL_MISSING", "Source download URL is missing.");
  if (!Number.isSafeInteger(source.size) || source.size < 1 || source.size > 256 * 1024 * 1024) {
    throw runnerError("SOURCE_SIZE_INVALID", "Source size is outside the permitted range.");
  }
  if (!/^[a-f0-9]{64}$/i.test(source.sha256)) {
    throw runnerError("SOURCE_HASH_INVALID", "Source checksum is invalid.");
  }
  const url = validatedHttpsUrl(source.downloadUrl);
  const response = await fetch(url, { redirect: "error" });
  if (!response.ok || !response.body) {
    throw runnerError("SOURCE_DOWNLOAD_FAILED", "Unable to download source artifact.");
  }
  const content = await readBoundedResponse(response.body, source.size);
  if (createHash("sha256").update(content).digest("hex") !== source.sha256) {
    throw runnerError("SOURCE_HASH_MISMATCH", "Source checksum mismatch.");
  }
  if (source.mode === "delta")
    return applySourceDelta(content, source.revision, source.baseHash, source.workspaceHash);
  const staging = await mkdtemp(join(tmpdir(), "blame-source-"));
  try {
    await extractArchive(content, staging);
    const manifest = JSON.parse(await readFile(join(staging, ".blame/source-manifest.json"), "utf8")) as SourceManifest;
    validateManifest(manifest, source.mode === "baseline");
    const policy = parseWorkspaceSnapshotPolicy(manifest.snapshotPolicy);
    await reconstructWorkspace(staging, manifest, source.mode === "baseline", policy);
    await writeWorkspaceSnapshotPolicy(policy);
    const journal = await initializeChangeJournal();
    const expectedWorkspaceHash = source.mode === "baseline" ? manifest.cleanWorkspaceHash : manifest.workspaceHash;
    if (!expectedWorkspaceHash || journal.current.hash !== expectedWorkspaceHash) {
      throw runnerError("SOURCE_RECONSTRUCTION_MISMATCH", "Reconstructed workspace hash mismatch.");
    }
    return {
      sourceRevision: source.revision,
      workspaceHash: journal.current.hash,
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function readBoundedResponse(stream: ReadableStream<Uint8Array>, expectedSize: number) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > expectedSize) {
        await reader.cancel("Source artifact exceeded its declared size");
        throw runnerError("SOURCE_SIZE_MISMATCH", "Source size mismatch.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (received !== expectedSize) {
    throw runnerError("SOURCE_SIZE_MISMATCH", "Source size mismatch.");
  }
  const content = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return content;
}

async function applySourceDelta(
  content: Uint8Array,
  sourceRevision: string,
  expectedBaseHash?: string,
  expectedFinalHash?: string,
) {
  const staging = await mkdtemp(join(tmpdir(), "blame-source-delta-"));
  try {
    await extractArchive(content, staging, true);
    const manifest = JSON.parse(await readFile(join(staging, ".blame/delta-manifest.json"), "utf8")) as {
      version: number;
      baseHash: string;
      finalHash: string;
      changed: string[];
      deleted: string[];
      files: Record<string, SourceManifest["files"][string]>;
      snapshotPolicy?: string;
    };
    if (
      manifest.version !== 1 ||
      !/^[a-f0-9]{64}$/i.test(manifest.baseHash) ||
      !/^[a-f0-9]{64}$/i.test(manifest.finalHash) ||
      !Array.isArray(manifest.changed) ||
      !Array.isArray(manifest.deleted) ||
      new Set([...manifest.changed, ...manifest.deleted]).size !== manifest.changed.length + manifest.deleted.length
    ) {
      throw runnerError("SOURCE_DELTA_INVALID", "Source delta manifest is invalid.");
    }
    validateDeltaManifest(manifest);
    if (expectedBaseHash && manifest.baseHash !== expectedBaseHash) {
      throw runnerError("SOURCE_DELTA_INVALID", "Source delta base hash metadata does not match its manifest.");
    }
    if (expectedFinalHash && manifest.finalHash !== expectedFinalHash) {
      throw runnerError("SOURCE_DELTA_INVALID", "Source delta final hash metadata does not match its manifest.");
    }
    const policy = parseWorkspaceSnapshotPolicy(manifest.snapshotPolicy);
    // Tool changes since the last checkpoint become drift first, so the base
    // is compared with the workspace as the local worktree sent it.
    const drift = (await checkpointChangeJournal())?.drift ?? {};
    const touched = new Set([...manifest.changed, ...manifest.deleted]);
    const remainingDrift = Object.fromEntries(
      Object.entries(drift).filter(([path]) => !touched.has(path)),
    );
    const current = localView(await snapshotWorkspace(undefined, policy), drift, policy);
    if (current.hash !== manifest.baseHash) {
      throw runnerError("SOURCE_BASELINE_MISMATCH", "Source delta base does not match the restored baseline.");
    }
    for (const path of manifest.changed) {
      const metadata = manifest.files[path];
      const staged = safePath(staging, `files/${path}`);
      if (!metadata || !staged) throw runnerError("SOURCE_DELTA_INVALID", "Source delta file metadata is invalid.");
      const stat = await lstat(staged);
      if (metadata.type === "symlink") {
        const target = await readlink(staged);
        assertSymlink("/workspace", join("/workspace", path), target);
        if (target !== metadata.target || createHash("sha256").update(target).digest("hex") !== metadata.sha256) {
          throw runnerError("SOURCE_DELTA_INVALID", "Source delta symlink checksum mismatch.");
        }
      } else {
        const file = await readFile(staged);
        if (stat.size !== metadata.size || createHash("sha256").update(file).digest("hex") !== metadata.sha256) {
          throw runnerError("SOURCE_DELTA_INVALID", "Source delta file checksum mismatch.");
        }
      }
    }
    const transaction = await mkdtemp(join(tmpdir(), "blame-source-apply-"));
    const backup = join(transaction, "backup");
    const paths = [...new Set([...manifest.changed, ...manifest.deleted])].sort();
    const replaced = new Set<string>();
    try {
      for (const path of paths) {
        await assertSafeDestination(runtimePaths.workspace, path);
        const target = join(runtimePaths.workspace, path);
        const previous = join(backup, path);
        if (await exists(target)) {
          await mkdir(dirname(previous), { recursive: true, mode: 0o700 });
          await rename(target, previous);
          replaced.add(path);
        }
        if (manifest.changed.includes(path)) {
          await mkdir(dirname(target), { recursive: true, mode: 0o700 });
          await rename(safePath(staging, `files/${path}`), target);
          await chmod(target, manifest.files[path]!.mode);
        }
      }
      const final = localView(await snapshotWorkspace(undefined, policy), remainingDrift, policy);
      if (final.hash !== manifest.finalHash)
        throw runnerError("SOURCE_DELTA_INVALID", "Source delta final hash mismatch.");
    } catch (error) {
      for (const path of paths.reverse()) {
        const target = join(runtimePaths.workspace, path);
        await rm(target, { recursive: true, force: true });
        if (replaced.has(path)) {
          await mkdir(dirname(target), { recursive: true, mode: 0o700 });
          await rename(join(backup, path), target);
        }
      }
      throw error;
    } finally {
      await rm(transaction, { recursive: true, force: true });
    }
    await writeWorkspaceSnapshotPolicy(policy);
    const journal = await initializeChangeJournal(remainingDrift);
    return { sourceRevision, workspaceHash: journal.current.hash };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function extractArchive(content: Uint8Array, root: string, delta = false) {
  const parser = extract();
  let entries = 0;
  let expandedBytes = 0;
  const maximumEntryBytes = 256 * 1024 * 1024;
  const maximumExpandedBytes = 2 * 1024 * 1024 * 1024;
  const completion = new Promise<void>((resolve, reject) => {
    parser.on("entry", async (header, stream, next) => {
      try {
        entries += 1;
        if (entries > 25_000) throw new Error("Archive entry limit exceeded.");
        const portablePath = safePortablePath(header.name);
        if (delta) assertAllowedDeltaArchivePath(portablePath);
        else assertAllowedArchivePath(portablePath);
        const path = safePath(root, portablePath);
        if (header.type === "directory") await mkdir(path, { recursive: true, mode: 0o700 });
        else if (header.type === "file") {
          if ((header.size ?? 0) > maximumEntryBytes) throw new Error("Archive entry is too large.");
          await mkdir(dirname(path), { recursive: true, mode: 0o700 });
          const chunks: Buffer[] = [];
          let entryBytes = 0;
          for await (const chunk of stream) {
            entryBytes += Buffer.byteLength(chunk);
            expandedBytes += Buffer.byteLength(chunk);
            if (entryBytes > maximumEntryBytes || expandedBytes > maximumExpandedBytes) {
              throw new Error("Archive expanded size limit exceeded.");
            }
            chunks.push(Buffer.from(chunk));
          }
          await writeFile(path, Buffer.concat(chunks), {
            mode: (header.mode ?? 0o600) & 0o777,
          });
          next();
          return;
        } else if (header.type === "symlink") {
          await mkdir(dirname(path), { recursive: true, mode: 0o700 });
          assertSymlink(root, path, header.linkname ?? "");
          await symlink(header.linkname!, path);
        } else throw new Error("Unsupported archive entry type.");
        stream.resume();
        stream.once("end", next);
      } catch (error) {
        stream.resume();
        reject(error);
      }
    });
    parser.once("finish", resolve);
    parser.once("error", reject);
  });
  const readable = Readable.from(Buffer.from(content));
  if (content[0] === 0x1f && content[1] === 0x8b) readable.pipe(createGunzip()).pipe(parser);
  else readable.pipe(parser);
  await completion;
}

async function reconstructWorkspace(
  staging: string,
  manifest: SourceManifest,
  baseline: boolean,
  policy: WorkspaceSnapshotPolicy,
) {
  const bundle = join(staging, ".blame/repository.bundle");
  const next = `${runtimePaths.workspace}.next-${process.pid}`;
  const backup = `${runtimePaths.workspace}.previous-${process.pid}`;
  await rm(next, { recursive: true, force: true });
  await cloneCanonicalBundle(bundle, next);
  await pruneReconstructedClone(next, Object.keys(manifest.files), baseline, policy);
  if (!baseline) {
    const overlay = join(staging, "workspace");
    try {
      if ((await lstat(overlay)).isDirectory())
        await cp(overlay, next, {
          recursive: true,
          force: true,
          dereference: false,
        });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await makeGitReadonly(join(next, ".git"));
  const identity = await projectIdentity();
  await recursiveChown(next, identity.uid, identity.gid);
  await rm(backup, { recursive: true, force: true });
  try {
    await rename(runtimePaths.workspace, backup);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await rename(next, runtimePaths.workspace);
  await rm(backup, { recursive: true, force: true });
}

export function cloneCanonicalBundle(bundle: string, destination: string) {
  return git([
    "clone",
    "--no-hardlinks",
    "--branch",
    "main",
    "--single-branch",
    bundle,
    destination,
  ]);
}

// Removes committed files the local worktree no longer has. Paths the
// snapshot rule skips are not synchronized, so their committed copy stays.
export async function pruneReconstructedClone(
  root: string,
  allowedPaths: string[],
  baseline: boolean,
  policy: WorkspaceSnapshotPolicy = "legacy",
) {
  if (baseline) return;
  await pruneClone(root, new Set(allowedPaths), new WorkspaceIgnore(policy));
}

async function pruneClone(
  root: string,
  allowed: Set<string>,
  rules: WorkspaceIgnore,
  directory = root,
) {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(directory, { withFileTypes: true });
  await addDirectoryGitignore(rules, root, directory, entries);
  for (const entry of entries) {
    if (directory === root && entry.name === ".git") continue;
    const absolute = join(directory, entry.name);
    const relative = absolute.slice(root.length + 1).replaceAll("\\", "/");
    if (rules.ignores(relative, entry.isDirectory())) continue;
    if (entry.isDirectory()) {
      await pruneClone(root, allowed, rules, absolute);
      if (!(await readdir(absolute)).length) await rm(absolute, { recursive: true, force: true });
    } else if (!allowed.has(relative)) await rm(absolute, { force: true });
  }
}

async function makeGitReadonly(path: string) {
  for (const entry of await import("node:fs/promises").then(({ readdir }) => readdir(path, { withFileTypes: true }))) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await makeGitReadonly(child);
    else await chmod(child, 0o444);
  }
  await chmod(path, 0o555);
}

async function recursiveChown(path: string, uid: number, gid: number) {
  const stat = await lstat(path);
  if (!path.includes("/.git") && !path.endsWith("/.git")) await chown(path, uid, gid);
  if (!stat.isDirectory()) return;
  for (const entry of await import("node:fs/promises").then(({ readdir }) => readdir(path))) {
    await recursiveChown(join(path, entry), uid, gid);
  }
}

function safePath(root: string, value: string) {
  const portable = safePortablePath(value);
  const normalized = normalize(portable);
  const path = join(root, normalized);
  if (!path.startsWith(`${root}/`)) throw new Error("Archive path escapes staging.");
  return path;
}

function safePortablePath(value: string) {
  const portable = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    !portable ||
    portable.startsWith("/") ||
    /^[a-z]:/i.test(portable) ||
    portable.includes("\0") ||
    portable.split("/").some((segment) => segment === ".." || segment === "")
  ) {
    throw new Error("Archive path traversal rejected.");
  }
  return portable;
}

function assertAllowedArchivePath(path: string) {
  if (path === ".blame/source-manifest.json" || path === ".blame/repository.bundle") return;
  if (!path.startsWith("workspace/")) throw new Error("Unexpected source archive namespace.");
  assertAllowedWorkspacePath(path.slice("workspace/".length));
}

function assertAllowedDeltaArchivePath(path: string) {
  if (path === ".blame/delta-manifest.json") return;
  if (!path.startsWith("files/")) throw new Error("Unexpected source delta namespace.");
  assertAllowedWorkspacePath(path.slice("files/".length));
}

async function assertSafeDestination(root: string, path: string) {
  const segments = path.split("/").slice(0, -1);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    const stat = await lstat(current).catch(() => undefined);
    if (stat?.isSymbolicLink()) throw runnerError("SOURCE_DELTA_INVALID", "Source delta crosses a symlink.");
  }
}

async function exists(path: string) {
  return lstat(path).then(
    () => true,
    () => false
  );
}

function assertAllowedWorkspacePath(path: string) {
  const segments = path.toLowerCase().split("/");
  const basename = segments.at(-1) ?? "";
  if (
    segments.includes(".git") ||
    segments.includes(".ssh") ||
    segments.includes("node_modules") ||
    segments.includes(".next") ||
    segments.includes("dist") ||
    segments.includes("coverage") ||
    (basename.startsWith(".env") && basename !== ".env.example") ||
    [".npmrc", "id_rsa", "id_ed25519", "known_hosts"].includes(basename) ||
    path.toLowerCase() === ".docker/config.json" ||
    basename.endsWith(".log")
  ) {
    throw new Error("Source archive contains a forbidden path.");
  }
}

function validateDeltaManifest(manifest: {
  changed: string[];
  deleted: string[];
  files: Record<string, SourceManifest["files"][string]>;
}) {
  const changed = new Set(manifest.changed);
  const deleted = new Set(manifest.deleted);
  const folded = new Map<string, string>();
  for (const path of [...changed, ...deleted]) {
    safePortablePath(path);
    assertAllowedWorkspacePath(path);
    const key = path.normalize("NFC").toLocaleLowerCase("en-US");
    if (folded.has(key) && folded.get(key) !== path) {
      throw runnerError("SOURCE_DELTA_INVALID", "Source delta paths collide by case.");
    }
    folded.set(key, path);
  }
  for (const path of changed) {
    const metadata = manifest.files[path];
    if (!metadata) throw runnerError("SOURCE_DELTA_INVALID", "Source delta metadata is incomplete.");
    validateSourceFileMetadata(path, metadata);
  }
  for (const path of deleted) {
    if (manifest.files[path] !== undefined) {
      throw runnerError("SOURCE_DELTA_INVALID", "Source delta deletion metadata is inconsistent.");
    }
  }
  for (const path of Object.keys(manifest.files)) {
    if (!changed.has(path)) {
      throw runnerError("SOURCE_DELTA_INVALID", "Source delta contains an unexpected file metadata entry.");
    }
  }
}

function validateSourceFileMetadata(path: string, metadata: SourceManifest["files"][string]) {
  if (
    !metadata ||
    !["file", "symlink"].includes(metadata.type) ||
    !/^[a-f0-9]{64}$/i.test(metadata.sha256) ||
    !Number.isSafeInteger(metadata.mode) ||
    metadata.mode < 0 ||
    metadata.mode > 0o777 ||
    !Number.isSafeInteger(metadata.size) ||
    metadata.size < 0 ||
    metadata.size > 256 * 1024 * 1024
  ) {
    throw runnerError("SOURCE_DELTA_INVALID", "Source delta metadata is invalid.");
  }
  if (metadata.type === "symlink") {
    if (metadata.target === undefined) {
      throw runnerError("SOURCE_DELTA_INVALID", "Source delta symlink metadata is incomplete.");
    }
    assertSymlink("/workspace", join("/workspace", path), metadata.target);
  } else if (metadata.target !== undefined) {
    throw runnerError("SOURCE_DELTA_INVALID", "Source delta file metadata is inconsistent.");
  }
}

function assertSymlink(root: string, path: string, target: string) {
  if (!target || target.startsWith("/")) throw new Error("Unsafe source symlink.");
  const resolved = normalize(join(dirname(path), target));
  if (!resolved.startsWith(`${root}/`)) throw new Error("Source symlink escapes staging.");
}

function validateManifest(value: SourceManifest, baseline = false) {
  if (
    value.version !== 1 ||
    !/^[a-f0-9]{40,64}$/i.test(value.baseCommit) ||
    !/^[a-f0-9]{64}$/i.test(value.workspaceHash) ||
    (value.cleanWorkspaceHash !== undefined && !/^[a-f0-9]{64}$/i.test(value.cleanWorkspaceHash)) ||
    !value.files ||
    typeof value.files !== "object"
  ) {
    throw runnerError("SOURCE_MANIFEST_INVALID", "Source manifest is invalid.");
  }
  if (baseline && !value.cleanWorkspaceHash) {
    throw runnerError("SOURCE_MANIFEST_INVALID", "Baseline source manifest is missing its clean tree hash.");
  }
  if (Object.keys(value.files).length > 25_000) {
    throw runnerError("SOURCE_MANIFEST_INVALID", "Source manifest contains too many files.");
  }
  const folded = new Map<string, string>();
  for (const [path, metadata] of Object.entries(value.files)) {
    safePortablePath(path);
    assertAllowedWorkspacePath(path);
    const caseKey = path.normalize("NFC").toLocaleLowerCase("en-US");
    if (folded.has(caseKey) && folded.get(caseKey) !== path) {
      throw runnerError("SOURCE_MANIFEST_INVALID", "Source manifest paths collide by case.");
    }
    folded.set(caseKey, path);
    if (
      !metadata ||
      !["file", "symlink"].includes(metadata.type) ||
      !/^[a-f0-9]{64}$/i.test(metadata.sha256) ||
      !Number.isSafeInteger(metadata.mode) ||
      metadata.mode < 0 ||
      metadata.mode > 0o777 ||
      !Number.isSafeInteger(metadata.size) ||
      metadata.size < 0 ||
      metadata.size > 256 * 1024 * 1024
    ) {
      throw runnerError("SOURCE_MANIFEST_INVALID", "Source file metadata is invalid.");
    }
    if (metadata.type === "symlink") {
      if (metadata.target === undefined) {
        throw runnerError("SOURCE_MANIFEST_INVALID", "Source symlink metadata is incomplete.");
      }
      assertSymlink("/workspace", join("/workspace", path), metadata.target);
    } else if (metadata.target !== undefined) {
      throw runnerError("SOURCE_MANIFEST_INVALID", "Source file metadata is inconsistent.");
    }
  }
}

function validatedHttpsUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw runnerError("SOURCE_URL_INVALID", "Source URL is invalid.");
  }
  return url;
}

function git(args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("git", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`Git reconstruction failed: ${stderr.slice(0, 500)}`))
    );
  });
}

async function projectIdentity() {
  return { uid: await idValue("-u"), gid: await idValue("-g") };
}

function idValue(flag: string) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn("id", [flag, "blame-project"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      const value = Number(stdout.trim());
      code === 0 && Number.isSafeInteger(value) ? resolve(value) : reject(new Error("Project user missing."));
    });
  });
}
