import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import { joinWorkspacePath, spawnRuntime } from "../workspace-runtime.ts";

// Where the temporary component preview server runs: next to the story's
// installed dependencies. One interface starts a Node process there and
// exposes its port on this computer; the server, its page and its
// lifecycle are the same whichever host runs it.

export type ComponentPreviewProcess = {
  readonly exited: Promise<void>;
  onOutput(
    listener: (chunk: string, stream: "stderr" | "stdout") => void,
  ): void;
  // Stops the process and whatever runs it, such as a container.
  stop(): Promise<void>;
};

export type ComponentPreviewHost = {
  // The address the server binds to where it runs.
  readonly bindHost: string;
  // Where it runs, for the agent's report.
  readonly description: string;
  // Identifies the host: a server started on another one is replaced.
  readonly key: string;
  // A worktree-relative path as the server process sees it.
  path(relativePath: string): string;
  // Starts Node with these arguments; `port` is reachable on this computer
  // at 127.0.0.1 once the process listens on it.
  start(nodeArguments: string[], port: number): ComponentPreviewProcess;
};

type Spawn = typeof spawnRuntime;

const stopGraceMs = 3_000;

// The story's own workspace, where run_task runs: the computer itself for a
// project folder, the Blame Runtime for a managed worktree. The runtime
// forwards the port to this computer.
export function workspaceComponentPreviewHost(
  worktree: string,
  spawn: Spawn = spawnRuntime,
): ComponentPreviewHost {
  return {
    bindHost: "127.0.0.1",
    description: "the story's workspace",
    key: `workspace:${worktree}`,
    path: (relativePath) =>
      relativePath
        ? joinWorkspacePath(worktree, ...relativePath.split("/"))
        : worktree,
    start: (nodeArguments) =>
      processHandle(spawn("node", nodeArguments, { cwd: worktree })),
  };
}

// A one-off container of a local preview service: the same image, the
// worktree at /workspace and the shared node_modules volumes, with only the
// server's port published. The preview's own containers keep running.
export function containerComponentPreviewHost(
  input: {
    composeFile: string;
    projectName: string;
    serviceId: string;
    worktree: string;
  },
  spawn: Spawn = spawnRuntime,
): ComponentPreviewHost {
  const compose = [
    "compose",
    "--ansi",
    "never",
    "--project-name",
    input.projectName,
    "--file",
    input.composeFile,
  ];
  return {
    bindHost: "0.0.0.0",
    description: `the preview's ${input.serviceId} container`,
    key: `container:${input.projectName}:${input.serviceId}`,
    path: (relativePath) => posix.join("/workspace", relativePath),
    start(nodeArguments, port) {
      const name = `${input.projectName}-component-preview-${randomBytes(4).toString("hex")}`;
      const child = spawn(
        "docker",
        [
          ...compose,
          "run",
          "--rm",
          "--no-deps",
          "-T",
          "--name",
          name,
          "--publish",
          `127.0.0.1:${port}:${port}`,
          "--entrypoint",
          "node",
          input.serviceId,
          ...nodeArguments,
        ],
        { execution: "virtualized", user: "root" },
      );
      return processHandle(child, () =>
        removeContainer(spawn, name).catch(() => undefined),
      );
    },
  };
}

function processHandle(
  child: ChildProcessWithoutNullStreams,
  cleanup?: () => Promise<void>,
): ComponentPreviewProcess {
  const listeners = new Set<
    (chunk: string, stream: "stderr" | "stdout") => void
  >();
  child.stdout
    .setEncoding("utf8")
    .on("data", (chunk: string) =>
      listeners.forEach((listener) => listener(chunk, "stdout")),
    );
  child.stderr
    .setEncoding("utf8")
    .on("data", (chunk: string) =>
      listeners.forEach((listener) => listener(chunk, "stderr")),
    );
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", (error) => {
      listeners.forEach((listener) => listener(`${error.message}\n`, "stderr"));
      resolve();
    });
  });
  let stopping: Promise<void> | undefined;
  return {
    exited,
    onOutput: (listener) => void listeners.add(listener),
    stop() {
      stopping ??= (async () => {
        signalProcess(child, "SIGTERM");
        const ended = await Promise.race([
          exited.then(() => true),
          delay(stopGraceMs).then(() => false),
        ]);
        if (!ended) signalProcess(child, "SIGKILL");
        await cleanup?.();
      })();
      return stopping;
    },
  };
}

// Host processes run in their own group, so Vite's helpers stop with them.
// A process in the Blame Runtime has no local pid: the runtime agent stops it.
function signalProcess(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Not a group leader: signal the process itself.
    }
  }
  child.kill(signal);
}

function removeContainer(spawn: Spawn, name: string) {
  return new Promise<void>((resolve) => {
    const child = spawn("docker", ["rm", "-f", name], {
      execution: "virtualized",
      user: "root",
    });
    child.stdout.resume();
    child.stderr.resume();
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds).unref());
}
