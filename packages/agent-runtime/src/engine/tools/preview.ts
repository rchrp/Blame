// The tools of a conversation's Blame preview: its readiness, logs and
// variables, the project's own app, its screen (terminal, display, device)
// and the browser DevTools tools the desktop exposes for it. The desktop
// answers each call (`DesktopServices`); these tools shape what the model
// reads and keep it bounded.

import { currentWorkspaceRevisionState } from "../../harness/workspace-revisions.js";
import { sha256 } from "../../harness/light-identity.js";
import { previewDevtoolsAgentTimeoutMs } from "../../preview-devtools-policy.js";
import { limitText, toolOutputLimits } from "../../tool-output-limit.js";
import type { DesktopServices } from "../desktop-services.js";
import { defineTool, type ClientTool } from "../tool.js";
import { errorMessage, previewOutput, record } from "./output.js";
import type {
  PreviewDevtoolsTarget,
  PreviewInitializationRepairResult,
  PreviewRuntimeContext,
  PreviewSurfaceInfo,
} from "./preview-types.js";

export type PreviewToolServices = Omit<DesktopServices, "git"> & {
  /** Repairs the story's managed preview setup (a one-shot agent). */
  repairPreviewInitialization?(
    preview: PreviewRuntimeContext,
  ): Promise<PreviewInitializationRepairResult>;
  log?(message: string, payload?: Record<string, unknown>): void;
};

type Tool = ClientTool<never>;

export const previewDevtoolsPrefix = "preview_devtools__";

/**
 * Every preview tool the conversation's preview and the desktop allow. The
 * DevTools tools are listed by the desktop when the conversation starts.
 */
export async function previewClientTools(
  services: PreviewToolServices,
  preview: PreviewRuntimeContext | undefined,
): Promise<Tool[]> {
  if (!preview) return [];
  const screen = await previewScreenTools(services, preview);
  const tools = [
    previewDevtoolsTool(services, preview),
    ...(preview.workspaceMode === "direct"
      ? // The project's own app: no managed container to repair or read.
        [projectAppTool(services, preview)]
      : [
          previewInitializationRepairTool(services, preview),
          previewContainerLogsTool(services, preview),
          previewEnvironmentTool(services, preview),
        ]),
    ...screen,
  ];
  return tools.filter((tool): tool is Tool => Boolean(tool));
}

/** The surface tool of a terminal, display or device preview, else its DevTools tools. */
export async function previewScreenTools(
  services: PreviewToolServices,
  preview: PreviewRuntimeContext,
): Promise<Tool[]> {
  const surface =
    (await services.previewSurfaceInfo?.(preview).catch(() => undefined)) ??
    preview.surface;
  if (surface) {
    preview.surface = surface;
    const tool = previewSurfaceTool(services, preview, surface);
    return tool ? [tool] : [];
  }
  return previewDevtoolsMcpTools(services, preview);
}

/** The browser tools of the preview, as the desktop's DevTools service lists them. */
export async function previewDevtoolsMcpTools(
  services: PreviewToolServices,
  preview: PreviewRuntimeContext,
): Promise<Tool[]> {
  const list = services.previewDevtoolsTools;
  if (
    !preview.scope ||
    !list ||
    !services.previewDevtools ||
    !services.previewDevtoolsCall
  )
    return [];
  try {
    const descriptors = await list(preview);
    return descriptors.map((descriptor) =>
      defineTool<Record<string, unknown>>({
        name: `${previewDevtoolsPrefix}${descriptor.name}`,
        description:
          descriptor.description?.trim() ||
          `Execute MCP tool "${descriptor.name}" from server "preview-devtools".`,
        inputSchema: descriptor.inputSchema,
        effect: descriptor.annotations?.readOnlyHint ? "read_only" : "command",
        source: {
          kind: "mcp",
          server: "preview_devtools",
          readOnly: descriptor.annotations?.readOnlyHint,
        },
        // The desktop service sets each call's timeout (the wait asked for,
        // emulated slowdown); the agent waits past its ceiling, so it reads
        // the service's timeout message instead of cutting the call itself.
        timeoutMs: previewDevtoolsAgentTimeoutMs(),
        run: async (input, context) =>
          previewOutput(
            context.session,
            await callPreviewDevtools(services, preview, {
              toolName: descriptor.name,
              arguments: input,
              signal: context.signal,
              session: context.session,
              turn: context.turn,
              call: context.call,
            }),
            toolOutputLimits.previewDevtools,
          ),
      }),
    );
  } catch (error) {
    services.log?.("Preview DevTools MCP tools unavailable", {
      error: errorMessage(error),
    });
    return [];
  }
}

