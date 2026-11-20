// What the preview tools know of a conversation's preview, and what the
// desktop answers about it (`desktop-services.ts`). Data only.

import type { ComponentPreviewRequest } from "../../component-preview-request.js";
import type { PreviewEnvironmentKeyStatus } from "../../preview-environment-types.js";
import {
  initializationSurface,
  type PreviewInitialization,
} from "../../preview-selection.js";

export type PreviewSurfaceInfo = {
  type: "terminal" | "display" | "device" | "host-window";
  serviceId?: string;
  targetId?: string;
};

export type PreviewDevtoolsTarget = {
  application?: {
    status: "ready" | "failed" | "unverified";
    httpStatus?: number;
    diagnostic?: string;
  };
  available: boolean;
  currentUrl?: string;
  error?: string;
  id?: string;
  lifecycle?: unknown;
  loading: boolean;
  visible?: boolean;
  message: string;
  reason: string;
  readiness?: {
    browser_ready: boolean;
    container_ready: boolean;
    application_ready: boolean;
  };
  revisions?: {
    source_revision_id: string;
    environment_revision_id: string;
    dependencies_ready: boolean;
  };
  scope?: string;
  status: "failed" | "ready" | "starting" | "stopped" | "unavailable";
};

/** A conversation's preview, as its tools address it. */
export type PreviewRuntimeContext = {
  // The desktop offers open_component_preview to this session: a Vite
  // project, whatever its workspace (see component-preview.ts).
  componentPreview?: boolean;
  surface?: PreviewSurfaceInfo;
  previewManifest?: PreviewInitialization["previewManifest"];
  projectId?: string;
  scope?: string;
  storyId?: string;
  workspaceMode?: "local-container" | "cloud-mirror" | "direct";
  worktree: string;
};

export type PreviewDependencyRefreshResult = {
  diagnostic?: string;
  readiness?: PreviewDevtoolsTarget["readiness"];
  revisions?: PreviewDevtoolsTarget["revisions"];
  status: "failed" | "not_running" | "ready";
};

export type PreviewInitializationRepairResult = {
  classification: string;
  reason: string;
  status: "applied" | "not_repairable" | "unavailable";
};

export type PreviewDevtoolsToolDescriptor = {
  description?: string;
  inputSchema: Record<string, unknown>;
  name: string;
  annotations?: { readOnlyHint?: boolean };
};

export type PreviewDevtoolsTargetInput = PreviewRuntimeContext & {
  signal?: AbortSignal;
  waitFor: "none" | "ready";
};

export type PreviewDevtoolsProviderInput = PreviewRuntimeContext & {
  signal?: AbortSignal;
};

export type PreviewDevtoolsCallInput = PreviewDevtoolsProviderInput & {
  arguments?: Record<string, unknown>;
  // Recorded with each screenshot, so the final answer can only show
  // screenshots taken in this conversation.
  runId?: string;
  sessionId?: string;
  toolCallId?: string;
  toolName: string;
};

export type PreviewContainerLogsInput = PreviewRuntimeContext & {
  service?: string;
  signal?: AbortSignal;
  tailLines?: number;
};

export type PreviewSurfaceCallInput = PreviewRuntimeContext & {
  surface: PreviewSurfaceInfo;
  arguments: Record<string, unknown>;
  signal?: AbortSignal;
  sessionId?: string;
  toolCallId?: string;
};

export type PreviewEnvironmentToolInput = PreviewRuntimeContext &
  (
    | { action: "list" }
    | { action: "request"; key: string; reason: string; serviceId?: string }
  );

export type PreviewEnvironmentToolResult =
  | { action: "list"; variables: PreviewEnvironmentKeyStatus[] }
  | { action: "request"; requested: string };

export type ProjectAppInput = {
  action: "start" | "status";
  signal?: AbortSignal;
  worktree: string;
};

type ComponentPreviewTarget = {
  projectId?: string;
  scope?: string;
  storyId?: string;
  workspaceMode?: PreviewRuntimeContext["workspaceMode"];
  worktree: string;
};

export type ComponentPreviewHostInput =
  | (ComponentPreviewTarget & {
      action: "render";
      request: ComponentPreviewRequest;
      runId?: string;
      sessionId?: string;
      signal?: AbortSignal;
      toolCallId?: string;
    })
  | {
      action: "stop";
      sessionId?: string;
      signal?: AbortSignal;
      worktree: string;
    };

export type PreviewScreenshotKnownInput = {
  id: string;
  scope?: string;
  sessionId?: string;
};

export type GithubMcpToolDescriptor = {
  description?: string;
  inputSchema: Record<string, unknown>;
  name: string;
};

export type GithubMcpCallInput = {
  arguments?: Record<string, unknown>;
  sessionId: string;
  signal?: AbortSignal;
  toolName: string;
};

type PreviewSessionContextInput = {
  componentPreview?: boolean;
  projectInitialization?: PreviewInitialization;
  previewDevtoolsScope?: string;
  projectId?: string;
  storyId?: string;
  workspaceMode?: "local-container" | "cloud-mirror" | "direct";
  workspaceRoot: string;
};

export function previewRuntimeContext(
  input: PreviewSessionContextInput,
): PreviewRuntimeContext {
  const surface = initializationSurface(
    input.projectInitialization,
    input.previewDevtoolsScope,
  );
  return {
    ...(surface
      ? { previewManifest: input.projectInitialization?.previewManifest }
      : {}),
    surface,
    ...(input.previewDevtoolsScope
      ? { scope: input.previewDevtoolsScope }
      : {}),
    ...(input.componentPreview ? { componentPreview: true } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.storyId ? { storyId: input.storyId } : {}),
    ...(input.workspaceMode ? { workspaceMode: input.workspaceMode } : {}),
    worktree: input.workspaceRoot,
  };
}
