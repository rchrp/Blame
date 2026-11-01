import {
  initialPreviewSessionDesired,
  initialPreviewSessionState,
  previewSessionView,
  type CreatePreviewSessionInput,
  type PreviewSessionBackend,
  type PreviewSessionCommand,
  type PreviewSessionEvent,
  type PreviewSessionRecord,
} from "../domain/preview-session.js";
import { isCloudRuntimeProfile } from "../domain/runtime-profile.js";
import { PreviewRuntimeError } from "../domain/preview-errors.js";
import type { DistributedLock } from "../ports/distributed-lock.js";
import type { PreviewEventSink } from "../ports/preview-event-sink.js";
import type { SessionRepository } from "../ports/session-repository.js";
import { applyPreviewCommand } from "./preview-commands.js";
import { PreviewReconciler } from "./preview-reconciler.js";
import { previewResourceSize } from "./preview-resource-size.js";

export class PreviewOrchestrator implements PreviewSessionBackend {
  private readonly repository: SessionRepository;
  private readonly lock: DistributedLock;
  private readonly eventSink: PreviewEventSink;
  private readonly reconciler: PreviewReconciler;

  constructor(
    repository: SessionRepository,
    lock: DistributedLock,
    eventSink: PreviewEventSink,
    reconciler: PreviewReconciler,
  ) {
    this.repository = repository;
    this.lock = lock;
    this.eventSink = eventSink;
    this.reconciler = reconciler;
  }

  async create(input: CreatePreviewSessionInput) {
    if (isCloudRuntimeProfile(input.profile) && !input.cloudUploadConsentAt) {
      throw new PreviewRuntimeError({
        code: "PREVIEW_ACCESS_DENIED",
        message: "Cloud source upload requires explicit consent.",
        retryable: false,
      });
    }
    const now = new Date().toISOString();
    const record: PreviewSessionRecord = {
      id: input.id ?? globalThis.crypto.randomUUID(),
      userStoryId: input.userStoryId,
      ownerUserId: input.ownerUserId,
      profile: input.profile,
      desired: initialPreviewSessionDesired(),
      state: initialPreviewSessionState(),
      revision: 0,
      generation: 0,
      fencingToken: 0,
      plan: structuredClone(input.plan),
      planHash: input.planHash,
      planVersion: input.plan.version,
      sourceRevision: input.sourceRevision,
      workspaceHash: input.workspaceHash,
      baselineId: input.baselineId,
      provisionSource: input.provisionSource,
      resourceSize: input.resourceSize ?? previewResourceSize(input.plan),
      lastActivityAt: now,
      stateChangedAt: now,
      createdAt: now,
    };
    await this.repository.create(record);
    return this.lock.withLock(record.id, async ({ fencingToken }) =>
      previewSessionView(await this.reconciler.reconcile(record, fencingToken)),
    );
  }

  command(
    sessionId: string,
    command: PreviewSessionCommand,
    operationId: string,
    condition?: (record: Readonly<PreviewSessionRecord>) => boolean,
  ) {
    return this.lock.withLock(sessionId, async ({ fencingToken }) => {
      const existingOperation = await this.repository.getOperation(
        sessionId,
        operationId,
      );
      if (existingOperation && existingOperation.commandType !== command.type) {
        throw new PreviewRuntimeError({
          code: "INTERNAL",
          message: "An idempotency key cannot be reused for another command.",
          retryable: false,
        });
      }
      if (existingOperation?.status === "succeeded") return this.get(sessionId);
      const record = await this.requiredRecord(sessionId);
      if (condition && !condition(record)) return previewSessionView(record);
      if (
        command.type === "suspend-host" &&
        record.state.host === "suspended" &&
        record.state.sync !== "failed"
      ) {
        return this.get(sessionId);
      }
      await this.repository.saveOperation({
        sessionId,
        operationId,
        commandType: command.type,
        status: "running",
        createdAt: existingOperation?.createdAt ?? new Date().toISOString(),
      });
      try {
        const desired = applyPreviewCommand(record, command);
        desired.revision = record.revision + 1;
        await this.repository.save(desired, record.revision);
        const reconciled = await this.reconciler.reconcile(
          desired,
          fencingToken,
        );
        await this.repository.saveOperation({
          sessionId,
          operationId,
          commandType: command.type,
          status: "succeeded",
          resultRevision: reconciled.revision,
          createdAt: existingOperation?.createdAt ?? new Date().toISOString(),
          completedAt: new Date().toISOString(),
        });
        return previewSessionView(reconciled);
      } catch (error) {
        await this.repository.saveOperation({
          sessionId,
          operationId,
          commandType: command.type,
          status: "failed",
          errorCode:
            error instanceof PreviewRuntimeError
              ? error.failure.code
              : "INTERNAL",
          createdAt: existingOperation?.createdAt ?? new Date().toISOString(),
          completedAt: new Date().toISOString(),
        });
        throw error;
      }
    });
  }

  async get(sessionId: string) {
    return previewSessionView(await this.requiredRecord(sessionId));
  }

  events(
    sessionId: string,
    cursor?: string,
  ): AsyncIterable<PreviewSessionEvent> {
    return this.eventSink.events(sessionId, cursor);
  }

  private async requiredRecord(sessionId: string) {
    const record = await this.repository.get(sessionId);
    if (!record) {
      throw new PreviewRuntimeError({
        code: "PREVIEW_ACCESS_DENIED",
        message: "Preview session not found.",
        retryable: false,
      });
    }
    return record;
  }
}
