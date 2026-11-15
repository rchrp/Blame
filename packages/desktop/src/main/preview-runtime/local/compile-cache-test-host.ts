import { spawn } from "node:child_process";
import type { CommandResult, DockerHost } from "@blame/preview-runtime/compose";

// A Docker host for the compile cache tests: the local Docker, or the one
// reached through BLAME_TEST_DOCKER_PREFIX, such as a throwaway Lima VM
// ("limactl shell --workdir / <vm> sudo -n"). Paths are Docker host paths.

const prefix = (process.env.BLAME_TEST_DOCKER_PREFIX ?? "")
  .split(" ")
  .filter(Boolean);

export const testDockerHost: DockerHost = {
  run: (command, args, options = {}) =>
    new Promise<CommandResult>((resolve) => {
      const [program, ...rest] = [...prefix, command, ...args];
      const child = spawn(program!, rest, {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer = options.timeoutMs
        ? setTimeout(() => child.kill("SIGKILL"), options.timeoutMs)
        : undefined;
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", (error) =>
        resolve({ exitCode: 127, stdout, stderr: error.message }),
      );
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code ?? 1, stdout, stderr });
      });
    }),
  async readFile(path) {
    const result = await testDockerHost.run("cat", [path]);
    return result.exitCode === 0 ? result.stdout : undefined;
  },
  async writeFile(path, content) {
    const result = await testDockerHost.run("sh", [
      "-c",
      'mkdir -p "$(dirname "$1")" && printf %s "$2" > "$1"',
      "sh",
      path,
      content,
    ]);
    if (result.exitCode !== 0) throw new Error(result.stderr);
  },
};

/** Runs a script on the Docker host; throws when it fails. */
export async function hostShell(script: string, ...args: string[]) {
  const result = await testDockerHost.run("sh", ["-c", script, "sh", ...args], {
    timeoutMs: 10 * 60_000,
  });
  if (result.exitCode !== 0)
    throw new Error(
      `Host script failed (${result.exitCode}): ${result.stderr || result.stdout}`,
    );
  return result.stdout;
}

/** Runs a script in a busybox container with `root` mounted at /r. */
export function inBusybox(root: string, script: string, ...args: string[]) {
  return hostShell(
    'root="$1"; script="$2"; shift 2; docker run --rm --network none -v "$root:/r" busybox:1.37.0 sh -c "$script" sh "$@"',
    root,
    script,
    ...args,
  );
}

export async function dockerAvailable() {
  const result = await testDockerHost.run(
    "docker",
    ["info", "--format", "{{.ServerVersion}}"],
    { timeoutMs: 20_000 },
  );
  return result.exitCode === 0;
}
