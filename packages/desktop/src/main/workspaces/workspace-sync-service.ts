import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  ATTR_BLAME_OPERATION_STATUS,
  ATTR_BLAME_RUNTIME_NAME,
  ATTR_BLAME_RUNTIME_PHASE,
  getBlameTelemetry,
} from "@blame/telemetry";
import {
  CloudPreviewRequestError,
  isBaselineSnapshotUnavailable,
  type CloudPreviewClient,
} from "../preview-runtime/cloud-preview-client.ts";
import {
  buildWorkspaceArtifact,
  buildWorkspaceDeltaArtifact,
  buildWorkspaceIncrementalDeltaArtifact,
  prepareWorkspaceSource,
  snapshotPolicyOf,
  type BuiltWorkspaceDeltaArtifact,
  type PreparedWorkspaceSource,
} from "./workspace-artifact.ts";
import type { LiveSyncState, LiveSyncStatus } from "@blame/preview-runtime";
import { currentWorkspaceSnapshotPolicy } from "@blame/preview-runtime/workspace-ignore";
import { applyWorkspaceDelta } from "./workspace-delta.ts";
import { WorkspaceSyncConflict } from "./workspace-sync-conflict.ts";
import { workspaceSourceMode } from "./baseline-transfer.ts";
import {
  forbiddenWorkspacePath,
  snapshotWorkspace,
  type WorkspaceSnapshot,
} from "./workspace-snapshot.ts";

const maximumArtifactBytes = 256 * 1024 * 1024;
const liveSyncDebounceMilliseconds = 450;
const liveSyncRetryMilliseconds = 1_500;

type PreviewSession = Awaited<ReturnType<CloudPreviewClient["get"]>>;

type LiveSyncResult = {
  session: PreviewSession;
  pending: boolean;
  synchronized: boolean;
  changedFiles?: number;
  reason?: string;
  source?: Awaited<ReturnType<WorkspaceSyncService["syncInitial"]>>;
};

type LiveSyncRegistration = {
  client: CloudPreviewClient;
  root: string;
  watcher?: FSWatcher;
  poller?: NodeJS.Timeout;
  timer?: NodeJS.Timeout;
  syncing?: Promise<void>;
  dirty: boolean;
};

export class WorkspaceSyncService {
  private readonly workspaces = new Map<string, string>();
  private readonly sessionsByWorkspace = new Map<string, string>();
  private readonly syncingBack = new Map<
    string,
    Promise<Awaited<ReturnType<WorkspaceSyncService["performSyncBack"]>>>
  >();
  private readonly preparedSources = new Map<string, PreparedWorkspaceSource>();
  private readonly preparedDeltas = new Map<
    string,
    Promise<BuiltWorkspaceDeltaArtifact>
  >();
  private readonly synchronizedSnapshots = new Map<string, WorkspaceSnapshot>();
  private readonly live = new Map<string, LiveSyncRegistration>();
  private readonly statuses = new Map<string, LiveSyncStatus>();
  private readonly indexPath?: string;
  private readonly snapshotIndexPath?: string;
  private readonly onLiveSyncError: (error: unknown) => void;
  private persistence = Promise.resolve();
  private loaded = false;

  constructor(
    indexPath?: string,
    onLiveSyncError: (error: unknown) => void = () => undefined,
  ) {
    this.indexPath = indexPath;
    this.snapshotIndexPath = indexPath
      ? `${indexPath}.snapshots.json`
      : undefined;
    this.onLiveSyncError = onLiveSyncError;
  }

  async prepareInitial(localPath: string) {
    const root = await realpath(localPath);
    const prepared = await measureWorkspacePhase("workspace.capture", () =>
      prepareWorkspaceSource(root),
    );
    this.preparedSources.set(root, prepared);
    const delta = buildWorkspaceDeltaArtifact(root, prepared);
    this.preparedDeltas.set(root, delta);
    void delta.catch(() => undefined);
    return prepared.metadata;
  }

