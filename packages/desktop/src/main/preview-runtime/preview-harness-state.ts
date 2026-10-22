import type { WorkspaceRevisionState } from "@blame/agent-runtime";
import type { PreviewLifecycleState } from "@blame/preview-contract";
import type { PreviewDevtoolsTarget } from "../preview-browser/preview-browser-manager.ts";
import {
  previewDevtoolsEnabledCapabilities,
  previewDevtoolsMcpVersion,
  previewDevtoolsUnavailableCapabilities,
} from "../preview-browser/preview-devtools-config.ts";

export type PreviewHarnessStatus =
  | "failed"
  | "ready"
  | "starting"
  | "stopped"
  | "unavailable";

export type PreviewHarnessState = PreviewDevtoolsTarget & {
  lifecycle?: PreviewLifecycleState;
  message: string;
  mcp: {
    enabledCapabilities: readonly string[];
    pageScoped: true;
    unavailableCapabilities: ReadonlyArray<{
      capability: string;
      reason: string;
    }>;
    version: string;
  };
  reason: string;
  readiness: {
    browser_ready: boolean;
    container_ready: boolean;
    application_ready: boolean;
  };
  revisions?: WorkspaceRevisionState;
  status: PreviewHarnessStatus;
};

const previewStatusMessages = {
  ready: {
    message: "The preview application is ready.",
    reason: "PREVIEW_APPLICATION_READY",
  },
  starting: {
    message: "The preview is currently starting.",
    reason: "PREVIEW_STARTING",
  },
  stopped: {
    message: "The preview is not running.",
    reason: "PREVIEW_STOPPED",
  },
  unavailable: {
    message:
      "The preview runtime is ready, but no page has been loaded for this story yet.",
    reason: "PREVIEW_BROWSER_NOT_OPEN",
  },
} as const;

export function previewHarnessState(
  browser: PreviewDevtoolsTarget,
  lifecycle?: PreviewLifecycleState,
  revisions?: WorkspaceRevisionState,
): PreviewHarnessState {
  const readiness = previewReadiness(browser, lifecycle, revisions);
  const status = previewHarnessStatus(browser, lifecycle, readiness);
  return {
    ...browser,
    available: status === "ready",
    ...(lifecycle ? { lifecycle } : {}),
    mcp: {
      enabledCapabilities: previewDevtoolsEnabledCapabilities,
      pageScoped: true,
      unavailableCapabilities: previewDevtoolsUnavailableCapabilities,
      version: previewDevtoolsMcpVersion,
    },
    ...previewHarnessStatusMessage(status, browser, lifecycle),
    readiness,
    ...(revisions ? { revisions } : {}),
    status,
  };
}

export async function resolvePreviewHarnessState(
  inspect: () => Promise<PreviewHarnessState>,
  waitFor: "none" | "ready" | undefined,
  waitForRefresh: () => Promise<void>,
  initial?: PreviewHarnessState,
  options: PreviewReadinessOptions = {},
) {
  let state = initial ?? (await inspect());
  if (waitFor !== "ready" || state.status !== "starting") return state;
  const now = options.now ?? Date.now;
  let deadline = previewApplicationDeadline(state, now(), options);
  while (state.status === "starting") {
    if (deadline && now() >= deadline.expiresAt) {
      return previewReadinessTimedOut(state, deadline);
    }
    await waitForRefresh();
    state = await inspect();
    if (state.status !== "starting") break;
    const nextDeadline = previewApplicationDeadline(state, now(), options);
    if (!deadline || !nextDeadline) deadline = nextDeadline;
  }
  return state;
}

type PreviewReadinessOptions = {
  applicationTimeoutMs?: number;
  now?: () => number;
};

type PreviewWaitDeadline = {
  expiresAt: number;
  timeoutMs: number;
};

function previewApplicationDeadline(
  state: PreviewHarnessState,
  now: number,
  options: PreviewReadinessOptions,
): PreviewWaitDeadline | undefined {
  if (previewStartupPending(state)) return undefined;
  const timeoutMs = options.applicationTimeoutMs ?? 2_000;
  return {
    expiresAt: now + timeoutMs,
    timeoutMs,
  };
}

function previewStartupPending(state: PreviewHarnessState) {
  return state.lifecycle?.status === "pending";
}

function previewReadinessTimedOut(
  state: PreviewHarnessState,
  deadline: PreviewWaitDeadline,
): PreviewHarnessState {
  const seconds = deadline.timeoutMs / 1_000;
  return {
    ...state,
    available: false,
    message: `The running preview did not become application-ready within ${seconds} seconds. Inspect preview logs.`,
    reason: "PREVIEW_APPLICATION_TIMEOUT",
    status: "unavailable",
  };
}

export function shouldStartStoppedLocalPreview(input: {
  status: PreviewHarnessStatus;
  waitFor?: "none" | "ready";
  workspaceMode?: "local-container" | "cloud-mirror" | "direct";
  worktree?: string;
}) {
  return (
    input.waitFor === "ready" &&
    input.status === "stopped" &&
    input.workspaceMode !== "cloud-mirror" &&
    // Direct stories run in the project folder: never start a managed
    // preview there.
    input.workspaceMode !== "direct" &&
    Boolean(input.worktree)
  );
}

export function shouldProbePreviewApplication(
  lifecycle: PreviewLifecycleState | undefined,
) {
  return lifecycle?.status !== "pending";
}

function previewHarnessStatus(
  browser: PreviewDevtoolsTarget,
  lifecycle: PreviewLifecycleState | undefined,
  readiness: PreviewHarnessState["readiness"],
): PreviewHarnessStatus {
  if (lifecycle?.status === "error") return "failed";
  if (lifecycle?.status === "idle") return "stopped";
  if (lifecycle?.status === "pending") {
    if (previewStopping(lifecycle.phase)) return "stopped";
    return browser.error ? "failed" : "starting";
  }
  if (browser.application?.status === "failed") return "failed";
  if (browser.error) return "failed";
  if (lifecycle?.status === "ready") {
    if (readiness.application_ready) return "ready";
    if (browser.available) return "starting";
    return browser.loading ? "starting" : "unavailable";
  }
  if (readiness.application_ready) return "ready";
  if (browser.available) return "starting";
  if (browser.loading || browser.currentUrl) return "starting";
  return "stopped";
}

function previewHarnessStatusMessage(
  status: PreviewHarnessStatus,
  browser: PreviewDevtoolsTarget,
  lifecycle: PreviewLifecycleState | undefined,
) {
  if (status === "failed") {
    const message =
      browser.application?.diagnostic ??
      browser.error ??
      lifecycle?.failure?.message;
    return {
      message: message ?? "The preview failed.",
      reason: "PREVIEW_FAILED",
    };
  }
  return previewStatusMessages[status];
}

function previewReadiness(
  browser: PreviewDevtoolsTarget,
  lifecycle: PreviewLifecycleState | undefined,
  revisions: WorkspaceRevisionState | undefined,
) {
  // The agent has its own browser, so the user's panel visibility is
  // irrelevant here.
  const browserReady = browser.available;
  const containerReady = lifecycle
    ? lifecycle.status === "ready"
    : browserReady;
  return {
    browser_ready: browserReady,
    container_ready: containerReady,
    application_ready:
      browserReady &&
      containerReady &&
      revisions?.dependencies_ready !== false &&
      browser.application?.status === "ready",
  };
}

function previewStopping(phase: PreviewLifecycleState["phase"]) {
  return ["stopping", "suspending", "destroying"].includes(phase);
}
