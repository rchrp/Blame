import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, readlink, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Transform } from "node:stream";
import { createGzip } from "node:zlib";
import { pack } from "tar-stream";
import { pipeline } from "node:stream/promises";
import type { RunnerUploadTarget } from "../protocol/runner-contract.js";
import { runnerError } from "../protocol/runner-errors.js";
import { runtimePaths } from "../runtime-paths.js";
import { readRuntimeState } from "../runtime-state.js";
import { checkpointChangeJournal } from "./change-journal.js";
import { acknowledgeChangeJournal } from "./change-journal.js";
import { readWorkspaceSnapshotPolicy } from "./workspace-snapshot.js";

type PreparedDelta = {
  artifactId: string;
  path: string;
  sha256: string;
  size: number;
  baseHash: string;
  finalHash: string;
  generation: number;
  revision: string;
};

const archiveTimestamp = new Date(0);
const maximumDeltaBytes = 256 * 1024 * 1024;

export async function prepareSourceDelta(
  artifactId: string,
  requestedRevision: string,
  attempt = 0,
) {
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(artifactId)) {
    throw runnerError("DELTA_ARTIFACT_INVALID", "Delta artifact ID is invalid.");
  }
  const journal = await checkpointChangeJournal();
  const runtime = await readRuntimeState();
  const changed = Object.entries(journal.current.files)
    .filter(([path, current]) => !sameMetadata(journal.base.files[path], current))
    .map(([path]) => path);
  const deleted = Object.keys(journal.base.files).filter((path) => !journal.current.files[path]);
  const revision = String(journal.revision);
  if (Number(requestedRevision) > journal.revision) {
    throw runnerError("DELTA_REVISION_INVALID", "Requested journal revision is ahead of the runner.");
  }
  await mkdir(runtimePaths.exports, { recursive: true, mode: 0o700 });
  const archivePath = join(runtimePaths.exports, `${artifactId}.tar.gz`);
  const archive = pack();
  const output = createWriteStream(archivePath, { mode: 0o600 });
  const writing = pipeline(archive, createGzip({ level: 6 }), output);
  const manifest = {
    version: 1,
    snapshotPolicy: journal.current.policy ?? (await readWorkspaceSnapshotPolicy()),
    generation: runtime.generation,
    revision,
    baseHash: journal.base.hash,
    finalHash: journal.current.hash,
    changed,
    deleted,
    files: Object.fromEntries(
      changed.map((path) => [path, journal.current.files[path]]),
    ),
    baseFiles: Object.fromEntries(
      [...changed, ...deleted].map((path) => [path, journal.base.files[path] ?? null]),
    ),
  };
  try {
    archive.entry(
      { name: ".blame/delta-manifest.json", mode: 0o600, mtime: archiveTimestamp },
      JSON.stringify(manifest),
    );
    for (const path of changed) {
      const metadata = journal.current.files[path]!;
      if (metadata.type === "symlink") {
        const target = await readlink(join(runtimePaths.workspace, path));
        if (target !== metadata.target) throw new Error("Workspace symlink changed during export.");
        archive.entry({
          name: `files/${path}`,
          type: "symlink",
          linkname: target,
          mode: metadata.mode,
          mtime: archiveTimestamp,
        });
      } else {
        await appendFile(archive, path, metadata.mode, metadata.size, metadata.sha256);
      }
    }
    archive.finalize();
    await writing;
  } catch (error) {
    archive.destroy(error as Error);
    await writing.catch(() => undefined);
    await rm(archivePath, { force: true });
    if (attempt < 2) return prepareSourceDelta(artifactId, requestedRevision, attempt + 1);
    throw runnerError(
      "WORKSPACE_CHANGED_DURING_EXPORT",
      "Workspace kept changing while its recovery delta was exported.",
    );
  }
  const verified = await checkpointChangeJournal();
  if (verified.current.hash !== journal.current.hash) {
    await rm(archivePath, { force: true });
    if (attempt < 2) return prepareSourceDelta(artifactId, requestedRevision, attempt + 1);
    throw runnerError(
      "WORKSPACE_CHANGED_DURING_EXPORT",
      "Workspace kept changing while its recovery delta was exported.",
    );
  }
  const archiveSize = (await stat(archivePath)).size;
  if (archiveSize < 1 || archiveSize > maximumDeltaBytes) {
    await rm(archivePath, { force: true });
    throw runnerError("DELTA_SIZE_INVALID", "Workspace delta exceeds its durable transfer limit.");
  }
  const prepared: PreparedDelta = {
    artifactId,
    path: archivePath,
    sha256: await fileSha256(archivePath),
    size: archiveSize,
    baseHash: journal.base.hash,
    finalHash: journal.current.hash,
    generation: runtime.generation,
    revision,
  };
  await writeFile(`${archivePath}.json`, JSON.stringify(prepared), { mode: 0o600, flush: true });
  return publicPrepared(prepared);
}