  async syncInitial(
    client: CloudPreviewClient,
    sessionId: string,
    localPath: string,
    beforeTransfer?: (root: string) => void | Promise<void>,
  ) {
    const root = await realpath(localPath);
    await beforeTransfer?.(root);
    const prepared =
      this.preparedSources.get(root) ??
      (await measureWorkspacePhase("workspace.capture", () =>
        prepareWorkspaceSource(root),
      ));
    const preparedDelta = this.preparedDeltas.get(root);
    this.preparedSources.delete(root);
    this.preparedDeltas.delete(root);
    let negotiation = await client.negotiateSource(
      sessionId,
      prepared.metadata,
    );
    if (negotiation.session.state.host === "failed") {
      await client.command(sessionId, { type: "resume-host" }, randomUUID());
      negotiation = await client.negotiateSource(sessionId, prepared.metadata);
    }
    let recoveredExpiredBaseline = false;
    while (true) {
      if (negotiation.unchanged) {
        await measureWorkspacePhase(
          "workspace.sync.skip",
          async () => undefined,
        );
        await this.remember(sessionId, root, prepared.snapshot);
        return {
          session: negotiation.session,
          sourceRevision: prepared.metadata.sourceRevision,
          workspaceHash: prepared.metadata.workspaceHash,
        };
      }
      const sourceMode = workspaceSourceMode(negotiation.baseline);
      const artifact = await measureWorkspacePhase(
        sourceMode === "delta"
          ? "workspace.delta.build"
          : "workspace.full.build",
        () =>
          sourceMode === "delta"
            ? (preparedDelta ?? buildWorkspaceDeltaArtifact(root, prepared))
            : buildWorkspaceArtifact(root, prepared),
      );
      const target = await client.prepareSourceUpload(sessionId, {
        ...artifact,
        mode: sourceMode,
      });
      await measureWorkspacePhase("workspace.upload", () =>
        upload(target, artifact.content),
      );
      try {
        const session = await measureWorkspacePhase("workspace.apply", () =>
          client.applySourceUpload(
            sessionId,
            target.artifactId,
            negotiation.baseline?.id,
          ),
        );
        await this.remember(sessionId, root, artifact.snapshot);
        return {
          session,
          sourceRevision: artifact.sourceRevision,
          workspaceHash: artifact.workspaceHash,
        };
      } catch (error) {
        if (
          recoveredExpiredBaseline ||
          sourceMode !== "delta" ||
          !isBaselineSnapshotUnavailable(error)
        ) {
          throw error;
        }
        recoveredExpiredBaseline = true;
        await client.command(sessionId, { type: "resume-host" }, randomUUID());
        negotiation = await client.negotiateSource(
          sessionId,
          prepared.metadata,
        );
      }
    }
  }

  syncBack(
    client: CloudPreviewClient,
    sessionId: string,
    localPath?: string,
    beforeTransfer?: (root: string) => void | Promise<void>,
  ) {
    const current = this.syncingBack.get(sessionId);
    if (current) return current;
    const operation = this.performSyncBack(
      client,
      sessionId,
      localPath,
      beforeTransfer,
    ).finally(() => {
      if (this.syncingBack.get(sessionId) === operation)
        this.syncingBack.delete(sessionId);
    });
    this.syncingBack.set(sessionId, operation);
    return operation;
  }

