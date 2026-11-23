// `blame_repair`: the fixes the agent may apply on its own, and the
// hand-over for the rest. The actions are an allowlist, each one
// reversible (the same step undoes it) and limited to what this
// conversation owns or what is stopped: its own preview, the user's MCP
// servers, the runtime VM when it is stopped. Every action answers with the
// state before and after, and what to do if it did not work. It never
// touches approvals, permissions, credentials or the API connection, and it
// never restarts a running runtime or engine: that would interrupt other
// conversations' work, so those steps go to the person (`hand_over`).
//
// What the agent read (logs, errors) only chooses among these actions; no
// text from it becomes a command, a path or a URL here.

import { defineTool, type ClientTool } from "../tool.js";
import { diagnoseMcp, diagnosePreview } from "./blame-diagnosis.js";
import {
  blameFailure,
  blameOutput,
  logText,
  settle,
  tailLines,
} from "./blame-output.js";
import {
  settingsSections,
  type BlameAppState,
  type BlameToolServices,
  type SettingsSection,
} from "./blame-types.js";
import type { PreviewRuntimeContext } from "./preview-types.js";

export const blameRepairName = "blame_repair";

const actions = [
  "restart_preview",
  "refresh_dependencies",
  "start_runtime",
  "reconnect_mcp",
  "hand_over",
] as const;

/** Where each Settings section is, in the words the person sees. */
export const settingsLabels: Record<SettingsSection, string> = {
  models: "Settings → Models & Providers",
  mcp: "Settings → MCP Servers",
  desktop: "Settings → Desktop",
  account: "Settings → Account",
  general: "Settings → General",
};

export type BlameRepairSession = { preview?: PreviewRuntimeContext };