export function sameMetadata(
  left: { type: string; sha256: string; mode: number; size: number; target?: string } | undefined,
  right: { type: string; sha256: string; mode: number; size: number; target?: string },
) {
  return Boolean(
    left &&
    left.type === right.type &&
    left.sha256 === right.sha256 &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.target === right.target,
  );
}

async function fileSha256(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function acknowledgeSourceDelta(revision: string) {
  await acknowledgeChangeJournal(revision);
  await cleanupAcknowledgedExports(revision);
  return { acknowledged: true };
}

export async function uploadSourceDelta(artifactId: string, upload: RunnerUploadTarget) {
  const metadataPath = join(runtimePaths.exports, `${artifactId}.tar.gz.json`);
  const prepared = JSON.parse(await readFile(metadataPath, "utf8")) as PreparedDelta;
  const url = new URL(upload.url);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw runnerError("DELTA_UPLOAD_URL_INVALID", "Delta upload URL is invalid.");
  }
  if (Date.parse(upload.expiresAt) <= Date.now()) {
    throw runnerError("DELTA_UPLOAD_EXPIRED", "Delta upload URL has expired.");
  }
  const response = await fetch(url, {
    method: "PUT",
    headers: upload.headers,
    body: createReadStream(prepared.path) as unknown as BodyInit,
    duplex: "half",
    redirect: "error",
  } as RequestInit & { duplex: "half" });
  if (!response.ok) throw runnerError("DELTA_UPLOAD_FAILED", "Delta upload failed.");
  return publicPrepared(prepared);
}

async function appendFile(
  archive: ReturnType<typeof pack>,
  path: string,
  mode: number,
  size: number,
  expectedSha256: string,
) {
  const input = createReadStream(join(runtimePaths.workspace, path));
  const entry = archive.entry({ name: `files/${path}`, mode, size, mtime: archiveTimestamp });
  const hash = createHash("sha256");
  let bytes = 0;
  const verifier = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.byteLength;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(input, verifier, entry);
  if (bytes !== size || hash.digest("hex") !== expectedSha256) {
    throw new Error("Workspace file changed during export.");
  }
}

function publicPrepared(prepared: PreparedDelta) {
  const { path: _path, ...result } = prepared;
  return result;
}

async function cleanupAcknowledgedExports(revision: string) {
  const acknowledged = Number(revision);
  const entries = await readdir(runtimePaths.exports).catch(() => []);
  for (const name of entries) {
    if (!name.endsWith(".tar.gz.json")) continue;
    const metadataPath = join(runtimePaths.exports, name);
    try {
      const prepared = JSON.parse(await readFile(metadataPath, "utf8")) as PreparedDelta;
      if (!/^\d+$/.test(prepared.revision) || Number(prepared.revision) > acknowledged) continue;
      await Promise.all([
        rm(metadataPath, { force: true }),
        rm(metadataPath.slice(0, -".json".length), { force: true }),
      ]);
    } catch {}
  }
}
