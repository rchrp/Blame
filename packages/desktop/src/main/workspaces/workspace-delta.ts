import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
  chmod,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { extract } from "tar-stream";
import {
  parseWorkspaceSnapshotPolicy,
  type WorkspaceSnapshotPolicy,
} from "@blame/preview-runtime/workspace-ignore";
import { WorkspaceSyncConflict } from "./workspace-sync-conflict.ts";
import {
  assertSafeSymlink,
  forbiddenWorkspacePath,
  snapshotWorkspace,
  type WorkspaceFileMetadata,
} from "./workspace-snapshot.ts";

type DeltaManifest = {
  version: 1;
  // The rule the runner hashed with; older runners omit it ("legacy").
  snapshotPolicy: WorkspaceSnapshotPolicy;
  generation: number;
  revision: string;
  baseHash: string;
  finalHash: string;
  changed: string[];
  deleted: string[];
  files: Record<string, WorkspaceFileMetadata>;
  baseFiles: Record<string, WorkspaceFileMetadata | null>;
};

type ArchiveEntry = {
  content?: Buffer;
  linkname?: string;
  mode: number;
  type: "file" | "symlink";
};

export async function applyWorkspaceDelta(input: {
  root: string;
  content: Uint8Array;
  sha256: string;
  size: number;
  expectedBaseHash?: string | null;
  expectedFinalHash?: string | null;
  expectedGeneration?: number | null;
}) {
  if (
    input.content.byteLength !== input.size ||
    input.size > 256 * 1024 * 1024
  ) {
    throw new Error("Workspace delta size mismatch");
  }
  const sha256 = createHash("sha256").update(input.content).digest("hex");
  if (sha256 !== input.sha256)
    throw new Error("Workspace delta checksum mismatch");
  const entries = await readDeltaArchive(input.content);
  const manifestEntry = entries.get(".blame/delta-manifest.json");
  if (!manifestEntry?.content)
    throw new Error("Workspace delta manifest is missing");
  const manifest = validateManifest(
    JSON.parse(manifestEntry.content.toString("utf8")),
  );
  if (input.expectedBaseHash && input.expectedBaseHash !== manifest.baseHash)
    throw new Error("Delta base hash metadata mismatch");
  if (input.expectedFinalHash && input.expectedFinalHash !== manifest.finalHash)
    throw new Error("Delta final hash metadata mismatch");
  if (
    input.expectedGeneration !== null &&
    input.expectedGeneration !== undefined &&
    input.expectedGeneration !== manifest.generation
  )
    throw new Error("Delta generation metadata mismatch");
  const current = await snapshotWorkspace(input.root, manifest.snapshotPolicy);
  if (current.hash !== manifest.baseHash) {
    throw new WorkspaceSyncConflict(
      "The local worktree changed during the remote writer lease",
    );
  }
  validateChangedFiles(entries, manifest);
  await applyTransaction(input.root, entries, manifest);
  const final = await snapshotWorkspace(input.root, manifest.snapshotPolicy);
  if (final.hash !== manifest.finalHash) {
    throw new WorkspaceSyncConflict(
      "Applied workspace hash does not match the durable remote delta",
    );
  }
  return { revision: manifest.revision, finalHash: final.hash };
}

