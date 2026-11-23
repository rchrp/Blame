// Blame's self-repair tools (docs/engine-in-the-app.md, "Self-repair tools"):
// three tools, each with an `action` or `area`, instead of one per
// operation, so they cost the prompt little and the model picks between
// three names, not twelve. What they know lives in the `blame-help` skill,
// not in their schemas.

import type { ClientTool } from "../tool.js";
import { blameConfigureTool } from "./blame-configure.js";
import { blameInspectTool } from "./blame-inspect.js";
import { blameRepairTool } from "./blame-repair.js";
import type { BlameToolServices } from "./blame-types.js";
import type { PreviewRuntimeContext } from "./preview-types.js";

export type BlameToolsSession = {
  session: string;
  workspaceRoot: string;
  preview?: PreviewRuntimeContext;
};

/** The three tools; none without the app's `blameApp` service (no desktop, no Blame to repair). */
export function blameClientTools(
  services: BlameToolServices,
  session: BlameToolsSession,
): ClientTool<never>[] {
  if (!services.blameApp) return [];
  return [
    blameInspectTool(services, session),
    blameConfigureTool(services, session),
    blameRepairTool(services, session),
  ];
}
