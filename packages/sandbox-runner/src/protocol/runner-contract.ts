import type {
  PreviewExecutionPlan,
  RuntimeObservation,
  RuntimeProtocolHandshake,
  RuntimeSelection,
  SourceArtifact,
} from "@blame/preview-runtime";

export const runnerProtocolVersion = 3;

export type RunnerUploadTarget = {
  expiresAt: string;
  headers: Record<string, string>;
  url: string;
};

export type RunnerEndpointMap = {
  revision: number;
  primaryRouteId: string;
  routes: Array<{
    routeId: string;
    serviceId: string;
    endpointId: string;
    protocol: "http" | "https" | "ws" | "wss";
    logicalPort: number;
    targetHost: string;
    targetPort: number;
    sandboxPort: number;
    basePathMode: "root" | "explicit-prefix";
    externallyCompatible: boolean;
  }>;
  supportsWebSocket: boolean;
  integratedPreviewRequired: boolean;
  incompatibilityReasons: string[];
};

export type RunnerPreviewStartResult = {
  observation: RuntimeObservation;
  endpoints: RunnerEndpointMap;
};

export type RunnerRequest = (
  | { operation: "handshake" }
  | { operation: "surface-action"; serviceId: string; arguments: Record<string, unknown> }
  | { operation: "resume-host"; sessionId: string; generation: number }
  | {
      operation: "prepare-engine";
      plan: PreviewExecutionPlan;
      browserBindingUrls?: Record<string, string>;
      routeIds?: Record<string, string>;
      capabilityPublicKey?: string;
      sessionId?: string;
      generation?: number;
    }
  | {
      operation: "start-preview";
      plan: PreviewExecutionPlan;
      selection: RuntimeSelection;
      browserBindingUrls?: Record<string, string>;
      routeIds?: Record<string, string>;
      capabilityPublicKey?: string;
      sessionId: string;
      generation: number;
    }
  | {
      operation: "warm-baseline";
      plan: PreviewExecutionPlan;
      source: SourceArtifact;
      sessionId: string;
      generation: number;
    }
  | { operation: "sanitize-snapshot" }
  | { operation: "start-services"; selection: RuntimeSelection }
  | { operation: "stop-services" }
  | { operation: "inspect"; probeServices?: boolean }
  | { operation: "endpoints" }
  | { operation: "logs"; cursor?: string; serviceId?: string }
  | {
      operation: "source-import";
      source: SourceArtifact;
      preserveWarmCaches?: boolean;
    }
  | {
      operation: "source-export-prepare";
      revision: string;
      artifactId: string;
    }
  | {
      operation: "source-export-upload";
      artifactId: string;
      upload: RunnerUploadTarget;
    }
  | { operation: "source-export-ack"; revision: string }
  | {
      operation: "exec";
      command: string;
      args: string[];
      cwd: string;
      environment?: Record<string, string>;
      timeoutMs?: number;
    }
) & { fencingToken: number };

export type RunnerSuccess<T = unknown> = { ok: true; result: T };
export type RunnerFailure = {
  ok: false;
  error: { code: string; message: string };
};
export type RunnerResponse<T = unknown> = RunnerSuccess<T> | RunnerFailure;

export function runnerHandshake(input: {
  clineSdkVersion: string;
  runnerVersion: string;
  imageDigest: string;
  capabilities: RuntimeProtocolHandshake["capabilities"];
}): RuntimeProtocolHandshake {
  return {
    clineSdkVersion: input.clineSdkVersion,
    protocolVersion: runnerProtocolVersion,
    runnerVersion: input.runnerVersion,
    imageDigest: input.imageDigest,
    capabilities: input.capabilities,
  };
}
