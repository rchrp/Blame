import type {
  PreviewLifecyclePhase,
  PreviewLifecycleState,
  ProjectPreviewRuntimeState,
} from "@blame/agent-runtime";
import type { PreviewRuntimeSelectionState } from "../../preview-run-state.js";

type WritePreviewRuntimeState = (
  worktree: string,
  state: PreviewRuntimeSelectionState,
) => Promise<void>;
type ReadPreviewRuntimeState = (
  worktree: string,
) => Promise<PreviewRuntimeSelectionState>;

/**
 * Whether the selected configuration opens a page: terminal and screen
 * previews are ready once their service runs, without a preview URL.
 */
export function selectsBrowserPreview(
  previewService: string | undefined,
  manifest:
    { services: Array<{ id: string; surface?: { type: string } }> } | undefined,
) {
  if (!previewService) return false;
  const surface = manifest?.services.find(({ id }) => id === previewService)
    ?.surface?.type;
  return !surface || surface === "web";
}

/**
 * The lifecycle shown for a local preview. The operation in flight owns it:
 * while one runs, its persisted phase and step are the truth. Once none
 * runs, the persisted result stands, and the containers can only turn a
 * settled preview into a failure. A pending state no operation owns any
 * more (Blame was closed during a start) is reported as interrupted, so a
 * preview never waits forever.
 */
export function localPreviewLifecycle(
  persisted: PreviewRuntimeSelectionState,
  selectedStatus: ProjectPreviewRuntimeState["statuses"][string] | undefined,
  browserPreview: boolean,
  previewUrl: string | undefined,
  inFlight = false,
): PreviewLifecycleState {
  const last = persisted.lifecycle;
  if (inFlight) {
    if (last?.status === "pending") return last;
    return localLifecycle(
      persisted.desiredStatus === "running" ? "starting" : "stopping",
      "pending",
      last,
    );
  }
  if (persisted.desiredStatus === "stopped") {
    if (last?.status === "error" || last?.phase === "suspended") return last;
    return idleLocalPreviewLifecycle(
      last?.phase === "idle" ? last.since : undefined,
    );
  }
  if (last?.status === "error") return last;
  if (last?.status === "pending") {
    return failedLocalPreviewLifecycle(
      last.phase === "stopping" || last.phase === "suspending"
        ? "The preview stop was interrupted before it finished. Stop or restart the preview."
        : "The preview start was interrupted before it finished, for example because Blame was closed. Restart the preview.",
    );
  }
  if (selectedStatus === "error") {
    return failedLocalPreviewLifecycle(
      "A preview service stopped unexpectedly. Open Run logs to see its output, then restart the preview.",
    );
  }
  if (selectedStatus === "running" && (!browserPreview || previewUrl))
    return localLifecycle("ready", "ready", last);
  // Its address could not be read this time: wait for the next reading.
  if (selectedStatus === "running")
    return localLifecycle("loading", "pending", last);
  if (last?.phase === "ready" || last?.phase === "loading") {
    return failedLocalPreviewLifecycle(
      "The preview services are no longer running. Restart the preview.",
    );
  }
  // Selected but never started: the start request has not arrived yet.
  return idleLocalPreviewLifecycle(
    last?.phase === "idle" ? last.since : undefined,
  );
}

export function readyLocalPreviewLifecycle(): PreviewLifecycleState {
  return { phase: "ready", status: "ready", since: new Date().toISOString() };
}

export function suspendedLocalPreviewLifecycle(): PreviewLifecycleState {
  return {
    phase: "suspended",
    status: "idle",
    since: new Date().toISOString(),
  };
}

export function idleLocalPreviewLifecycle(
  since?: string,
): PreviewLifecycleState {
  return {
    phase: "idle",
    status: "idle",
    since: since ?? new Date().toISOString(),
  };
}

export function pendingLocalPreviewLifecycle(
  phase: Extract<PreviewLifecyclePhase, "starting" | "stopping" | "suspending">,
): PreviewLifecycleState {
  return { phase, status: "pending", since: new Date().toISOString() };
}

export async function persistLocalPreviewFailure(
  worktree: string,
  selectedConfigurationId: string,
  desiredStatus: PreviewRuntimeSelectionState["desiredStatus"],
  error: unknown,
  writeState: WritePreviewRuntimeState,
) {
  await writeState(worktree, {
    desiredStatus,
    lifecycle: failedLocalPreviewLifecycle(errorMessage(error)),
    selectedConfigurationId,
  });
}

const operations = new Map<string, number>();

/** Whether a start, stop or recovery of this worktree's preview runs now. */
export function localPreviewOperationInFlight(worktree: string) {
  return (operations.get(worktree) ?? 0) > 0;
}

/** Marks a preview operation of a worktree as running until it settles. */
export async function trackLocalPreviewOperation<T>(
  worktree: string,
  action: () => Promise<T>,
) {
  operations.set(worktree, (operations.get(worktree) ?? 0) + 1);
  try {
    return await action();
  } finally {
    const remaining = (operations.get(worktree) ?? 1) - 1;
    if (remaining > 0) operations.set(worktree, remaining);
    else operations.delete(worktree);
  }
}

