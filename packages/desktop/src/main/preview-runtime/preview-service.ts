import type {
  PreviewSessionCommand,
  PreviewSessionEvent,
  PreviewSessionView,
} from "@blame/preview-runtime";
import {
  CloudPreviewClient,
  type CloudApiConnection,
  type CloudManagedPreviewCreateInput,
} from "./cloud-preview-client";
import { WorkspaceSyncService } from "../workspaces/workspace-sync-service";
import { app } from "electron";
import log from "electron-log";
import { join } from "node:path";
import { launchExternalPreview } from "./external-preview-launcher";

export class PreviewService {
  private cloud?: CloudPreviewClient;
  private readonly sync = new WorkspaceSyncService(
    join(app.getPath("userData"), "preview-runtime", "workspace-index.json"),
    (error) => log.warn("Cloud preview live sync failed; retrying", error),
  );

  constructor(
    private readonly localWriterActive: (worktree: string) => boolean = () =>
      false,
    private readonly packaged = app.isPackaged,
  ) {}

  configureCloud(connection: CloudApiConnection) {
    this.cloud = new CloudPreviewClient(connection, {
      packaged: this.packaged,
    });
  }

  clearCloud() {
    this.sync.closeLive();
    this.cloud = undefined;
  }

  async create(input: ManagedPreviewCreateInput) {
    const sourceMetadata = await this.sync.prepareInitial(input.localPath);
    const { localPath: _localPath, ...cloudInput } = input;
    return this.cloudClient().create({ ...cloudInput, sourceMetadata });
  }

  async command(
    sessionId: string,
    command: PreviewSessionCommand,
    operationId: string,
  ) {
    const client = this.cloudClient();
    if (
      ["stop-services", "suspend-host", "destroy-host"].includes(command.type)
    ) {
      const { stopSurfaceTerminals } =
        await import("../preview-surfaces/surface-sessions.ts");
      const current = await client.get(sessionId);
      stopSurfaceTerminals(current.userStoryId);
    }
    if (command.type === "start-agent") {
      const workspace = await this.sync.workspaceForSession(sessionId);
      if (workspace) this.assertLocalWriterIdle(workspace);
    }
    if (command.type === "start-agent" || command.type === "start-services") {
      await this.sync.flushLive(sessionId);
    }
    const session = await client.command(sessionId, command, operationId);
    if (command.type === "destroy-host") this.sync.detachLive(sessionId);
    if (command.type === "resume-host" || command.type === "start-services") {
      this.sync.wakeLive(sessionId);
    }
    return session;
  }

  get(sessionId: string): Promise<PreviewSessionView> {
    return this.cloudClient().get(sessionId);
  }

  async findForUserStory(userStoryId: string, profile: "vercel-compose") {
    const client = this.cloudClient();
    const result = await client.findForUserStory(userStoryId, profile);
    if (result.session && result.session.desired.host !== "destroyed") {
      const workspace = await this.sync.workspaceForSession(result.session.id);
      if (workspace) {
        await this.sync
          .attachLive(client, result.session.id, workspace)
          .catch((error) =>
            log.warn("Unable to restore cloud preview live sync", error),
          );
      }
    }
    return result;
  }

  events(
    sessionId: string,
    cursor?: string,
    signal?: AbortSignal,
  ): AsyncIterable<PreviewSessionEvent> {
    return this.cloudClient().events(sessionId, cursor, signal);
  }

  logs(sessionId: string, cursor?: string, signal?: AbortSignal) {
    return this.cloudClient().logs(sessionId, cursor, signal);
  }

  bridgeGrant(sessionId: string) {
    return this.cloudClient().bridgeGrant(sessionId);
  }

  surfaceAccessTicket(sessionId: string, routeId: string) {
    return this.cloudClient().accessTicket(sessionId, routeId);
  }

  surfaceAction(
    sessionId: string,
    serviceId: string,
    args: Record<string, unknown>,
  ) {
    return this.cloudClient().surfaceAction(sessionId, serviceId, args);
  }

  async openExternal(sessionId: string, routeId?: string) {
    await launchExternalPreview(
      await this.cloudClient().accessTicket(sessionId, routeId),
    );
    return true;
  }

  async syncInitial(sessionId: string, localPath: string) {
    const client = this.cloudClient();
    const result = await this.sync.syncInitial(client, sessionId, localPath);
    await this.sync.attachLive(client, sessionId, localPath);
    return result;
  }

  syncStatus(sessionId: string) {
    return this.sync.liveStatus(sessionId) ?? null;
  }

  syncBack(sessionId: string, localPath?: string) {
    return this.sync.syncBack(
      this.cloudClient(),
      sessionId,
      localPath,
      (root) => this.assertLocalWriterIdle(root),
    );
  }

  syncBarrier(localPath: string) {
    // The native worktree remains authoritative. Flush any queued host-to-cloud
    // edit before delivery or another writer transition without importing
    // sandbox changes into the host.
    return this.sync.flushWorkspace(localPath);
  }

  private cloudClient() {
    if (!this.cloud) throw new Error("Cloud preview is not connected");
    return this.cloud;
  }

  private assertLocalWriterIdle(worktree: string) {
    if (this.localWriterActive(worktree)) {
      throw new Error(
        "Stop the local agent before starting or synchronizing this managed preview",
      );
    }
  }
}

export type ManagedPreviewCreateInput = CloudManagedPreviewCreateInput & {
  localPath: string;
};
