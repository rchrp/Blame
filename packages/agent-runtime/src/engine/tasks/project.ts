// The engine host's answers to the project tasks: the preview setup of a
// project (initialization, repair, impact of new commits), its code
// practices, and a new project's scaffold.

import { randomUUID } from "node:crypto";
import { updateProjectCloudIgnore } from "../../project-cloud-ignore.js";
import {
  collectProjectInitializationImpactDiagnostics,
  deterministicInitializationImpact,
} from "../../project-initialization-impact.js";
import type { ProjectScanRootProvider } from "../../project-initialization.js";
import { codePracticesTask } from "../purposes/code-practices.js";
import { initializationImpactTask } from "../purposes/initialization-impact.js";
import {
  generatedProjectReadinessError,
  newProjectGenerationTask,
} from "../purposes/new-project-generation.js";
import { projectInitializationRepairTask } from "../purposes/project-initialization-repair.js";
import { projectInitializationTask } from "../purposes/project-initialization.js";
import type {
  RepairProjectInitializationResult,
  RepairProjectInitializationTask,
  TaskCall,
} from "../task-protocol.js";
import type { TaskHandlers, TaskHost } from "./handlers.js";
import { EngineTaskError, type TaskSpec } from "./runner.js";

type ProjectTaskHost = Pick<TaskHost, "runner" | "register" | "clientTools">;

function runTask<R>(
  host: ProjectTaskHost,
  call: TaskCall,
  spec: TaskSpec<R>,
  what: string,
) {
  const session = call.task ?? `task-${randomUUID()}`;
  host.register(session, {
    projectId: call.projectId,
    credentialLabel: call.model.credentialLabel,
  });
  return host.runner.run(spec, { session, what });
}

/**
 * Diagnoses a failed preview setup and repairs it when it can: the task
 * behind `repairProjectInitialization`, for any caller in the engine host
 * (a story's own repair tool among them).
 */
export async function runInitializationRepair(
  host: ProjectTaskHost & { scanRoot?: ProjectScanRootProvider },
  input: RepairProjectInitializationTask,
): Promise<RepairProjectInitializationResult> {
  const { session, result } = await runTask(
    host,
    input,
    await projectInitializationRepairTask(input, host.scanRoot),
    "The preview setup repair",
  );
  return { session, ...result };
}

export function projectTaskHandlers(
  host: ProjectTaskHost,
): TaskHandlers<
  | "initializeProject"
  | "repairProjectInitialization"
  | "assessInitializationImpact"
  | "analyzeCodePractices"
  | "generateNewProject"
> {
  return {
    initializeProject: async (input) => {
      const { session, result } = await runTask(
        host,
        input,
        await projectInitializationTask(input),
        "The project initialization",
      );
      const { cloudPreviewIgnore, ...setup } = result;
      await updateProjectCloudIgnore(input.workspace.root, cloudPreviewIgnore);
      return { session, ...setup };
    },
    repairProjectInitialization: (input) =>
      runInitializationRepair(host, input),
    assessInitializationImpact: async (input) => {
      const diagnostics = await collectProjectInitializationImpactDiagnostics({
        ...input,
        cwd: input.workspace.root,
      });
      // A diff that touches nothing the setup depends on needs no agent.
      const decided = deterministicInitializationImpact(diagnostics);
      if (decided) return { ...decided, diagnostics };
      const { session, result } = await runTask(
        host,
        input,
        initializationImpactTask(input, diagnostics),
        "The initialization impact assessment",
      );
      return { session, ...result, diagnostics };
    },
    analyzeCodePractices: async (input) => {
      const { session, result } = await runTask(
        host,
        input,
        await codePracticesTask(input),
        "The code practice analysis",
      );
      return { session, practices: result };
    },
    generateNewProject: async (input) => {
      const session = input.task ?? `task-${randomUUID()}`;
      const spec = newProjectGenerationTask(input, host.clientTools);
      try {
        const { result } = await runTask(
          host,
          { ...input, task: session },
          spec,
          "The project generation agent",
        );
        const notReady = await generatedProjectReadinessError(
          input.workspace.root,
        );
        if (notReady) throw new Error(notReady);
        return { session, summary: result.summary };
      } catch (error) {
        // An agent that stopped after a complete scaffold still made the
        // project: only a folder Blame cannot install is a failure.
        if (
          !(error instanceof EngineTaskError) ||
          error.outcome.status === "interrupted" ||
          (await generatedProjectReadinessError(input.workspace.root))
        )
          throw error;
        return { session, summary: error.message };
      }
    },
  };
}