async function callPreviewDevtools(
  services: PreviewToolServices,
  preview: PreviewRuntimeContext,
  request: {
    toolName: string;
    arguments: Record<string, unknown>;
    signal: AbortSignal;
    session: string;
    turn: string;
    call: string;
  },
) {
  const { signal } = request;
  const target = await services.previewDevtools!({
    ...preview,
    signal,
    waitFor: "none",
  });
  if (!target || target.status !== "ready" || !target.available)
    return previewNotReadyResult(target);
  const evidence = await currentPreviewEvidence(preview, target);
  if (evidence.status !== "passed") return previewEvidenceUnavailableResult();
  const failureKey = request.session || preview.scope || "";
  try {
    const result = await services.previewDevtoolsCall!({
      ...preview,
      arguments: request.arguments,
      signal,
      toolName: request.toolName,
      runId: request.turn,
      sessionId: request.session,
      toolCallId: request.call,
    });
    transientFailures.delete(failureKey);
    return attachPreviewEvidence(result, evidence);
  } catch (error) {
    if (!transientDevtoolsFailure(error) || signal.aborted) throw error;
    const count = (transientFailures.get(failureKey) ?? 0) + 1;
    transientFailures.set(failureKey, count);
    return previewToolUnavailableResult(error, count < maxTransientRetries + 1);
  }
}

// The desktop resets the browser connection after a timeout or a dropped
// connection, so the next call usually works. One retry is worth it; after
// that the browser is likely down for this run.
const maxTransientRetries = 1;
const transientFailures = new Map<string, number>();

function previewToolUnavailableResult(error: unknown, retryable: boolean) {
  return {
    content: [
      {
        type: "text",
        text: `Preview DevTools is temporarily unavailable: ${errorMessage(error)}`,
      },
    ],
    isError: false,
    outcome: "unavailable",
    reason: "PREVIEW_DEVTOOLS_TRANSIENT_FAILURE",
    recommendation: retryable
      ? "The browser connection was reset. Retry this call once, with a shorter wait if it ran out of time. If it fails the same way again, continue with local validation and report the limitation."
      : "Continue with local validation. Retry browser inspection only after managed preview state changes; do not start replacement infrastructure.",
    retryable,
  };
}

function previewNotReadyResult(target: PreviewDevtoolsTarget | undefined) {
  const status = target?.status ?? "unavailable";
  return {
    content: [
      {
        type: "text",
        text: target?.message ?? "Preview readiness evidence is unavailable.",
      },
    ],
    isError: false,
    outcome: "unavailable",
    reason: target?.reason ?? "PREVIEW_NOT_READY",
    recommendation: previewDevtoolsRecommendation(status),
    retryable: status === "starting",
  };
}

function previewEvidenceUnavailableResult() {
  return {
    content: [
      {
        type: "text",
        text: "Application readiness is unavailable for the current source and environment revisions.",
      },
    ],
    isError: false,
    outcome: "unavailable",
    reason: "PREVIEW_REVISION_EVIDENCE_UNAVAILABLE",
    retryable: false,
  };
}

function transientDevtoolsFailure(error: unknown) {
  return /econnreset|navigation|session closed|target closed|temporar|timed?\s*out|did not finish|(?:connection|transport|channel) (?:closed|disconnected)|not connected|server (?:closed|disconnected|terminated)|scoped preview page is no longer available/iu.test(
    errorMessage(error),
  );
}

function attachPreviewEvidence(result: unknown, evidence: unknown) {
  if (!result || typeof result !== "object" || Array.isArray(result))
    return result;
  const value = result as Record<string, unknown>;
  return {
    ...value,
    _meta: { ...record(value._meta), previewReadyEvidence: evidence },
  };
}

