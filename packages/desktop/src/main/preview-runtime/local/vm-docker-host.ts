import type {
  CommandResult,
  DockerHost,
  HostCommandOptions,
} from "@blame/preview-runtime/compose";
import {
  dirnameWorkspacePath,
  mkdir,
  readFile,
  spawnRuntime,
  writeFileAtomic,
} from "../../workspace-runtime.ts";

// The Docker host of local previews: the Blame Runtime VM on macOS and
// Windows (commands go through the runtime agent, as root), the computer
// itself on Linux. Engine state lives in the worktree, owned by its user.

const outputLimit = 4 * 1024 * 1024;

export const blameRuntimeDockerHost: DockerHost = {
  run: runOnDockerHost,
  readFile: (path) => readFile(path).catch(() => undefined),
  async writeFile(path, content) {
    await mkdir(dirnameWorkspacePath(path));
    await writeFileAtomic(path, content);
  },
};

function runOnDockerHost(
  command: string,
  args: string[],
  options: HostCommandOptions = {},
) {
  return new Promise<CommandResult>((resolve) => {
    const child = spawnRuntime(command, args, {
      execution: "virtualized",
      user: "root",
    });
    const stdout = outputTail();
    const stderr = outputTail();
    let settled = false;
    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      resolve({ exitCode, stdout: stdout.text(), stderr: stderr.text() });
    };
    const abort = () => {
      child.kill("SIGTERM");
      finish(130);
    };
    const timer = options.timeoutMs
      ? setTimeout(() => {
          stderr.append(
            `\nCommand timed out after ${Math.round((options.timeoutMs ?? 0) / 1_000)}s.`,
          );
          child.kill("SIGKILL");
          finish(124);
        }, options.timeoutMs)
      : undefined;
    if (options.signal?.aborted) abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout.append(chunk);
      options.onOutput?.(chunk);
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr.append(chunk);
      options.onOutput?.(chunk);
    });
    child.once("error", (error) => {
      stderr.append(error.message);
      finish(127);
    });
    child.once("exit", (code) => finish(code ?? 1));
  });
}

// The last outputLimit characters of a stream, kept as chunks so that a long
// output is not copied again on every chunk.
function outputTail() {
  const chunks: string[] = [];
  let length = 0;
  return {
    append(chunk: string) {
      chunks.push(chunk);
      length += chunk.length;
      while (chunks.length > 1 && length - chunks[0]!.length >= outputLimit)
        length -= chunks.shift()!.length;
    },
    text: () => chunks.join("").slice(-outputLimit),
  };
}