  private async performSyncBack(
    client: CloudPreviewClient,
    sessionId: string,
    localPath?: string,
    beforeTransfer?: (root: string) => void | Promise<void>,
  ) {
    await this.load();
    const attached = localPath ? await realpath(localPath) : undefined;
    const remembered = this.workspaces.get(sessionId);
    if (remembered && attached && remembered !== attached) {
      throw new Error(
        "Cloud preview is attached to a different local worktree",
      );
    }
    const root = remembered ?? attached;
    if (!root)
      throw new Error("Cloud preview has no registered local worktree");
    await beforeTransfer?.(root);
    await this.remember(sessionId, root);
    const delta = await client.exportSourceDelta(sessionId);
    const content = await download(delta.url, delta.size);
    let applied: Awaited<ReturnType<typeof applyWorkspaceDelta>>;
    try {
      applied = await applyWorkspaceDelta({
        root,
        content,
        sha256: delta.sha256,
        size: delta.size,
        expectedBaseHash: delta.baseHash,
        expectedFinalHash: delta.finalHash,
        expectedGeneration: delta.generation,
      });
    } catch (error) {
      if (error instanceof WorkspaceSyncConflict) {
        await client
          .command(sessionId, { type: "report-sync-conflict" }, randomUUID())
          .catch(() => undefined);
      }
      throw error;
    }
    const session = await client.command(
      sessionId,
      {
        type: "ack-local-sync",
        deltaRevision: delta.revision ?? applied.revision,
        workspaceHash: applied.finalHash,
      },
      randomUUID(),
    );
    await this.remember(sessionId, root, await snapshotWorkspace(root));
    return { session, ...applied };
  }

  /** What live sync is doing for a session, for the preview toolbar. */
  liveStatus(sessionId: string): LiveSyncStatus | undefined {
    return this.statuses.get(sessionId);
  }

