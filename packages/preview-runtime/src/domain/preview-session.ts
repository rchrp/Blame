import type { EndpointMap } from "./endpoint-map.js";
import type { PreviewExecutionPlan } from "./execution-plan.js";
import type { PreviewFailure } from "./preview-errors.js";
import type { RuntimeCapabilities } from "./runtime-capabilities.js";
import type { RuntimeProfileId } from "./runtime-profile.js";

export type HostState =
  | "unprovisioned"
  | "provisioning"
  | "running"
  | "suspending"
  | "suspended"
  | "resuming"
  | "destroying"
  | "destroyed"
  | "failed";
export type EngineState =
  | "idle"
  | "preparing"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed";
export type PreviewState =
  | "closed"
  | "opening"
  | "ready"
  | "degraded"
  | "closing";
export type AgentState =
  | "idle"
  | "starting"
  | "running"
  | "stopping"
  | "failed";
export type SyncState =
  | "clean"
  | "importing"
  | "exporting"
  | "pending_local_sync"
  | "applying"
  | "conflict"
  | "failed"
  | "discarded";

export type PreviewSessionState = {
  host: HostState;
  engine: EngineState;
  preview: PreviewState;
  agent: AgentState;
  sync: SyncState;
};

export type PreviewSessionDesired = {
  host: "active" | "suspended" | "destroyed";
  services: "running" | "stopped";
  preview: "open" | "closed";
  agent: "running" | "idle";
};

export type PreviewSessionCommand =
  | {
      type: "start-services";
      configurationId: string;
      serviceIds?: string[];
      primaryRoute?: { serviceId: string; endpointId: string };
    }
  | { type: "stop-services" }
  | { type: "start-agent" }
  | { type: "stop-agent" }
  | { type: "suspend-host" }
  | { type: "resume-host" }
  | { type: "report-sync-conflict" }
  | { type: "destroy-host"; discardPendingDelta?: { confirmationId: string } }
  | {
      type: "ack-local-sync";
      deltaRevision: string;
      workspaceHash?: string;
    };

export type CreatePreviewSessionInput = {
  id?: string;
  userStoryId: string;
  ownerUserId: string;
  profile: RuntimeProfileId;
  plan: PreviewExecutionPlan;
  planHash: string;
  sourceRevision?: string;
  workspaceHash?: string;
  baselineId?: string;
  provisionSource?: import("../ports/preview-runtime-driver.js").RuntimeProvisionSource;
  resourceSize?: { vcpus: number; memoryGb: number };
  cloudUploadConsentAt?: string;
};

export type RuntimeProtocolHandshake = {
  protocolVersion: number;
  runnerVersion: string;
  imageDigest: string;
  capabilities: RuntimeCapabilities;
};

export type PreviewSessionRecord = {
  id: string;
  userStoryId: string;
  ownerUserId: string;
  profile: RuntimeProfileId;
  desired: PreviewSessionDesired;
  state: PreviewSessionState;
  revision: number;
  generation: number;
  fencingToken: number;
  providerHandleEncrypted?: string;
  plan: PreviewExecutionPlan;
  planHash: string;
  planVersion: number;
  protocolVersion?: number;
  runnerVersion?: string;
  imageDigest?: string;
  sourceRevision?: string;
  workspaceHash?: string;
  sourceArtifactId?: string;
  baselineId?: string;
  provisionSource?: import("../ports/preview-runtime-driver.js").RuntimeProvisionSource;
  lastExportedJournalRevision?: string;
  lastAppliedLocalRevision?: string;
  lastAcknowledgedRemoteRevision?: string;
  pendingDeltaArtifactId?: string;
  endpointMapEncrypted?: string;
  endpointMap?: EndpointMap;
  resourceSize: { vcpus: number; memoryGb: number };
  lastActivityAt: string;
  stateChangedAt: string;
  leaseExpiresAt?: string;
  idleDeadlineAt?: string;
  createdAt: string;
  stoppedAt?: string;
  failure?: PreviewFailure;
  selection?: import("./execution-plan.js").RuntimeSelection;
};

export type PreviewSessionView = Omit<
  PreviewSessionRecord,
  | "providerHandleEncrypted"
  | "endpointMapEncrypted"
  | "fencingToken"
  | "plan"
  | "provisionSource"
> & {
  capabilities?: RuntimeCapabilities;
  usage?: {
    activeSeconds: number;
    estimatedCostUsd: number;
    observedAt: string;
  };
};

export type PreviewSessionEvent = {
  cursor: string;
  sessionId: string;
  sequence: number;
  timestamp: string;
  type: "state" | "log" | "sync" | "usage" | "failure";
  state: PreviewSessionState;
  serviceId?: string;
  stream?: "system" | "stdout" | "stderr";
  message: string;
};

export interface PreviewSessionBackend<
  CreateInput = CreatePreviewSessionInput,
> {
  create(input: CreateInput): Promise<PreviewSessionView>;
  command(
    sessionId: string,
    command: PreviewSessionCommand,
    operationId: string,
  ): Promise<PreviewSessionView>;
  get(sessionId: string): Promise<PreviewSessionView>;
  events(
    sessionId: string,
    cursor?: string,
  ): AsyncIterable<PreviewSessionEvent>;
}
export function initialPreviewSessionState(): PreviewSessionState {
  return {
    host: "unprovisioned",
    engine: "idle",
    preview: "closed",
    agent: "idle",
    sync: "clean",
  };
}

export function initialPreviewSessionDesired(): PreviewSessionDesired {
  return {
    host: "active",
    services: "stopped",
    preview: "closed",
    agent: "idle",
  };
}

export function previewSessionView(
  record: PreviewSessionRecord,
): PreviewSessionView {
  const {
    providerHandleEncrypted: _handle,
    endpointMapEncrypted: _map,
    fencingToken: _fencingToken,
    plan: _plan,
    provisionSource: _provisionSource,
    ...view
  } = record;
  return structuredClone(view);
}
