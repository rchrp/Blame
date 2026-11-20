// A story's `repair_preview_initialization`: the engine task that repairs a
// project's preview setup (`runInitializationRepair`), run for the story's
// worktree, then applied to its managed preview by the desktop. The story
// keeps the repaired setup for its next repair.

import type { PreviewInitialization } from "../../preview-selection.js";
import type { EngineModelChoice } from "../protocol.js";
import type {
  RepairProjectInitializationResult,
  RepairProjectInitializationTask,
} from "../task-protocol.js";
import type { PreviewToolServices } from "./preview.js";
import type {
  PreviewInitializationRepairResult,
  PreviewRuntimeContext,
} from "./preview-types.js";

/** What a story's repair needs to know of it. */
export type StoryPreviewRepair = {
  model: EngineModelChoice;
  projectId: string;
  initialization: PreviewInitialization;
};

export type PreviewRepairServices = Pick<
  PreviewToolServices,
  "previewDevtools" | "previewContainerLogs" | "applyPreviewInitialization"
> & {
  /** Runs the repair task (`runInitializationRepair` in the host). */
  repairInitialization?(
    input: RepairProjectInitializationTask,
  ): Promise<RepairProjectInitializationResult>;
};

/** The repair a story's preview tools offer; undefined without the services. */
export function storyPreviewRepair(
  services: PreviewRepairServices,
  story: StoryPreviewRepair | undefined,
):
  | ((
      preview: PreviewRuntimeContext,
    ) => Promise<PreviewInitializationRepairResult>)
  | undefined {
  const { repairInitialization, applyPreviewInitialization } = services;
  if (!story || !repairInitialization || !applyPreviewInitialization)
    return undefined;
  let initialization = story.initialization;
  return async (preview) => {
    const repair = await repairInitialization({
      model: story.model,
      projectId: story.projectId,
      workspace: { root: preview.worktree },
      previewManifest: initialization.previewManifest,
      runConfigurations: initialization.runConfigurations,
      preferences: { database: { mode: "compose" } },
      diagnostics: await diagnostics(services, preview),
    });
    const { previewManifest, runConfigurations } = repair;
    if (!previewManifest || !runConfigurations)
      return {
        classification: repair.classification,
        reason: repair.reason,
        status: "not_repairable",
      };
    const applied = await applyPreviewInitialization({
      databaseMode: "compose",
      previewManifest,
      reason: repair.reason,
      repairSessionId: repair.session,
      runConfigurations,
      storyId: preview.storyId ?? "preview-repair",
      worktree: preview.worktree,
      workspaceMode: preview.workspaceMode,
    });
    if (applied.status === "applied")
      initialization = {
        ...initialization,
        previewManifest,
        runConfigurations,
      };
    return {
      classification: repair.classification,
      reason: repair.reason,
      status: applied.status,
    };
  };
}

/** What the preview says now, for the repair agent. */
async function diagnostics(
  services: PreviewRepairServices,
  preview: PreviewRuntimeContext,
) {
  const [target, logs] = await Promise.all([
    services.previewDevtools?.({ ...preview, waitFor: "none" }),
    services.previewContainerLogs?.(preview),
  ]);
  return {
    setupLog: "",
    launchError:
      target?.message ?? "Managed preview initialization is obsolete.",
    composeConfig: "",
    composePs: "",
    serviceLogs: { preview: JSON.stringify(logs ?? {}).slice(0, 32_000) },
  };
}