/**
 * Runs a start or stop as the owner of the preview's lifecycle: pending
 * while it runs, then the lifecycle the operation settled on, or its
 * failure. An operation that returns nothing was overtaken by a newer
 * request (a stop during a start), which writes its own result.
 */
export async function runLocalPreviewOperation(
  worktree: string,
  selectedConfigurationId: string,
  desiredStatus: PreviewRuntimeSelectionState["desiredStatus"],
  phase: Extract<PreviewLifecyclePhase, "starting" | "stopping" | "suspending">,
  operation: () => Promise<PreviewLifecycleState | undefined>,
  writeState: WritePreviewRuntimeState,
  readState: ReadPreviewRuntimeState,
) {
  await trackLocalPreviewOperation(worktree, async () => {
    await writeState(worktree, {
      desiredStatus,
      lifecycle: pendingLocalPreviewLifecycle(phase),
      selectedConfigurationId,
    });
    try {
      const lifecycle = await operation();
      if (
        !lifecycle ||
        !(await stillWanted(worktree, desiredStatus, readState))
      )
        return;
      await writeState(worktree, {
        desiredStatus,
        lifecycle,
        selectedConfigurationId,
      });
    } catch (error) {
      if (await stillWanted(worktree, desiredStatus, readState)) {
        await persistLocalPreviewFailure(
          worktree,
          selectedConfigurationId,
          desiredStatus,
          error,
          writeState,
        );
      }
      throw error;
    }
  });
}

async function stillWanted(
  worktree: string,
  desiredStatus: PreviewRuntimeSelectionState["desiredStatus"],
  readState: ReadPreviewRuntimeState,
) {
  const current = await readState(worktree).catch(() => undefined);
  return !current || current.desiredStatus === desiredStatus;
}

export function validPreviewLifecycle(
  value: unknown,
): value is PreviewLifecycleState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const lifecycle = value as Record<string, unknown>;
  return (
    typeof lifecycle.phase === "string" &&
    [
      "idle",
      "provisioning",
      "resuming",
      "synchronizing",
      "preparing",
      "starting",
      "loading",
      "ready",
      "stopping",
      "suspending",
      "suspended",
      "destroying",
      "destroyed",
      "failed",
    ].includes(lifecycle.phase) &&
    typeof lifecycle.status === "string" &&
    ["idle", "pending", "ready", "error"].includes(lifecycle.status) &&
    typeof lifecycle.since === "string" &&
    Number.isFinite(Date.parse(lifecycle.since)) &&
    (lifecycle.step === undefined || typeof lifecycle.step === "string") &&
    validFailure(lifecycle.failure)
  );
}

export function parseLocalPreviewRuntimeSelectionState(
  value: unknown,
): PreviewRuntimeSelectionState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Preview runtime state must be an object");
  }
  const state = value as Record<string, unknown>;
  const allowed = new Set([
    "desiredStatus",
    "lifecycle",
    "selectedConfigurationId",
  ]);
  const unknown = Object.keys(state).find((key) => !allowed.has(key));
  if (unknown) {
    throw new Error(
      `Preview runtime state contains unsupported field ${unknown}`,
    );
  }
  if (state.desiredStatus !== "running" && state.desiredStatus !== "stopped") {
    throw new Error("Preview runtime state desiredStatus is invalid");
  }
  if (
    state.lifecycle !== undefined &&
    !validPreviewLifecycle(state.lifecycle)
  ) {
    throw new Error("Preview runtime state lifecycle is invalid");
  }
  if (
    state.selectedConfigurationId !== undefined &&
    (typeof state.selectedConfigurationId !== "string" ||
      !state.selectedConfigurationId)
  ) {
    throw new Error("Preview runtime state selectedConfigurationId is invalid");
  }
  return {
    desiredStatus: state.desiredStatus,
    ...(state.lifecycle ? { lifecycle: state.lifecycle } : {}),
    ...(state.selectedConfigurationId
      ? { selectedConfigurationId: state.selectedConfigurationId }
      : {}),
  };
}

function validFailure(value: unknown) {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const failure = value as Record<string, unknown>;
  return (
    typeof failure.message === "string" &&
    (failure.retryable === undefined || typeof failure.retryable === "boolean")
  );
}

export function failedLocalPreviewLifecycle(
  message: string,
): PreviewLifecycleState {
  return {
    phase: "failed",
    status: "error",
    since: new Date().toISOString(),
    failure: { message: message.trim() || "The local preview failed." },
  };
}

function localLifecycle(
  phase: PreviewLifecyclePhase,
  status: PreviewLifecycleState["status"],
  previous?: PreviewLifecycleState,
): PreviewLifecycleState {
  const samePhase = previous?.phase === phase;
  return {
    phase,
    status,
    since: samePhase ? previous.since : new Date().toISOString(),
    // The step a start reports stays visible until its phase changes.
    ...(samePhase && previous.step ? { step: previous.step } : {}),
  };
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return typeof error === "string"
    ? error
    : "The local preview operation failed.";
}