export function previewDevtoolsTool(
  services: PreviewToolServices,
  preview: PreviewRuntimeContext,
): Tool | undefined {
  const target = services.previewDevtools;
  if (!target || preview.surface) return undefined;
  return defineTool<Record<string, unknown>>({
    name: "get_preview_devtools",
    description:
      "Inspect browser, container, and application readiness for this session's Blame preview. Readiness requires an exploitable HTTP response, no blocking compiler diagnostic, usable dependencies, and the current source and environment revisions. For a stopped or starting local preview, waitFor=ready follows managed startup until it succeeds or reports an explicit failure. Once running, application readiness is bounded to 2 seconds. Failed and unopened previews return immediately. preview_devtools__* tools use a browser reserved for you: it works while the user's preview panel is closed and never moves what the user is looking at.",
    inputSchema: {
      type: "object",
      properties: {
        waitFor: {
          type: "string",
          enum: ["none", "ready"],
          default: "none",
          description:
            "Use none to return the current state immediately. Use ready to start or follow a managed preview until startup succeeds or explicitly fails; the running application's readiness probe is limited to 2 seconds.",
        },
      },
      additionalProperties: false,
    },
    effect: "read_only",
    async run(input, { signal }) {
      const state = await target({
        ...preview,
        signal,
        waitFor: input.waitFor === "ready" ? "ready" : "none",
      });
      if (!state) throw new Error("Preview state is unavailable.");
      return {
        json: {
          ...state,
          preview_ready_evidence: await currentPreviewEvidence(preview, state),
          recommendation: previewDevtoolsRecommendation(state.status),
          usage: state.available
            ? "Use the preview_devtools__* tools directly. They drive a browser reserved for you on this preview (1440x900 by default), independent of the user's panel."
            : undefined,
        },
      };
    },
  });
}

async function currentPreviewEvidence(
  preview: PreviewRuntimeContext,
  target: PreviewDevtoolsTarget,
) {
  try {
    const current = await currentWorkspaceRevisionState(preview.worktree);
    const revisions = target.revisions;
    const revisionMatch =
      revisions?.dependencies_ready === true &&
      revisions.source_revision_id === current.source_revision_id &&
      revisions.environment_revision_id === current.environment_revision_id;
    const passed =
      target.status === "ready" &&
      target.available &&
      target.readiness?.application_ready === true &&
      current.dependencies_ready &&
      revisionMatch;
    return {
      status: passed ? ("passed" as const) : ("unavailable" as const),
      scope: "preview_application" as const,
      application_health: target.application?.status ?? "unverified",
      source_revision_id: current.source_revision_id,
      environment_revision_id: current.environment_revision_id,
      preview_revision_match: revisionMatch,
      evidence_ref: `preview-application-ready://${sha256(
        `${current.source_revision_id}\0${current.environment_revision_id}\0${target.status}`,
      )}`,
    };
  } catch {
    return {
      status: "unavailable" as const,
      scope: "preview_application" as const,
      application_health: "unverified" as const,
      source_revision_id: undefined,
      environment_revision_id: undefined,
      preview_revision_match: false,
      evidence_ref: `preview-application-ready://${sha256(`${preview.worktree}\0unavailable`)}`,
    };
  }
}

function previewDevtoolsRecommendation(
  status: PreviewDevtoolsTarget["status"],
) {
  if (status === "starting")
    return "Call again with waitFor=ready only if blocking for startup is useful; otherwise continue other work.";
  if (status === "stopped")
    return "The managed preview is stopped. Call once with waitFor=ready when visual evidence matters; do not start a replacement server, database, or container.";
  if (status === "failed")
    return "Inspect managed preview logs once. If project changes made the persisted runtime topology obsolete, call repair_preview_initialization; otherwise continue with local validation. Do not create replacement infrastructure manually.";
  if (status === "unavailable")
    return "Preview evidence is unavailable. Continue with local validation and report the limitation; do not start manual infrastructure.";
  return "The application and its revision pair are ready. Take a scoped DOM snapshot for UI assertions.";
}

// A story working in the project folder previews the project's own app.
// Blame's project runner runs it, the same one the user starts and stops
// from Blame: the agent checks it or starts it there, never by hand.
export function projectAppTool(
  services: PreviewToolServices,
  preview: PreviewRuntimeContext,
): Tool | undefined {
  const projectApp = services.projectApp;
  if (!projectApp || preview.workspaceMode !== "direct") return undefined;
  return defineTool<Record<string, unknown>>({
    name: "project_app",
    description:
      "Check or start the project's own app through Blame's project runner: the same process the user starts and stops from Blame, with its logs. status reports whether it runs (through Blame or already outside it) and returns recent logs. start launches it when it is stopped and returns once it answers on its port, or fails with its logs. If its port is held by another app, it reports that app instead of starting: tell the user. Never start the app's dev server yourself.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["status", "start"],
          default: "status",
        },
      },
      additionalProperties: false,
    },
    effect: "command",
    run: async (input, { signal }) => ({
      json: await projectApp({
        action: input.action === "start" ? "start" : "status",
        signal,
        worktree: preview.worktree,
      }),
    }),
  });
}

