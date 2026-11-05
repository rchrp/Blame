import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { lock } from "proper-lockfile";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";
import { sha256 } from "./light-identity.js";
import type { WorkspaceFiles } from "./workspace-files.js";

export type LightFileMutation = {
  after: Buffer | null;
  before: Buffer | null;
  mode?: number;
  path: string;
};

export type LightCommitResult = {
  changedPaths: string[];
  sourceRevisionId: string;
};

export class LightCommitConflict extends Error {}

/** What holds a workspace's write lock: a short operation, or a managed command run. */
export type LockHolder = { label: string; run?: string };

/** Lock holders in this process, by lock directory, to say who keeps a workspace busy. */
const lockHolders = new Map<string, LockHolder>();

export class WorkspaceBusyError extends Error {
  constructor(holder: LockHolder | undefined) {
    super(busyMessage(holder));
  }
}

export class LightCommitService {
  private readonly files: WorkspaceFiles;
  private readonly lockDirectory: string;
  private readonly pendingFile: string;

  constructor(files: WorkspaceFiles) {
    this.files = files;
    this.lockDirectory = join(files.root, ".blame", "harness", "light-write");
    this.pendingFile = join(this.lockDirectory, "pending.json");
  }

  async commit(
    mutations: LightFileMutation[],
    expectedRevision: string,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    return this.exclusive(() =>
      this.commitLocked(mutations, expectedRevision, signal),
    );
  }

  async exclusive<T>(operation: () => Promise<T>, holder: LockHolder = { label: "an edit or a read" }) {
    // A managed command can hold the lock for minutes: say so now rather
    // than after the retries.
    const current = lockHolders.get(this.lockDirectory);
    if (current?.run) throw new WorkspaceBusyError(current);
    await mkdir(this.lockDirectory, { recursive: true, mode: 0o700 });
    const release = await lock(this.lockDirectory, lockOptions).catch((error: unknown) => {
      throw errorCode(error) === "ELOCKED"
        ? new WorkspaceBusyError(lockHolders.get(this.lockDirectory))
        : error;
    });
    lockHolders.set(this.lockDirectory, holder);
    try {
      await this.recoverInterruptedWrite();
      return await operation();
    } finally {
      lockHolders.delete(this.lockDirectory);
      await release();
    }
  }

  async restoreFiles(mutations: LightFileMutation[], requireOwnedState = false) {
    for (const mutation of [...mutations].reverse()) {
      if (requireOwnedState) {
        const current = contentHash(await optionalContent(this.files, mutation.path));
        if (current === contentHash(mutation.before)) continue;
        if (current !== contentHash(mutation.after))
          throw new LightCommitConflict(`Recovery preserved a concurrent change in ${mutation.path}.`);
      }
      await writeMutation(this.files, mutation, "before");
    }
  }

  private async recoverInterruptedWrite() {
    const source = await readFile(this.pendingFile, "utf8").catch((error) => {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    });
    if (!source) return;
    const mutations = pendingMutationsSchema
      .parse(JSON.parse(source))
      .map(decodeMutation);
    for (const mutation of mutations) {
      const current = contentHash(
        await optionalContent(this.files, mutation.path),
      );
      if (
        ![contentHash(mutation.before), contentHash(mutation.after)].includes(
          current,
        )
      )
        throw new LightCommitConflict(
          `Interrupted edit conflicts with a newer change in ${mutation.path}; automatic recovery preserved the worktree.`,
        );
    }
    await this.restoreFiles(mutations, true);
    await rm(this.pendingFile);
  }

  private async commitLocked(
    mutations: LightFileMutation[],
    expectedRevision: string,
    signal?: AbortSignal,
  ): Promise<LightCommitResult> {
    await this.assertRevision(expectedRevision);
    const changed = mutations.filter(mutationChangesContent);
    await Promise.all(changed.map((mutation) => this.verifyMutation(mutation)));
    signal?.throwIfAborted();
    await this.applyAll(changed);
    const snapshot = await this.files.snapshot();
    return {
      changedPaths: changed.map(({ path }) => path),
      sourceRevisionId: snapshot.revision.source_revision_id,
    };
  }

