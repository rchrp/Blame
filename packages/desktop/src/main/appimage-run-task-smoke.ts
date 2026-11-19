import type { executeLightWorkspaceRequest } from "@blame/agent-runtime";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntimeProcessClient } from "./agent-runtime-process-client";

type TaskResult = Awaited<ReturnType<typeof executeLightWorkspaceRequest>>;

// run_task runs in an agent worker, as it does for agents.
export async function runAppImageTaskSmoke(agentRuntimeModule: string) {
  const workspace = await mkdtemp(join(tmpdir(), "blame-appimage-task-"));
  const worker = new AgentRuntimeProcessClient({
    environment: process.env,
    handleHostRequest: async (method) => {
      throw new Error(`The run_task smoke test has no ${method}`);
    },
    modulePath: agentRuntimeModule,
    onEvent: () => undefined,
    onExit: () => undefined,
  });
  try {
    await prepareWorkspace(workspace);
    const result = await worker.request<TaskResult>("lightWorkspace.execute", {
      input: {
        kind: "project",
        task: "test",
      },
      tool: "run_task",
      workspaceRoot: workspace,
    });
    assertPassed(result);
  } finally {
    await worker.shutdown();
    await rm(workspace, { force: true, recursive: true });
  }
}

async function prepareWorkspace(workspace: string) {
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(
    join(workspace, "package.json"),
    JSON.stringify({
      name: "blame-appimage-task-smoke",
      packageManager: "pnpm@10.33.2",
      scripts: { test: "node -e \"process.stdout.write('appimage-task-ok')\"" },
      version: "1.0.0",
    }),
  );
  await writeFile(join(workspace, "src", "index.js"), "export {}\n");
}

function assertPassed(result: TaskResult) {
  if (result.status !== "ok") throw new Error(result.message);
  const data = result.data as { exitCode?: number; diagnostic?: string };
  if (data.exitCode === 0) return;
  throw new Error(data.diagnostic ?? `run_task exited with ${data.exitCode}`);
}
