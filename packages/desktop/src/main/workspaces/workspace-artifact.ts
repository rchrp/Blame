import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { promisify } from "node:util";
import { createGzip } from "node:zlib";
import { pack } from "tar-stream";
import { pipeline } from "node:stream/promises";
import {
  currentWorkspaceSnapshotPolicy,
  gitignoreFileName,
  WorkspaceIgnore,
} from "@blame/preview-runtime/workspace-ignore";
import {
  forbiddenWorkspacePath,
  snapshotWorkspace,
  type WorkspaceSnapshot,
} from "./workspace-snapshot.ts";

const execFileAsync = promisify(execFile);
const archiveTimestamp = new Date(0);
const maximumArtifactBytes = 256 * 1024 * 1024;

export type BuiltWorkspaceArtifact = {
  content: Buffer;
  sha256: string;
  size: number;
  sourceRevision: string;
  workspaceHash: string;
  sanitizedTreeHash: string;
  lockfileHash: string;
  snapshot: WorkspaceSnapshot;
};

export type WorkspaceSourceMetadata = {
  sourceRevision: string;
  workspaceHash: string;
  sanitizedTreeHash: string;
  lockfileHash: string;
};

export type BuiltWorkspaceDeltaArtifact = {
  content: Buffer;
  sha256: string;
  size: number;
  sourceRevision: string;
  workspaceHash: string;
  sanitizedTreeHash: string;
  lockfileHash: string;
  baseHash: string;
  changed: string[];
  deleted: string[];
  snapshot: WorkspaceSnapshot;
};

type SnapshotFile = {
  type: "file" | "symlink";
  sha256: string;
  mode: number;
  size: number;
  target?: string;
};

type CanonicalEntry = {
  mode: "100644" | "100755" | "120000";
  type: "blob";
  object: string;
  path: string;
};

type CanonicalTree = {
  entries: CanonicalEntry[];
  files: Record<string, SnapshotFile>;
};

export type PreparedWorkspaceSource = {
  root: string;
  metadata: WorkspaceSourceMetadata;
  snapshot: WorkspaceSnapshot;
  canonical: CanonicalTree;
};

export async function prepareWorkspaceSource(
  root: string,
): Promise<PreparedWorkspaceSource> {
  const [sourceRevision, snapshot, canonical] = await Promise.all([
    git(root, ["rev-parse", "HEAD"]),
    snapshotWorkspace(root),
    canonicalTree(root),
  ]);
  return {
    root,
    snapshot,
    canonical,
    metadata: {
      sourceRevision,
      workspaceHash: snapshot.hash,
      sanitizedTreeHash: sanitizedTreeHash(canonical.entries),
      lockfileHash: lockfileHash(canonical.files),
    },
  };
}

export async function workspaceSourceMetadata(
  root: string,
): Promise<WorkspaceSourceMetadata> {
  return (await prepareWorkspaceSource(root)).metadata;
}