  async syncLive(
    client: CloudPreviewClient,
    sessionId: string,
    localPath?: string,
  ) {
    try {
      const result = await this.performSyncLive(client, sessionId, localPath);
      if (result.synchronized) {
        this.setLiveStatus(sessionId, "synced", {
          changedFiles: result.changedFiles,
          synced: true,
        });
      } else if (result.pending || result.reason) {
        this.setLiveStatus(sessionId, result.pending ? "waiting" : "idle", {
          reason: result.reason,
        });
      } else {
        this.setLiveStatus(sessionId, "synced");
      }
      return result;
    } catch (error) {
      this.setLiveStatus(sessionId, "error", {
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private setLiveStatus(
    sessionId: string,
    state: LiveSyncState,
    detail: { changedFiles?: number; reason?: string; synced?: boolean } = {},
  ) {
    const previous = this.statuses.get(sessionId);
    const now = new Date().toISOString();
    this.statuses.set(sessionId, {
      state,
      updatedAt:
        previous?.state === state && !detail.synced ? previous.updatedAt : now,
      syncedAt: detail.synced ? now : previous?.syncedAt,
      changedFiles: detail.synced
        ? detail.changedFiles
        : previous?.changedFiles,
      reason: detail.reason,
      sequence: (previous?.sequence ?? 0) + (detail.synced ? 1 : 0),
    });
  }

  private async performSyncLive(
    client: CloudPreviewClient,
    sessionId: string,
    localPath?: string,
  ): Promise<LiveSyncResult> {
    await this.load();
    const attached = localPath ? await realpath(localPath) : undefined;
    const remembered = this.workspaces.get(sessionId);
    if (remembered && attached && remembered !== attached) {
      throw new Error(
        "Cloud preview is attached to a different local worktree",
      );
    }
    const root = remembered ?? attached;
    if (!root)
      throw new Error("Cloud preview has no registered local worktree");
    const session = await client.get(sessionId);
    if (session.desired.host !== "active" || session.state.host !== "running") {
      return {
        session,
        pending: false,
        synchronized: false,
        reason: "The cloud preview is not running.",
      };
    }
    if (session.state.sync === "failed" && !session.pendingDeltaArtifactId) {
      return this.restartWithCurrentWorkspace(client, sessionId, root, session);
    }
    if (session.state.engine === "failed") {
      return this.restartWithCurrentWorkspace(client, sessionId, root, session);
    }
    if (
      !["idle", "running", "stopped"].includes(session.state.engine) ||
      session.state.sync !== "clean" ||
      session.state.agent !== "idle"
    ) {
      return {
        session,
        pending: true,
        synchronized: false,
        reason: liveSyncWaitingReason(session),
      };
    }
    let base = this.synchronizedSnapshots.get(sessionId);
    // A base hashed with another snapshot rule (or before rules existed)
    // cannot anchor a delta: resynchronize once with the current rule.
    if (
      !base ||
      base.hash !== session.workspaceHash ||
      snapshotPolicyOf(base) !== currentWorkspaceSnapshotPolicy
    ) {
      const current = await snapshotWorkspace(root);
      if (current.hash === session.workspaceHash) {
        await this.remember(sessionId, root, current);
        return { session, pending: false, synchronized: false };
      }
      return this.restartWithCurrentWorkspace(client, sessionId, root, session);
    }
    const artifact = await measureWorkspacePhase(
      "workspace.live_delta.build",
      () => buildWorkspaceIncrementalDeltaArtifact(root, base!),
    );
    if (!artifact.changed.length && !artifact.deleted.length) {
      await this.remember(sessionId, root, artifact.snapshot);
      return { session, pending: false, synchronized: false };
    }
    if (dependencyInputsChanged([...artifact.changed, ...artifact.deleted])) {
      return this.restartWithCurrentWorkspace(client, sessionId, root, session);
    }
    const changedFiles = artifact.changed.length + artifact.deleted.length;
    this.setLiveStatus(sessionId, "syncing", { changedFiles });
    const target = await client.prepareSourceUpload(sessionId, {
      ...artifact,
      mode: "delta",
    });
    await measureWorkspacePhase("workspace.live_delta.upload", () =>
      upload(target, artifact.content),
    );
    try {
      const updated = await measureWorkspacePhase(
        "workspace.live_delta.apply",
        () => client.applySourceUpload(sessionId, target.artifactId),
      );
      if (updated.workspaceHash !== artifact.workspaceHash) {
        throw new Error(
          "Cloud preview acknowledged an unexpected workspace hash",
        );
      }
      await this.remember(sessionId, root, artifact.snapshot);
      return {
        session: updated,
        pending: false,
        synchronized: true,
        changedFiles,
      };
    } catch (error) {
      const observed = await client.get(sessionId).catch(() => undefined);
      if (
        observed?.workspaceHash === artifact.workspaceHash &&
        observed.state.sync === "clean"
      ) {
        await this.remember(sessionId, root, artifact.snapshot);
        return {
          session: observed,
          pending: false,
          synchronized: true,
          changedFiles,
        };
      }
      if (!liveSyncRequiresRestart(error)) throw error;
      const current = observed ?? (await client.get(sessionId));
      if (current.state.agent !== "idle" || current.pendingDeltaArtifactId) {
        return {
          session: current,
          pending: true,
          synchronized: false,
          reason: liveSyncWaitingReason(current),
        };
      }
      return this.restartWithCurrentWorkspace(client, sessionId, root, current);
    }
  }

  async attachLive(
    client: CloudPreviewClient,
    sessionId: string,
    localPath: string,
  ) {
    await this.load();
    const root = await realpath(localPath);
    const existing = this.live.get(sessionId);
    if (existing?.client === client && existing.root === root) return;
    this.detachLive(sessionId);
    const registration: LiveSyncRegistration = {
      client,
      root,
      dirty: true,
    };
    this.live.set(sessionId, registration);
    try {
      registration.watcher = watch(
        root,
        { recursive: true },
        (_event, filename) => {
          const path = filename?.toString().replaceAll("\\", "/");
          if (path && forbiddenWorkspacePath(path)) return;
          registration.dirty = true;
          this.scheduleLiveSync(sessionId, liveSyncDebounceMilliseconds);
        },
      );
      registration.watcher.on("error", (error) => {
        if (this.live.get(sessionId) !== registration) return;
        this.onLiveSyncError(error);
        registration.watcher?.close();
        registration.watcher = undefined;
        this.startLivePolling(sessionId, registration);
      });
    } catch (error) {
      this.onLiveSyncError(error);
      this.startLivePolling(sessionId, registration);
    }
    this.scheduleLiveSync(sessionId, liveSyncDebounceMilliseconds);
  }

  wakeLive(sessionId: string) {
    const registration = this.live.get(sessionId);
    if (!registration) return;
    registration.dirty = true;
    this.scheduleLiveSync(sessionId, 0);
  }

  async flushLive(sessionId: string) {
    const registration = this.live.get(sessionId);
    if (!registration) return;
    if (registration.timer) {
      clearTimeout(registration.timer);
      registration.timer = undefined;
    }
    await registration.syncing;
    if (this.live.get(sessionId) !== registration) return;
    if (registration.timer) {
      clearTimeout(registration.timer);
      registration.timer = undefined;
    }
    registration.dirty = false;
    const syncing = this.syncLive(
      registration.client,
      sessionId,
      registration.root,
    )
      .then((result) => {
        if (result.pending)
          throw new Error(
            "Cloud preview live sync is waiting for the remote workspace",
          );
      })
      .catch((error) => {
        registration.dirty = true;
        throw error;
      })
      .finally(() => {
        if (registration.syncing === syncing) registration.syncing = undefined;
        if (registration.dirty)
          this.scheduleLiveSync(sessionId, liveSyncRetryMilliseconds);
      });
    registration.syncing = syncing;
    await syncing;
  }

  async flushWorkspace(localPath: string) {
    await this.load();
    let root: string;
    try {
      root = await realpath(localPath);
    } catch (error) {
      // VM worktrees are not visible on the host and have no cloud sync to
      // flush. Keep failures for registered cloud workspaces actionable.
      if (
        (error as NodeJS.ErrnoException).code === "ENOENT" &&
        !this.sessionsByWorkspace.has(localPath)
      )
        return;
      throw error;
    }
    const sessionId = this.sessionsByWorkspace.get(root);
    if (sessionId) await this.flushLive(sessionId);
  }

  detachLive(sessionId: string) {
    const registration = this.live.get(sessionId);
    if (!registration) return;
    if (registration.timer) clearTimeout(registration.timer);
    if (registration.poller) clearInterval(registration.poller);
    registration.watcher?.close();
    this.live.delete(sessionId);
  }

  closeLive() {
    for (const sessionId of this.live.keys()) this.detachLive(sessionId);
  }

  async workspaceForSession(sessionId: string) {
    await this.load();
    return this.workspaces.get(sessionId);
  }

  private async remember(
    sessionId: string,
    root: string,
    snapshot?: WorkspaceSnapshot,
  ) {
    await this.load();
    const previousRoot = this.workspaces.get(sessionId);
    if (previousRoot) this.sessionsByWorkspace.delete(previousRoot);
    const previousSession = this.sessionsByWorkspace.get(root);
    if (previousSession && previousSession !== sessionId)
      this.detachLive(previousSession);
    this.workspaces.set(sessionId, root);
    this.sessionsByWorkspace.set(root, sessionId);
    if (snapshot) this.synchronizedSnapshots.set(sessionId, snapshot);
    const persistence = this.persistence
      .catch(() => undefined)
      .then(() =>
        Promise.all([
          this.persist(),
          ...(snapshot ? [this.persistSnapshots()] : []),
        ]),
      )
      .then(() => undefined);
    this.persistence = persistence;
    await persistence;
  }

  private async load() {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.indexPath) return;
    try {
      const entries = JSON.parse(
        await readFile(this.indexPath, "utf8"),
      ) as unknown;
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          if (!Array.isArray(entry) || entry.length !== 2) continue;
          const [sessionId, root] = entry;
          if (typeof sessionId !== "string" || typeof root !== "string")
            continue;
          this.workspaces.set(sessionId, root);
          this.sessionsByWorkspace.set(root, sessionId);
        }
      }
    } catch {}
    if (!this.snapshotIndexPath) return;
    try {
      const entries = JSON.parse(
        await readFile(this.snapshotIndexPath, "utf8"),
      ) as unknown;
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          if (!Array.isArray(entry) || entry.length !== 2) continue;
          const [sessionId, snapshot] = entry;
          if (
            typeof sessionId !== "string" ||
            !validWorkspaceSnapshot(snapshot)
          )
            continue;
          this.synchronizedSnapshots.set(sessionId, snapshot);
        }
      }
    } catch {}
  }

  private async persist() {
    if (!this.indexPath) return;
    await mkdir(dirname(this.indexPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.indexPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify([...this.workspaces]), {
      mode: 0o600,
    });
    await rename(temporary, this.indexPath);
  }

  private async persistSnapshots() {
    if (!this.snapshotIndexPath) return;
    await mkdir(dirname(this.snapshotIndexPath), {
      recursive: true,
      mode: 0o700,
    });
    const temporary = `${this.snapshotIndexPath}.${randomUUID()}.tmp`;
    await writeFile(
      temporary,
      JSON.stringify([...this.synchronizedSnapshots]),
      {
        mode: 0o600,
      },
    );
    await rename(temporary, this.snapshotIndexPath);
  }

  private scheduleLiveSync(sessionId: string, delay: number) {
    const registration = this.live.get(sessionId);
    if (!registration || registration.syncing) return;
    if (registration.timer) clearTimeout(registration.timer);
    registration.timer = setTimeout(() => {
      registration.timer = undefined;
      if (!registration.dirty) return;
      registration.dirty = false;
      const syncing = this.syncLive(
        registration.client,
        sessionId,
        registration.root,
      )
        .then((result) => {
          if (result.pending) registration.dirty = true;
        })
        .catch((error) => {
          registration.dirty = true;
          this.onLiveSyncError(error);
        })
        .finally(() => {
          if (registration.syncing === syncing)
            registration.syncing = undefined;
          if (registration.dirty)
            this.scheduleLiveSync(sessionId, liveSyncRetryMilliseconds);
        });
      registration.syncing = syncing;
    }, delay);
  }

  private startLivePolling(
    sessionId: string,
    registration: LiveSyncRegistration,
  ) {
    if (registration.poller || this.live.get(sessionId) !== registration)
      return;
    registration.poller = setInterval(() => {
      registration.dirty = true;
      this.scheduleLiveSync(sessionId, 0);
    }, liveSyncRetryMilliseconds);
    registration.poller.unref();
  }

  private async restartWithCurrentWorkspace(
    client: CloudPreviewClient,
    sessionId: string,
    root: string,
    session: Awaited<ReturnType<CloudPreviewClient["get"]>>,
  ) {
    const selection = session.selection;
    const shouldRestart = session.desired.services === "running";
    if (shouldRestart && !selection)
      throw new Error("Cloud preview has no service selection to restart");
    this.setLiveStatus(sessionId, "restarting", {
      reason: "Sending the whole workspace and restarting the cloud preview.",
    });
    if (!["idle", "stopped", "failed"].includes(session.state.engine)) {
      session = await client.command(
        sessionId,
        { type: "stop-services" },
        randomUUID(),
      );
    }
    const synchronized = await this.syncInitial(client, sessionId, root);
    if (!shouldRestart || !selection) {
      return {
        session: synchronized.session,
        pending: false,
        synchronized: true,
        source: synchronized,
      };
    }
    const restarted = await client.command(
      sessionId,
      {
        type: "start-services",
        configurationId: selection.configurationId,
        serviceIds: selection.serviceIds,
        primaryRoute: selection.primaryRoute,
      },
      randomUUID(),
    );
    return {
      session: restarted,
      pending: false,
      synchronized: true,
      source: synchronized,
    };
  }
}

