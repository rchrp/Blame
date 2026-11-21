// Which professional practices a project follows (or, for a starter, adopts),
// from a scan of its files: the brief carries samples of its sources, tests
// and commits, enough to answer in one reply, as the Cline version did; the
// harness's read-only tools confirm a practice the samples leave uncertain.
// (Requiring a read first cost a refused submission: 12 s of a 22 s run.) The
// engine's `submit_project_code_practices` checks the whole answer, each
// practice once and a starter's defaults included.

import {
  projectCodePracticesPrompt,
  projectCodePracticesResultSchema,
  resolveProjectCodePracticesResult,
} from "../../project-code-practices.js";
import { scanProjectCodePractices } from "../../project-code-practices-scan.js";
import { loadPrompt } from "../../prompt-loader.js";
import type { ProjectCodePracticeResult } from "../../types.js";
import type { AnalyzeCodePracticesTask } from "../task-protocol.js";
import {
  assertHostScan,
  submitTool,
  taskConfig,
  type TaskSpec,
} from "../tasks/runner.js";
import { readOnlyHarness } from "./project-initialization.js";

export const CODE_PRACTICES_TOOL = "submit_project_code_practices";

export async function codePracticesTask(
  input: AnalyzeCodePracticesTask,
): Promise<TaskSpec<ProjectCodePracticeResult[]>> {
  // The scan reads the folder on this computer: never one in the VM.
  assertHostScan(input.workspace);
  const config = taskConfig({
    purpose: "code-practices",
    model: input.model,
    systemPrompt: loadPrompt("project-code-practices-system"),
    workspace: input.workspace,
    engineTools: readOnlyHarness.engineTools,
    toolOptions: readOnlyHarness.toolOptions,
    contract: {
      result: submitTool(
        CODE_PRACTICES_TOOL,
        "Submit the complete project code practice analysis.",
        projectCodePracticesResultSchema,
      ),
      allowed: readOnlyHarness.allowed,
      max_corrections: 2,
    },
    limits: { max_requests_per_turn: 16, max_turn_ms: 10 * 60_000 },
  });
  const scan = await scanProjectCodePractices(input.workspace.root);
  return {
    config,
    instruction: projectCodePracticesPrompt(scan),
    result: (value) => resolveProjectCodePracticesResult(value, scan.commits),
  };
}
