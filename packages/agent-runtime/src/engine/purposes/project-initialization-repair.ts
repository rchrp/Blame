// A preview setup that failed, diagnosed from its logs (or from a diff
// that made it obsolete) and repaired when the setup is the cause. It may
// read the project with the harness's read-only tools. Its result tool is
// the host's own `submit_project_initialization_repair`: a repaired setup
// must pass Blame's checks, and a refused one goes back to the agent as the
// call's error, in the same turn.

import {
  scanProjectWorkspace,
  type ProjectScanRootProvider,
} from "../../project-initialization.js";
import {
  parseProjectInitializationRepairPayload,
  projectInitializationRepairPrompt,
  projectInitializationRepairResultSchema,
  type ProjectInitializationRepair,
} from "../../project-initialization-repair.js";
import { loadPrompt } from "../../prompt-loader.js";
import type { RepairProjectInitializationTask } from "../task-protocol.js";
import { defineTool, toolSpec } from "../tool.js";
import { taskConfig, type TaskSpec } from "../tasks/runner.js";
import { readOnlyHarness } from "./project-initialization.js";

export const REPAIR_TOOL = "submit_project_initialization_repair";

export async function projectInitializationRepairTask(
  input: RepairProjectInitializationTask,
  /** A readable copy of a workspace this process cannot read directly. */
  scanRoot?: ProjectScanRootProvider,
): Promise<TaskSpec<ProjectInitializationRepair>> {
  const parse = (value: unknown) =>
    parseProjectInitializationRepairPayload(value, scan, input.preferences);
  const submit = defineTool<Record<string, unknown>>({
    name: REPAIR_TOOL,
    description:
      "Submit the complete project initialization diagnosis. Blame checks a repaired setup immediately: a rejected one comes back as an error to fix before submitting again.",
    inputSchema: projectInitializationRepairResultSchema,
    effect: "read_only",
    run: (value) => {
      parse(value);
      return "Accepted.";
    },
  });
  // Built before the scan: a workspace in the VM fails here.
  const config = taskConfig({
    purpose: "project-initialization-repair",
    model: input.model,
    systemPrompt: loadPrompt("project-initialization-repair-system"),
    workspace: input.workspace,
    engineTools: readOnlyHarness.engineTools,
    toolOptions: readOnlyHarness.toolOptions,
    clientTools: [toolSpec(submit)],
    contract: {
      result: { source: "tool", name: REPAIR_TOOL },
      allowed: readOnlyHarness.allowed,
      max_corrections: 2,
    },
    limits: { max_requests_per_turn: 16, max_turn_ms: 15 * 60_000 },
  });
  const scan = await scanProjectWorkspace(input.workspace.root, scanRoot);
  return {
    config,
    tools: [submit],
    instruction: projectInitializationRepairPrompt(input, scan),
    result: parse,
  };
}