function liveSyncWaitingReason(session: PreviewSession) {
  if (session.state.sync === "conflict")
    return "Local and cloud changes conflict; restart the preview to resolve them.";
  if (session.state.sync !== "clean")
    return "Waiting for changes made in the cloud preview to reach this computer.";
  if (session.state.agent !== "idle")
    return "Waiting for the cloud agent to finish.";
  return "Waiting for the cloud preview to start.";
}

function dependencyInputsChanged(paths: string[]) {
  return paths.some((path) =>
    /(^|\/)(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?|poetry\.lock|pyproject\.toml|requirements[^/]*\.txt|Cargo\.lock|Cargo\.toml|uv\.lock)$/.test(
      path,
    ),
  );
}

function liveSyncRequiresRestart(error: unknown) {
  return (
    error instanceof CloudPreviewRequestError &&
    (error.failure?.code === "SYNC_CONFLICT" ||
      error.failure?.code === "SOURCE_SYNC_FAILED" ||
      error.failure?.code === "UNSUPPORTED_CAPABILITY" ||
      error.failure?.providerCode === "SOURCE_BASELINE_MISMATCH" ||
      error.failure?.providerCode === "ENGINE_RUNNING")
  );
}

function validWorkspaceSnapshot(value: unknown): value is WorkspaceSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Partial<WorkspaceSnapshot>;
  if (
    !/^[a-f0-9]{64}$/i.test(snapshot.hash ?? "") ||
    !snapshot.files ||
    Array.isArray(snapshot.files)
  ) {
    return false;
  }
  return Object.entries(snapshot.files).every(
    ([path, metadata]) =>
      Boolean(path) &&
      Boolean(metadata) &&
      typeof metadata === "object" &&
      !Array.isArray(metadata) &&
      ["file", "symlink"].includes(
        (metadata as { type?: string }).type ?? "",
      ) &&
      /^[a-f0-9]{64}$/i.test((metadata as { sha256?: string }).sha256 ?? ""),
  );
}