async function applyTransaction(
  root: string,
  entries: Map<string, ArchiveEntry>,
  manifest: DeltaManifest,
) {
  const transaction = await mkdtemp(
    join(dirname(root), ".blame-workspace-sync-"),
  );
  const staged = join(transaction, "staged");
  const backup = join(transaction, "backup");
  const paths = [...new Set([...manifest.changed, ...manifest.deleted])].sort();
  const replaced = new Set<string>();
  try {
    for (const path of manifest.changed) {
      const metadata = manifest.files[path]!;
      const entry = entries.get(`files/${path}`)!;
      const target = join(staged, path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      if (metadata.type === "symlink") await symlink(entry.linkname!, target);
      else {
        await writeFile(target, entry.content!, { mode: metadata.mode });
        await chmod(target, metadata.mode);
      }
    }
    for (const path of paths) {
      await assertSafeDestination(root, path);
      const target = join(root, path);
      const previous = join(backup, path);
      if (await exists(target)) {
        await mkdir(dirname(previous), { recursive: true, mode: 0o700 });
        await rename(target, previous);
        replaced.add(path);
      }
      if (manifest.changed.includes(path)) {
        await mkdir(dirname(target), { recursive: true });
        await rename(join(staged, path), target);
      }
    }
    const snapshot = await snapshotWorkspace(root, manifest.snapshotPolicy);
    if (snapshot.hash !== manifest.finalHash)
      throw new Error("Final workspace hash mismatch");
  } catch (error) {
    for (const path of paths.reverse()) {
      const target = join(root, path);
      await rm(target, { recursive: true, force: true });
      if (replaced.has(path)) {
        await mkdir(dirname(target), { recursive: true });
        await rename(join(backup, path), target);
      }
    }
    throw error;
  } finally {
    await rm(transaction, { recursive: true, force: true });
  }
}

async function readDeltaArchive(content: Uint8Array) {
  const entries = new Map<string, ArchiveEntry>();
  let expandedBytes = 0;
  const parser = extract();
  const completion = new Promise<void>((resolve, reject) => {
    parser.on("entry", async (header, stream, next) => {
      try {
        const path = safeArchivePath(header.name);
        if (entries.has(path) || entries.size >= 25_000)
          throw new Error("Duplicate or excessive delta entries");
        if (header.type === "file") {
          const chunks: Buffer[] = [];
          for await (const chunk of stream) {
            if (!Buffer.isBuffer(chunk)) throw new Error("Archive stream emitted non-binary data.");
            expandedBytes += Buffer.byteLength(chunk);
            if (expandedBytes > 1_000_000_000)
              throw new Error("Delta expands beyond its limit");
            chunks.push(Buffer.from(chunk));
          }
          entries.set(path, {
            type: "file",
            content: Buffer.concat(chunks),
            mode: header.mode ?? 0o600,
          });
          next();
        } else if (header.type === "symlink") {
          entries.set(path, {
            type: "symlink",
            linkname: header.linkname ?? undefined,
            mode: header.mode ?? 0o777,
          });
          stream.resume();
          stream.once("end", next);
        } else throw new Error("Unsupported delta archive entry");
      } catch (error) {
        stream.resume();
        reject(error);
      }
    });
    parser.once("finish", resolve);
    parser.once("error", reject);
  });
  Readable.from(Buffer.from(content)).pipe(createGunzip()).pipe(parser);
  await completion;
  return entries;
}

function validateManifest(value: unknown): DeltaManifest {
  if (!value || typeof value !== "object")
    throw new Error("Workspace delta manifest is invalid");
  const manifest = value as Partial<DeltaManifest>;
  if (
    manifest.version !== 1 ||
    typeof manifest.revision !== "string" ||
    !Number.isSafeInteger(manifest.generation) ||
    Number(manifest.generation) < 0 ||
    !/^[a-f0-9]{64}$/i.test(manifest.baseHash ?? "") ||
    !/^[a-f0-9]{64}$/i.test(manifest.finalHash ?? "") ||
    !Array.isArray(manifest.changed) ||
    !Array.isArray(manifest.deleted) ||
    !manifest.files ||
    !manifest.baseFiles
  )
    throw new Error("Workspace delta manifest is invalid");
  const all = [...manifest.changed, ...manifest.deleted];
  if (new Set(all).size !== all.length)
    throw new Error("Workspace delta paths overlap");
  for (const path of all) {
    safeArchivePath(path);
    if (forbiddenWorkspacePath(path))
      throw new Error("Workspace delta targets a forbidden path");
  }
  const folded = new Map<string, string>();
  for (const path of all) {
    const key = path.normalize("NFC").toLocaleLowerCase("en-US");
    if (folded.has(key) && folded.get(key) !== path)
      throw new Error("Workspace delta has case-colliding paths");
    folded.set(key, path);
  }
  return {
    ...(manifest as DeltaManifest),
    snapshotPolicy: parseWorkspaceSnapshotPolicy(manifest.snapshotPolicy),
  };
}

function validateChangedFiles(
  entries: Map<string, ArchiveEntry>,
  manifest: DeltaManifest,
) {
  for (const path of manifest.changed) {
    const metadata = manifest.files[path];
    const entry = entries.get(`files/${path}`);
    if (!metadata || !entry || metadata.type !== entry.type)
      throw new Error("Workspace delta file metadata is invalid");
    if (entry.type === "symlink") {
      assertSafeSymlink(path, entry.linkname ?? "");
      if (
        createHash("sha256")
          .update(entry.linkname ?? "")
          .digest("hex") !== metadata.sha256
      ) {
        throw new Error("Workspace delta symlink checksum mismatch");
      }
    } else if (
      entry.content?.byteLength !== metadata.size ||
      createHash("sha256")
        .update(entry.content ?? Buffer.alloc(0))
        .digest("hex") !== metadata.sha256
    )
      throw new Error("Workspace delta file checksum mismatch");
  }
  for (const path of entries.keys()) {
    if (
      path !== ".blame/delta-manifest.json" &&
      !manifest.changed.some((item) => `files/${item}` === path)
    ) {
      throw new Error("Workspace delta contains an undeclared file");
    }
  }
}

function safeArchivePath(value: string) {
  const normalized = value.replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[a-z]:/i.test(normalized) ||
    normalized.includes("\0") ||
    normalized.split("/").some((segment) => !segment || segment === "..")
  ) {
    throw new Error("Workspace delta path traversal rejected");
  }
  return normalized;
}

async function assertSafeDestination(root: string, path: string) {
  const segments = path.split("/").slice(0, -1);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    const stat = await lstat(current).catch(() => undefined);
    if (stat?.isSymbolicLink())
      throw new Error("Workspace delta destination crosses a symlink");
  }
}

async function exists(path: string) {
  return lstat(path).then(
    () => true,
    () => false,
  );
}
