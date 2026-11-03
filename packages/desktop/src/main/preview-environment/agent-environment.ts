import type { PreviewEnvironmentToolResult } from "@blame/agent-runtime";
import { resolveWorkspacePath } from "../workspace-runtime.ts";
import { previewEnvironmentKeyStatuses } from "./environment-view.ts";
import { previewVariablesStore } from "./variables-store.ts";

// The development agent's preview_environment tool: key names and statuses
// only, and requests the person answers in the Variables tab.

export async function agentPreviewEnvironment(
  input: unknown,
): Promise<PreviewEnvironmentToolResult> {
  const record =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  const worktree = resolveWorkspacePath(String(record.worktree ?? ""));
  if (!worktree) throw new Error("The preview of this story is unknown.");
  if (record.action === "request") {
    const store = previewVariablesStore();
    if (!store) throw new Error("Preview variables are not available.");
    const key = String(record.key ?? "");
    await store.request(worktree, {
      key,
      reason: String(record.reason ?? ""),
      ...(typeof record.serviceId === "string" && record.serviceId
        ? { serviceId: record.serviceId }
        : {}),
    });
    return { action: "request", requested: key };
  }
  return {
    action: "list",
    variables: await previewEnvironmentKeyStatuses({ worktree }),
  };
}