  private async assertRevision(expectedRevision: string) {
    const current = await this.files.snapshot();
    if (current.revision.source_revision_id !== expectedRevision)
      throw new LightCommitConflict(
        "The worktree changed while the edit batch was being prepared.",
      );
  }

  private async verifyMutation(mutation: LightFileMutation) {
    const path = this.files.normalizePath(mutation.path);
    if (path !== mutation.path)
      throw new LightCommitConflict(`Edit path is not canonical: ${path}.`);
    await this.files.resolveForWriteVerified(path);
    const current = await optionalContent(this.files, path);
    if (contentHash(current) !== contentHash(mutation.before))
      throw new LightCommitConflict(`File changed before commit: ${path}.`);
  }

  private async applyAll(mutations: LightFileMutation[]) {
    if (!mutations.length) return;
    await writeFileAtomic(
      this.pendingFile,
      JSON.stringify(mutations.map(encodeMutation)),
      { fsync: true, mode: 0o600 },
    );
    const applied: LightFileMutation[] = [];
    try {
      for (const mutation of mutations) {
        applied.push(mutation);
        await writeMutation(this.files, mutation, "after");
      }
    } catch (error) {
      await this.restoreFiles(applied, true).catch((rollbackError) => {
        throw new AggregateError(
          [error, rollbackError],
          "Edit rollback failed; recovery is pending.",
        );
      });
      await rm(this.pendingFile);
      throw error;
    }
    await rm(this.pendingFile);
  }
}

const lockOptions = {
  realpath: false,
  retries: { retries: 40, factor: 1.2, minTimeout: 25, maxTimeout: 1_000 },
  stale: 60_000,
  update: 10_000,
};

const pendingMutationsSchema = z.array(
  z
    .object({
      after: z.string().nullable(),
      before: z.string().nullable(),
      mode: z.number().int().optional(),
      path: z.string().min(1),
    })
    .strict(),
);

function encodeMutation(mutation: LightFileMutation) {
  return {
    ...mutation,
    after: mutation.after?.toString("base64") ?? null,
    before: mutation.before?.toString("base64") ?? null,
  };
}

function decodeMutation(
  mutation: z.infer<typeof pendingMutationsSchema>[number],
): LightFileMutation {
  return {
    ...mutation,
    after:
      mutation.after === null ? null : Buffer.from(mutation.after, "base64"),
    before:
      mutation.before === null ? null : Buffer.from(mutation.before, "base64"),
  };
}

async function writeMutation(
  files: WorkspaceFiles,
  mutation: LightFileMutation,
  field: "after" | "before",
) {
  const { absolute } = await files.resolveForWriteVerified(mutation.path);
  const content = mutation[field];
  if (content === null) return rm(absolute, { force: true });
  await mkdir(dirname(absolute), { recursive: true });
  await writeFileAtomic(absolute, content, {
    fsync: true,
    mode: mutation.mode ?? 0o644,
  });
}

async function optionalContent(files: WorkspaceFiles, path: string) {
  try {
    return (await files.read(path)).content;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

function mutationChangesContent(mutation: LightFileMutation) {
  return contentHash(mutation.before) !== contentHash(mutation.after);
}

function contentHash(content: Buffer | null) {
  return content ? sha256(content) : null;
}

function busyMessage(holder: LockHolder | undefined) {
  if (!holder)
    return "The workspace is busy: another Blame session or process is changing it. Retry in a moment.";
  const wait = holder.run
    ? ` Wait for it with run_task {"kind": "inspect", "run": "${holder.run}"}, then retry.`
    : " Retry once it finishes.";
  return `The workspace is busy: ${holder.label} is still running. Edits, reads and commands take turns so Blame can record what each one changes.${wait}`;
}

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}
