export type PreviewLifecyclePhase =
  | "idle"
  | "provisioning"
  | "resuming"
  | "synchronizing"
  | "preparing"
  | "starting"
  | "loading"
  | "ready"
  | "stopping"
  | "suspending"
  | "suspended"
  | "destroying"
  | "destroyed"
  | "failed";

export type PreviewLifecycleStatus = "idle" | "pending" | "ready" | "error";

/**
 * Runtime-neutral projection used by the desktop and renderer. The detailed
 * host/engine/preview/sync axes remain the source of truth for managed
 * sessions; this projection gives both local and cloud previews one UI flow.
 */
export type PreviewLifecycleState = {
  phase: PreviewLifecyclePhase;
  status: PreviewLifecycleStatus;
  since: string;
  /** What a pending start is doing right now, for people (local previews). */
  step?: string;
  failure?: {
    message: string;
    retryable?: boolean;
  };
};