export function previewInitializationRepairTool(
  services: PreviewToolServices,
  preview: PreviewRuntimeContext,
): Tool | undefined {
  const repair = services.repairPreviewInitialization;
  if (!repair) return undefined;
  return defineTool<Record<string, unknown>>({
    name: "repair_preview_initialization",
    description:
      "Reconcile this story's managed preview manifest with newly introduced runtime dependencies or services, such as a database. Use only when preview diagnostics indicate that the persisted initialization topology is obsolete. Blame diagnoses, validates, applies, and restarts the managed preview.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    effect: "command",
    run: async () => ({ json: await repair(preview) }),
  });
}

export function previewContainerLogsTool(
  services: PreviewToolServices,
  preview: PreviewRuntimeContext,
): Tool | undefined {
  const logs = services.previewContainerLogs;
  if (!logs) return undefined;
  return defineTool<Record<string, unknown>>({
    name: "get_preview_container_logs",
    description:
      "Get state-aware logs for this session's Blame preview. Stopped previews return immediately without a container query. Local previews return available compose services, recent stdout and stderr, or the archived setup log; managed previews identify the live log stream. Defaults to the first preview service and 120 tail lines.",
    inputSchema: {
      type: "object",
      properties: {
        service: {
          type: "string",
          description:
            "Optional compose service name to read logs for. When omitted, Blame selects the first preview service, matching the preview drawer.",
        },
        tailLines: {
          type: "number",
          description:
            "Maximum number of recent log lines to return from live containers. Defaults to 120 and is capped at 1000.",
        },
      },
      additionalProperties: false,
    },
    effect: "read_only",
    async run(input, { signal }) {
      const service = stringValue(input.service);
      try {
        return {
          json: boundedContainerLogs(
            await logs({
              ...preview,
              ...(service ? { service } : {}),
              tailLines: boundedNumber(input.tailLines, 1, 1000) ?? 120,
              signal,
            }),
          ),
        };
      } catch (error) {
        return {
          json: {
            outcome: "failed",
            reason: "PREVIEW_LOG_READ_FAILED",
            recommendation:
              "Continue with local validation. Retry logs only after preview state changes.",
            isError: true,
            output: { error: errorMessage(error) },
          },
        };
      }
    },
  });
}

/** Lines can be long (minified bundles, JSON logs) and setup logs untailed. */
function boundedContainerLogs(result: unknown): unknown {
  const value = record(result);
  if (!Object.keys(value).length) return result ?? null;
  return {
    ...value,
    ...(typeof value.stdout === "string"
      ? { stdout: limitText(value.stdout, toolOutputLimits.previewLogStdout) }
      : {}),
    ...(typeof value.stderr === "string"
      ? { stderr: limitText(value.stderr, toolOutputLimits.previewLogStderr) }
      : {}),
  };
}

const environmentKey = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;

// Lets the agent see which environment variables the story's preview has,
// by name and status only, and ask the person for one it needs. Values
// never reach the agent: the person sets them in the Variables tab of the
// preview, where the request shows.
export function previewEnvironmentTool(
  services: PreviewToolServices,
  preview: PreviewRuntimeContext,
): Tool | undefined {
  const environment = services.previewEnvironment;
  if (!environment) return undefined;
  return defineTool<Record<string, unknown>>({
    name: "preview_environment",
    description:
      "List the environment variables of this story's preview by name and status (set, missing or placeholder), never their values. When the story needs a variable only the person can provide, such as an API key, request it: the request shows in the preview's Variables tab, and the value reaches the preview at its next start. Never ask for values in your reply and never write secrets into files.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "request"],
          description: "list the variables, or request one from the person.",
        },
        key: {
          type: "string",
          description:
            "For request: the variable name, such as STRIPE_SECRET_KEY.",
        },
        reason: {
          type: "string",
          description:
            "For request: one sentence on what the story needs it for.",
        },
        serviceId: {
          type: "string",
          description:
            "For request: the preview service that reads it, if one.",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
    effect: "external",
    async run(input) {
      try {
        if (input.action === "request") {
          const key = typeof input.key === "string" ? input.key.trim() : "";
          const reason =
            typeof input.reason === "string" ? input.reason.trim() : "";
          if (!environmentKey.test(key) || !reason)
            return environmentFailure(
              "A request needs a variable name and a reason.",
            );
          return {
            json: await environment({
              ...preview,
              action: "request",
              key,
              reason,
              ...(typeof input.serviceId === "string" && input.serviceId
                ? { serviceId: input.serviceId }
                : {}),
            }),
          };
        }
        return { json: await environment({ ...preview, action: "list" }) };
      } catch (error) {
        return environmentFailure(errorMessage(error));
      }
    },
  });
}