async function upload(
  target: { url: string; headers: Record<string, string>; expiresAt: string },
  content: Uint8Array,
) {
  if (Date.parse(target.expiresAt) <= Date.now())
    throw new Error("Workspace upload URL expired");
  const response = await fetch(validatedArtifactUrl(target.url), {
    method: "PUT",
    headers: target.headers,
    body: Buffer.from(content),
    redirect: "error",
  });
  if (!response.ok) throw new Error("Workspace upload failed");
}

async function download(value: string, expectedSize: number) {
  if (
    !Number.isSafeInteger(expectedSize) ||
    expectedSize < 1 ||
    expectedSize > maximumArtifactBytes
  ) {
    throw new Error("Workspace delta size is invalid");
  }
  const response = await fetch(validatedArtifactUrl(value), {
    redirect: "error",
  });
  if (!response.ok || !response.body)
    throw new Error("Workspace delta download failed");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      received += chunk.byteLength;
      if (received > expectedSize) {
        await reader.cancel("Workspace delta exceeded its declared size");
        throw new Error("Workspace delta size mismatch");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  if (received !== expectedSize)
    throw new Error("Workspace delta size mismatch");
  const content = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return content;
}

function validatedArtifactUrl(value: string) {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error("Workspace artifact URL is invalid");
  }
  return url;
}

async function measureWorkspacePhase<T>(
  phase: string,
  operation: () => Promise<T>,
) {
  const startedAt = performance.now();
  let outcome = "succeeded";
  try {
    return await operation();
  } catch (error) {
    outcome = "failed";
    throw error;
  } finally {
    const attributes = {
      [ATTR_BLAME_RUNTIME_NAME]: "vercel-compose",
      [ATTR_BLAME_RUNTIME_PHASE]: phase,
      [ATTR_BLAME_OPERATION_STATUS]: outcome,
    };
    const telemetry = getBlameTelemetry();
    telemetry.count("blame.runtime.phase.count", 1, attributes);
    telemetry.record(
      "blame.runtime.phase.duration",
      Math.max(0, performance.now() - startedAt) / 1_000,
      attributes,
    );
  }
}
