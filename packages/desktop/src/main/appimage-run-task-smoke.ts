import type { executeLightWorkspaceRequest } from "@blame/agent-runtime";
import { harnessRunnerPath } from "@blame/agent-runtime/harness-runner-path";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type TaskResult = Awaited<ReturnType<typeof executeLightWorkspaceRequest>>;

// run_task runs in the harness runner, Electron as Node, as the engine
// starts it for agents.
export async function runAppImageTaskSmoke() {
  const workspace = await mkdtemp(join(tmpdir(), "blame-appimage-task-"));
  try {
    await prepareWorkspace(workspace);
    const result = await runOnce({
      input: { kind: "project", task: "test" },
      tool: "run_task",
      workspaceRoot: workspace,
    });
    assertPassed(result);
  } finally {
    await rm(workspace, { force: true, recursive: true });
  }
}

// The runner without `--serve` answers one request from stdin.
function runOnce(request: unknown) {
  return new Promise<TaskResult>((resolve, reject) => {
    const child = spawn(process.execPath, [harnessRunnerPath()], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["pipe", "pipe", "inherit"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (output += chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0)
        return reject(new Error(`The harness runner exited with ${code}`));
      try {
        resolve(JSON.parse(output.trim()) as TaskResult);
      } catch {
        reject(new Error(`The harness runner answered: ${output}`));
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
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