export async function buildWorkspaceArtifact(
  root: string,
  prepared?: PreparedWorkspaceSource,
  attempt = 0,
): Promise<BuiltWorkspaceArtifact> {
  const temporary = await mkdtemp(join(tmpdir(), "blame-workspace-artifact-"));
  try {
    const source =
      matchingPreparedSource(root, prepared) ??
      (await prepareWorkspaceSource(root));
    const { sourceRevision } = source.metadata;
    await assertPortableRepository(root);
    const snapshot = source.snapshot;
    const baseFiles = source.canonical.files;
    const sourceMetadata = source.metadata;
    const bundlePath = join(temporary, "repository.bundle");
    await createSanitizedBundle(
      root,
      temporary,
      bundlePath,
      source.canonical.entries,
    );
    const archive = pack();
    const chunks: Buffer[] = [];
    const gzip = createGzip({ level: 6 });
    gzip.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    const writing = pipeline(archive, gzip);
    // File streaming may reject first; the later await still drives retries.
    void writing.catch(() => undefined);
    try {
      archive.entry(
        {
          name: ".blame/source-manifest.json",
          mode: 0o600,
          mtime: archiveTimestamp,
        },
        JSON.stringify({
          version: 1,
          baseCommit: sourceRevision,
          workspaceHash: snapshot.hash,
          cleanWorkspaceHash: snapshotHash(baseFiles),
          snapshotPolicy: snapshotPolicyOf(snapshot),
          files: snapshot.files,
        }),
      );
      await appendDiskFile(
        archive,
        bundlePath,
        ".blame/repository.bundle",
        0o600,
      );
      for (const [path, metadata] of Object.entries(snapshot.files)) {
        const absolute = join(root, path);
        if (metadata.type === "symlink") {
          const target = await readlink(absolute);
          if (target !== metadata.target)
            throw new Error("Workspace symlink changed during upload");
          archive.entry({
            name: `workspace/${path}`,
            type: "symlink",
            linkname: target,
            mode: metadata.mode,
            mtime: archiveTimestamp,
          });
        } else {
          await appendDiskFile(
            archive,
            absolute,
            `workspace/${path}`,
            metadata.mode,
            metadata,
          );
        }
      }
      archive.finalize();
      await writing;
    } catch (error) {
      archive.destroy(error as Error);
      await writing.catch(() => undefined);
      if (attempt < 2)
        return buildWorkspaceArtifact(root, undefined, attempt + 1);
      throw new Error(
        "Workspace kept changing while its cloud artifact was built",
        {
          cause: error,
        },
      );
    }
    const [verified, verifiedRevision] = await Promise.all([
      snapshotWorkspace(root),
      git(root, ["rev-parse", "HEAD"]),
    ]);
    if (
      verified.hash !== snapshot.hash ||
      verifiedRevision !== sourceRevision
    ) {
      if (attempt < 2)
        return buildWorkspaceArtifact(root, undefined, attempt + 1);
      throw new Error(
        "Workspace kept changing while its cloud artifact was built",
      );
    }
    const content = Buffer.concat(chunks);
    if (content.byteLength < 1 || content.byteLength > maximumArtifactBytes) {
      throw new Error("Workspace artifact exceeds the managed transfer limit");
    }
    return {
      content,
      sha256: createHash("sha256").update(content).digest("hex"),
      size: content.byteLength,
      sourceRevision,
      workspaceHash: snapshot.hash,
      sanitizedTreeHash: sourceMetadata.sanitizedTreeHash,
      lockfileHash: sourceMetadata.lockfileHash,
      snapshot,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function buildWorkspaceDeltaArtifact(
  root: string,
  prepared?: PreparedWorkspaceSource,
  attempt = 0,
): Promise<BuiltWorkspaceDeltaArtifact> {
  const source =
    matchingPreparedSource(root, prepared) ??
    (await prepareWorkspaceSource(root));
  return buildWorkspaceDeltaFromSnapshot(
    root,
    source,
    {
      hash: snapshotHash(source.canonical.files),
      files: source.canonical.files,
      policy: source.snapshot.policy,
    },
    attempt,
    () => buildWorkspaceDeltaArtifact(root, undefined, attempt + 1),
  );
}

export async function buildWorkspaceIncrementalDeltaArtifact(
  root: string,
  base: WorkspaceSnapshot,
  attempt = 0,
): Promise<BuiltWorkspaceDeltaArtifact> {
  const [sourceRevision, snapshot] = await Promise.all([
    git(root, ["rev-parse", "HEAD"]),
    snapshotWorkspace(root),
  ]);
  const source = {
    metadata: {
      sourceRevision,
      workspaceHash: snapshot.hash,
      sanitizedTreeHash: snapshotHash(snapshot.files),
      lockfileHash: lockfileHash(snapshot.files),
    },
    snapshot,
  };
  return buildWorkspaceDeltaFromSnapshot(root, source, base, attempt, () =>
    buildWorkspaceIncrementalDeltaArtifact(root, base, attempt + 1),
  );
}

async function buildWorkspaceDeltaFromSnapshot(
  root: string,
  source: Pick<PreparedWorkspaceSource, "metadata" | "snapshot">,
  base: WorkspaceSnapshot,
  attempt: number,
  retry: () => Promise<BuiltWorkspaceDeltaArtifact>,
): Promise<BuiltWorkspaceDeltaArtifact> {
  const temporary = await mkdtemp(join(tmpdir(), "blame-workspace-delta-"));
  try {
    const metadata = source.metadata;
    const current = source.snapshot;
    if (snapshotPolicyOf(base) !== snapshotPolicyOf(current)) {
      throw new Error(
        "Workspace snapshot rules changed; synchronize the whole workspace",
      );
    }
    const baseFiles = base.files;
    const changed = Object.keys(current.files).filter(
      (path) => !sameSnapshotFile(baseFiles[path], current.files[path]),
    );
    const deleted = Object.keys(baseFiles).filter(
      (path) => !current.files[path],
    );
    const archive = pack();
    const chunks: Buffer[] = [];
    const gzip = createGzip({ level: 6 });
    gzip.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    const writing = pipeline(archive, gzip);
    // File streaming may reject first; the later await still drives retries.
    void writing.catch(() => undefined);
    try {
      archive.entry(
        {
          name: ".blame/delta-manifest.json",
          mode: 0o600,
          mtime: archiveTimestamp,
        },
        JSON.stringify({
          version: 1,
          snapshotPolicy: snapshotPolicyOf(current),
          generation: 0,
          revision: "0",
          baseHash: base.hash,
          finalHash: current.hash,
          changed,
          deleted,
          files: Object.fromEntries(
            changed.map((path) => [path, current.files[path]]),
          ),
          baseFiles: Object.fromEntries(
            [...changed, ...deleted].map((path) => [
              path,
              baseFiles[path] ?? null,
            ]),
          ),
        }),
      );
      for (const path of changed) {
        const file = current.files[path]!;
        const absolute = join(root, path);
        if (file.type === "symlink") {
          const target = await readlink(absolute);
          if (target !== file.target)
            throw new Error("Workspace symlink changed during delta build");
          archive.entry({
            name: `files/${path}`,
            type: "symlink",
            linkname: target,
            mode: file.mode,
            mtime: archiveTimestamp,
          });
        } else {
          await appendDiskFile(
            archive,
            absolute,
            `files/${path}`,
            file.mode,
            file,
          );
        }
      }
      archive.finalize();
      await writing;
    } catch (error) {
      archive.destroy(error as Error);
      await writing.catch(() => undefined);
      if (attempt < 2) return retry();
      throw new Error("Workspace kept changing while its delta was built", {
        cause: error,
      });
    }
    const [verified, verifiedRevision] = await Promise.all([
      snapshotWorkspace(root),
      git(root, ["rev-parse", "HEAD"]),
    ]);
    if (
      verified.hash !== metadata.workspaceHash ||
      verifiedRevision !== metadata.sourceRevision
    ) {
      if (attempt < 2) return retry();
      throw new Error("Workspace kept changing while its delta was built");
    }
    const content = Buffer.concat(chunks);
    if (content.byteLength < 1 || content.byteLength > maximumArtifactBytes) {
      throw new Error("Workspace delta exceeds the managed transfer limit");
    }
    return {
      content,
      sha256: createHash("sha256").update(content).digest("hex"),
      size: content.byteLength,
      sourceRevision: metadata.sourceRevision,
      workspaceHash: metadata.workspaceHash,
      sanitizedTreeHash: metadata.sanitizedTreeHash,
      lockfileHash: metadata.lockfileHash,
      baseHash: base.hash,
      changed,
      deleted,
      snapshot: current,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function matchingPreparedSource(
  root: string,
  prepared?: PreparedWorkspaceSource,
) {
  if (!prepared) return undefined;
  if (prepared.root !== root)
    throw new Error("Prepared workspace source belongs to another root");
  return prepared;
}

async function canonicalTree(root: string): Promise<CanonicalTree> {
  const entries = (await gitOutput(root, ["ls-tree", "-rz", "-r", "HEAD"]))
    .split("\0")
    .filter(Boolean)
    .map((entry): CanonicalEntry | undefined => {
      const separator = entry.indexOf("\t");
      const [mode, type, object] = entry.slice(0, separator).split(" ");
      const path = entry.slice(separator + 1);
      if (separator < 1 || !mode || !type || !object || !path) {
        throw new Error("Repository tree contains an invalid entry");
      }
      if (type === "commit")
        throw new Error("Cloud preview does not support Git submodules yet");
      if (type !== "blob" || !["100644", "100755", "120000"].includes(mode)) {
        throw new Error("Repository tree contains an unsupported entry");
      }
      if (forbiddenWorkspacePath(path)) return undefined;
      return {
        mode: mode as CanonicalEntry["mode"],
        type: "blob",
        object,
        path,
      };
    })
    .filter((entry): entry is CanonicalEntry => Boolean(entry))
    .sort((left, right) => left.path.localeCompare(right.path));
  const objects = await gitObjectMetadata(root, entries);
  const files: Record<string, SnapshotFile> = {};
  for (const entry of entries) {
    const object = objects.get(entry.object);
    if (!object) throw new Error("Repository object metadata is unavailable");
    if (entry.mode === "120000") {
      const target = object.target;
      if (target === undefined)
        throw new Error("Repository symlink target is unavailable");
      files[entry.path] = {
        type: "symlink",
        sha256: object.sha256,
        mode: 0o777,
        size: object.size,
        target,
      };
    } else {
      files[entry.path] = {
        type: "file",
        sha256: object.sha256,
        mode: entry.mode === "100755" ? 0o755 : 0o644,
        size: object.size,
      };
    }
  }
  return {
    entries,
    files: await synchronizedCanonicalFiles(root, entries, files),
  };
}

// The cloud runner hashes its checkout of HEAD with the snapshot rule, which
// reads the .gitignore files committed at HEAD; skip the same paths here.
async function synchronizedCanonicalFiles(
  root: string,
  entries: CanonicalEntry[],
  files: Record<string, SnapshotFile>,
) {
  const rules = new WorkspaceIgnore(currentWorkspaceSnapshotPolicy);
  if (rules.policy === "legacy") return files;
  for (const entry of entries) {
    if (entry.mode === "120000") continue;
    if (entry.path.split("/").at(-1) !== gitignoreFileName) continue;
    rules.add(
      dirname(entry.path),
      await gitOutput(root, ["cat-file", "blob", entry.object]),
    );
  }
  return Object.fromEntries(
    Object.entries(files).filter(([path]) => !rules.ignoresWithAncestors(path)),
  );
}

export function snapshotPolicyOf(snapshot: Pick<WorkspaceSnapshot, "policy">) {
  return snapshot.policy ?? "legacy";
}

function sameSnapshotFile(
  left: SnapshotFile | undefined,
  right: SnapshotFile | undefined,
) {
  return Boolean(
    left &&
    right &&
    left.type === right.type &&
    left.sha256 === right.sha256 &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.target === right.target,
  );
}

function snapshotHash(files: Record<string, SnapshotFile>) {
  const hash = createHash("sha256");
  for (const [path, metadata] of Object.entries(files).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    hash
      .update(path)
      .update("\0")
      .update(JSON.stringify(metadata))
      .update("\0");
  }
  return hash.digest("hex");
}

function sanitizedTreeHash(entries: CanonicalEntry[]) {
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

function lockfileHash(files: Record<string, { sha256: string }>) {
  const lockfiles = Object.entries(files)
    .filter(([path]) =>
      /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb|poetry\.lock|Cargo\.lock|uv\.lock)$/.test(
        path,
      ),
    )
    .sort(([left], [right]) => left.localeCompare(right));
  const hash = createHash("sha256");
  for (const [path, metadata] of lockfiles) {
    hash.update(path).update("\0").update(metadata.sha256).update("\0");
  }
  return hash.digest("hex");
}

async function gitObjectMetadata(root: string, entries: CanonicalEntry[]) {
  const objectIds = [...new Set(entries.map(({ object }) => object))];
  if (!objectIds.length)
    return new Map<string, { sha256: string; size: number; target?: string }>();
  const symlinkObjects = new Set(
    entries.filter(({ mode }) => mode === "120000").map(({ object }) => object),
  );
  const child = spawn("git", ["-C", root, "cat-file", "--batch"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr: Buffer[] = [];
  child.stdin.on("error", () => undefined);
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const completion = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `Git object batch failed: ${Buffer.concat(stderr).toString("utf8").trim()}`,
          ),
        );
    });
  });
  child.stdin.end(`${objectIds.join("\n")}\n`);
  const reader = new GitBatchReader(child.stdout);
  const result = new Map<
    string,
    { sha256: string; size: number; target?: string }
  >();
  try {
    for (const requestedObject of objectIds) {
      const header = await reader.readLine();
      const [object, type, sizeText] = header.split(" ");
      const size = Number(sizeText);
      if (
        object !== requestedObject ||
        type !== "blob" ||
        !Number.isSafeInteger(size) ||
        size < 0
      ) {
        throw new Error("Repository object batch returned invalid metadata");
      }
      const hash = createHash("sha256");
      const targetChunks = symlinkObjects.has(object)
        ? ([] as Buffer[])
        : undefined;
      await reader.consume(size, (chunk) => {
        hash.update(chunk);
        targetChunks?.push(Buffer.from(chunk));
      });
      if ((await reader.readByte()) !== 0x0a) {
        throw new Error(
          "Repository object batch returned an invalid terminator",
        );
      }
      result.set(object, {
        sha256: hash.digest("hex"),
        size,
        target: targetChunks
          ? Buffer.concat(targetChunks).toString("utf8")
          : undefined,
      });
    }
    await completion;
    return result;
  } catch (error) {
    child.kill();
    await completion.catch(() => undefined);
    throw error;
  }
}

class GitBatchReader {
  private readonly iterator: AsyncIterator<Buffer>;
  private current = Buffer.alloc(0);
  private offset = 0;

  constructor(stream: Readable) {
    this.iterator = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  }

  async readLine() {
    const chunks: Buffer[] = [];
    while (true) {
      await this.ensureCurrent();
      const end = this.current.indexOf(0x0a, this.offset);
      if (end >= 0) {
        chunks.push(this.current.subarray(this.offset, end));
        this.offset = end + 1;
        return Buffer.concat(chunks).toString("utf8");
      }
      chunks.push(this.current.subarray(this.offset));
      this.offset = this.current.length;
    }
  }

  async consume(bytes: number, consume: (chunk: Buffer) => void) {
    let remaining = bytes;
    while (remaining > 0) {
      await this.ensureCurrent();
      const length = Math.min(remaining, this.current.length - this.offset);
      consume(this.current.subarray(this.offset, this.offset + length));
      this.offset += length;
      remaining -= length;
    }
  }

  async readByte() {
    let byte = -1;
    await this.consume(1, (chunk) => {
      byte = chunk[0]!;
    });
    return byte;
  }

  private async ensureCurrent() {
    if (this.offset < this.current.length) return;
    const next = await this.iterator.next();
    if (next.done)
      throw new Error("Repository object batch ended unexpectedly");
    this.current = Buffer.from(next.value);
    this.offset = 0;
  }
}

async function appendDiskFile(
  archive: ReturnType<typeof pack>,
  path: string,
  name: string,
  mode: number,
  expected?: { sha256: string; size: number },
) {
  const stat = await lstat(path);
  const size = expected?.size ?? stat.size;
  const entry = archive.entry({ name, mode, size, mtime: archiveTimestamp });
  if (!expected) {
    await pipeline(createReadStream(path), entry);
    return;
  }
  const hash = createHash("sha256");
  let bytes = 0;
  const verifier = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.byteLength;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(createReadStream(path), verifier, entry);
  if (bytes !== size || hash.digest("hex") !== expected.sha256) {
    throw new Error("Workspace file changed during upload");
  }
}

async function assertPortableRepository(root: string) {
  const submodules = await git(root, [
    "ls-files",
    "--stage",
    "--",
    ".gitmodules",
  ]);
  if (submodules)
    throw new Error("Cloud preview does not support Git submodules yet");
  const attributes = await readFile(join(root, ".gitattributes"), "utf8").catch(
    () => "",
  );
  if (/filter\s*=\s*lfs/i.test(attributes))
    throw new Error("Cloud preview does not support Git LFS yet");
}

async function createSanitizedBundle(
  root: string,
  temporary: string,
  bundlePath: string,
  entries: CanonicalEntry[],
) {
  const repository = join(temporary, "repository");
  await mkdir(repository, { recursive: true });
  const objectFormat = await git(root, ["rev-parse", "--show-object-format"]);
  await git(repository, [
    "init",
    "--quiet",
    "--initial-branch=main",
    `--object-format=${objectFormat}`,
  ]);
  const commonDirectory = await git(root, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  const objectInfoDirectory = join(repository, ".git", "objects", "info");
  await mkdir(objectInfoDirectory, { recursive: true });
  await writeFile(
    join(objectInfoDirectory, "alternates"),
    `${join(commonDirectory, "objects")}\n`,
    {
      mode: 0o600,
    },
  );
  const indexFile = join(repository, ".git", "blame-preview-index");
  const indexEnvironment = { GIT_INDEX_FILE: indexFile };
  const index = entries
    .map(
      ({ mode, type, object, path }) => `${mode} ${type} ${object}\t${path}\0`,
    )
    .join("");
  await gitWithInput(
    repository,
    ["update-index", "-z", "--index-info"],
    index,
    indexEnvironment,
  );
  const tree = await git(repository, ["write-tree"], indexEnvironment);
  const identity = {
    GIT_AUTHOR_NAME: "Blame",
    GIT_AUTHOR_EMAIL: "preview@blame.local",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_NAME: "Blame",
    GIT_COMMITTER_EMAIL: "preview@blame.local",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
  };
  const commit = await git(
    repository,
    ["commit-tree", tree, "-m", "Blame managed preview snapshot"],
    identity,
  );
  await git(repository, ["update-ref", "refs/heads/main", commit]);
  await git(repository, ["bundle", "create", bundlePath, "refs/heads/main"]);
}

async function gitWithInput(
  root: string,
  args: string[],
  input: string,
  environment?: Record<string, string>,
) {
  const child = spawn("git", ["-C", root, ...args], {
    env: { ...process.env, ...environment },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdin.on("error", () => undefined);
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  child.stdin.end(input);
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `Git command failed: ${Buffer.concat(stderr).toString("utf8").trim()}`,
          ),
        );
    });
  });
  return Buffer.concat(stdout).toString("utf8");
}

async function git(
  root: string,
  args: string[],
  environment?: Record<string, string>,
) {
  return (await gitOutput(root, args, environment)).trim();
}

async function gitOutput(
  root: string,
  args: string[],
  environment?: Record<string, string>,
) {
  const { stdout } = await execFileAsync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...environment },
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}