export function blameRepairTool(
  services: BlameToolServices,
  session: BlameRepairSession,
): ClientTool<never> {
  return defineTool<Record<string, unknown>>({
    name: blameRepairName,
    description:
      "Fix what is fixable, one reversible step; each answers with before and after. restart_preview; refresh_dependencies (reinstall after a package change, then restart); start_runtime (only if the VM is stopped); reconnect_mcp name=…; hand_over where=… why=… for what only the person can do (sign in, paste a key, authorize, install or repair the runtime): it shows them the Settings tab. Never work around a hand-over or touch approvals, permissions, credentials.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: actions },
        name: { type: "string", description: "reconnect_mcp: the server." },
        where: {
          type: "string",
          enum: settingsSections,
          description: "hand_over: the Settings section.",
        },
        why: {
          type: "string",
          description: "hand_over: what the person does there.",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
    effect: "command",
    timeoutMs: 6 * 60_000,
    async run(input, { signal }) {
      try {
        switch (input.action) {
          case "restart_preview":
            return blameOutput(await restartPreview(services, session, signal));
          case "refresh_dependencies":
            return blameOutput(
              await refreshDependencies(services, session, signal),
            );
          case "start_runtime":
            return blameOutput(await startRuntime(services));
          case "reconnect_mcp":
            return blameOutput(await reconnectMcp(services, input, signal));
          case "hand_over":
            return blameOutput(handOver(input));
          default:
            return blameFailure(`action must be one of ${actions.join(", ")}.`);
        }
      } catch (error) {
        return blameFailure(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  });
}

async function previewState(
  services: BlameToolServices,
  preview: PreviewRuntimeContext,
  waitFor: "none" | "ready",
  signal: AbortSignal,
) {
  const state = await services.previewDevtools?.({
    ...preview,
    signal,
    waitFor,
  });
  return state
    ? { status: state.status, reason: state.reason, message: state.message }
    : undefined;
}

// What a preview that is not ready says, for the answer after a repair.
async function stillFailing(
  services: BlameToolServices,
  preview: PreviewRuntimeContext,
  signal: AbortSignal,
  message: string,
) {
  const logs = await settle(
    services.previewContainerLogs?.({ ...preview, tailLines: 120, signal }) ??
      Promise.resolve(undefined),
    8_000,
  );
  const text = logs.ok ? logText(logs.value) : "";
  const diagnosis = diagnosePreview(`${message}\n${text}`);
  return {
    ...(diagnosis ? { cause: diagnosis.cause } : {}),
    logExcerpt: tailLines(text, 20).lines,
    next:
      diagnosis?.next ??
      "It still fails and the log shows no known cause: stop repairing, tell the person what the excerpt says.",
  };
}

function noPreview(preview: PreviewRuntimeContext | undefined) {
  if (!preview)
    throw new Error(
      "This conversation has no managed preview to repair. Previews belong to stories.",
    );
  return preview;
}

async function restartPreview(
  services: BlameToolServices,
  session: BlameRepairSession,
  signal: AbortSignal,
) {
  const preview = noPreview(session.preview);
  if (!services.blameApp)
    throw new Error("The app cannot restart previews here.");
  if (
    preview.workspaceMode === "cloud-mirror" ||
    preview.workspaceMode === "direct"
  )
    return {
      outcome: "not_supported",
      reason:
        preview.workspaceMode === "direct"
          ? "This story runs the project's own app: use project_app action=start."
          : "A cloud preview is managed by Blame's cloud.",
      next: "blame_repair action=hand_over where=general: the person restarts it from the preview panel.",
    };
  const before = await previewState(services, preview, "none", signal);
  await services.blameApp({
    action: "restart_preview",
    worktree: preview.worktree,
    ...(preview.workspaceMode ? { workspaceMode: preview.workspaceMode } : {}),
  });
  const after = await previewState(services, preview, "ready", signal);
  const fixed = after?.status === "ready";
  return {
    action: "restart_preview",
    before,
    after,
    outcome: fixed ? "fixed" : "still_failing",
    ...(fixed
      ? { next: "The preview is ready." }
      : await stillFailing(services, preview, signal, after?.message ?? "")),
  };
}

async function refreshDependencies(
  services: BlameToolServices,
  session: BlameRepairSession,
  signal: AbortSignal,
) {
  const preview = noPreview(session.preview);
  if (!services.refreshPreviewDependencies)
    throw new Error("The app cannot refresh dependencies here.");
  const before = await previewState(services, preview, "none", signal);
  const result = await services.refreshPreviewDependencies(preview);
  const after = await previewState(services, preview, "none", signal);
  const fixed = result.status === "ready" && after?.status === "ready";
  return {
    action: "refresh_dependencies",
    before,
    after,
    result: result.status,
    outcome: fixed
      ? "fixed"
      : result.status === "not_running"
        ? "not_running"
        : "still_failing",
    ...(fixed
      ? { next: "Dependencies installed and the preview is ready." }
      : result.status === "not_running"
        ? {
            next: "The preview is stopped: blame_repair action=restart_preview.",
          }
        : await stillFailing(
            services,
            preview,
            signal,
            result.diagnostic ?? after?.message ?? "",
          )),
  };
}

async function startRuntime(services: BlameToolServices) {
  if (!services.blameApp)
    throw new Error("The app cannot start the runtime here.");
  const state = (await services.blameApp({ action: "state" })) as BlameAppState;
  const before = state.runtime?.status;
  if (before === "ready")
    return {
      action: "start_runtime",
      outcome: "already_running",
      next: "The runtime is up: look elsewhere (blame_inspect area=preview).",
    };
  if (!state.runtime?.startRequired)
    return {
      action: "start_runtime",
      outcome: "not_a_start",
      before,
      next: "The runtime is not just stopped (it is missing, outdated or broken): blame_repair action=hand_over where=desktop. Only the person installs or repairs it.",
    };
  const after = (await services.blameApp({
    action: "start_runtime",
  })) as BlameAppState;
  const ready = after.runtime?.status === "ready";
  return {
    action: "start_runtime",
    before,
    after: after.runtime?.status,
    outcome: ready ? "fixed" : "still_failing",
    next: ready
      ? "The runtime is up: blame_repair action=restart_preview if the preview was waiting for it."
      : "It did not come up: blame_repair action=hand_over where=desktop.",
  };
}

async function reconnectMcp(
  services: BlameToolServices,
  input: Record<string, unknown>,
  signal: AbortSignal,
) {
  if (!services.mcp) throw new Error("MCP servers are not available here.");
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new Error("reconnect_mcp needs the server's name.");
  const before = (await services.mcp.status()).find(
    (server) => server.name === name,
  );
  if (!before) throw new Error(`No MCP server named "${name}".`);
  const after = await services.mcp.reconnect(name, signal);
  const fixed = after.state === "connected";
  const diagnosis =
    !fixed && after.error ? diagnoseMcp(after.error) : undefined;
  return {
    action: "reconnect_mcp",
    before: {
      state: before.state,
      ...(before.error ? { error: before.error } : {}),
    },
    after,
    outcome: fixed ? "fixed" : "still_failing",
    ...(diagnosis ? { cause: diagnosis.cause } : {}),
    next: fixed
      ? `Connected with ${after.tools ?? 0} tools; they show in new conversations.`
      : (diagnosis?.next ??
        "It still fails. Tell the person the error; do not retry in a loop."),
  };
}

/** The step only the person can take; the timeline offers them the tab. */
export function handOver(input: Record<string, unknown>) {
  const where = settingsSections.find((section) => section === input.where);
  if (!where)
    throw new Error(`where must be one of ${settingsSections.join(", ")}.`);
  const why =
    typeof input.why === "string" ? input.why.trim().slice(0, 300) : "";
  if (!why) throw new Error("hand_over needs why: what the person does there.");
  return {
    handedOver: true,
    where: settingsLabels[where],
    why,
    next: `Tell the person, in your reply, to open ${settingsLabels[where]} and ${why.replace(/\.$/, "")}. Wait for them: do not retry, work around it, or ask for the secret in chat.`,
  };
}