function environmentFailure(message: string) {
  return {
    json: { outcome: "failed", isError: true, output: { error: message } },
  };
}

const surfaceActions = {
  terminal: ["read", "type", "key", "wait_for", "restart"],
  display: ["screenshot", "windows", "click", "type", "key", "scroll", "drag"],
  device: [
    "status",
    "screenshot",
    "describe_ui",
    "tap",
    "swipe",
    "type",
    "key",
    "button",
    "open_url",
    "build_and_run",
    "logs",
  ],
};

export function previewSurfaceTool(
  services: PreviewToolServices,
  preview: PreviewRuntimeContext,
  info: PreviewSurfaceInfo,
): Tool | undefined {
  const call = services.previewSurfaceCall;
  if (info.type === "host-window" || !call) return undefined;
  const type = info.type;
  return defineTool<Record<string, unknown>>({
    name: `preview_${type}`,
    description:
      type === "terminal"
        ? "Read and interact with the program terminal. The user sees this same terminal; do not clear it without reason. read returns at most 200 lines, the cursor and exit code. type writes text; submit adds Enter. wait_for uses a bounded regular expression (200 characters, up to 60 seconds). Restart runs the program again."
        : type === "device"
          ? "Inspect and interact with this story's device. Call describe_ui before tapping; coordinates are in points. Build errors refer to worktree files. Take a screenshot to check changes after build_and_run."
          : "Inspect and interact with the app's screen. Use windows and a screenshot before clicking; coordinates are pixels in the configured screen. The user sees your actions.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: surfaceActions[type] },
        text: { type: "string", maxLength: 64000 },
        submit: { type: "boolean" },
        key: { type: "string", maxLength: 100 },
        keys: { type: "string", maxLength: 100 },
        pattern: { type: "string", maxLength: 200 },
        timeoutMs: { type: "integer", minimum: 1, maximum: 60000 },
        x: { type: "number", minimum: 0, maximum: 3840 },
        y: { type: "number", minimum: 0, maximum: 3840 },
        toX: { type: "number", minimum: 0, maximum: 3840 },
        toY: { type: "number", minimum: 0, maximum: 3840 },
        button: { type: "string", maxLength: 30 },
        double: { type: "boolean" },
        deltaY: { type: "integer", minimum: -1000, maximum: 1000 },
        url: { type: "string", maxLength: 2048 },
      },
      required: ["action"],
      additionalProperties: false,
    },
    effect: "command",
    run: async (input, context) =>
      previewOutput(
        context.session,
        await call({
          ...preview,
          surface: info,
          arguments: boundedSurfaceArguments(input),
          signal: context.signal,
          sessionId: context.session,
          toolCallId: context.call,
        }),
        toolOutputLimits.previewSurface,
      ),
  });
}

export function boundedSurfaceArguments(
  value: unknown,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Surface arguments must be an object.");
  const input = value as Record<string, unknown>;
  if (JSON.stringify(input).length > 70000)
    throw new Error("Surface arguments are too large.");
  if (
    input.pattern !== undefined &&
    (typeof input.pattern !== "string" || input.pattern.length > 200)
  )
    throw new Error("Use a pattern of at most 200 characters.");
  if (
    input.timeoutMs !== undefined &&
    (!Number.isInteger(input.timeoutMs) ||
      Number(input.timeoutMs) < 1 ||
      Number(input.timeoutMs) > 60000)
  )
    throw new Error("Wait at most 60 seconds.");
  return input;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function boundedNumber(value: unknown, minimum: number, maximum: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(Math.max(Math.trunc(value), minimum), maximum);
}
