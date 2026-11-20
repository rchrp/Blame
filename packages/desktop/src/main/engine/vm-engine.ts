// The agent engine inside the runtime VM (docs/engine-in-the-app.md,
// "Engine in the VM"): local-container worktrees live in the VM, so their
// conversations and tasks run on a `blame-engine serve` there, next to the
// files. The engine host talks to it with the same JSON-RPC over the stdio
// of `limactl shell` (macOS) or `wsl.exe` (Windows); this module installs
// the engine in the VM and says how to start it.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { runtimeDistroName } from "../desktop-runtime-environment.ts";
import { setupPath } from "../host-tool-path.ts";
import { ensureRuntimeRunning } from "../runtime-power.ts";

/** How the engine host starts a process (`EngineCommand` of the engine client). */
export type EngineCommand = {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
};

/** Folders inside the VM: the local-container worktrees. */
export const vmWorkspaceRoots = [
  "/home/blame/.local/share/blame/runtime/worktrees",
];

/** Where the engines live in the VM, one folder per build of them. */
export const vmEngineInstallRoot = "/usr/local/lib/blame/engine";

/**
 * The engine's own data in the VM (sessions, logs): on the VM's disk, owned
 * by the user the engine runs as, so a conversation resumes after a quit.
 */
export const vmEngineDataDir = "/home/blame/.local/share/blame/engine";

/**
 * How the VM's engine starts its harness: the TypeScript runner the runtime
 * installs today. The Rust `blame-harness` replaces it here, and only here.
 */
export const vmHarnessLauncher = `#!/bin/sh
# The harness of the VM's agent engine (--harness-command).
exec blame-semantic-harness --serve "$@"
`;

/** What the VM's engine needs from this computer, per platform. */
export type VmEngineTarget =
  | { platform: "darwin"; wrapper: string; env: NodeJS.ProcessEnv }
  | { platform: "win32"; distro: string; wsl: string; env: NodeJS.ProcessEnv };

/** The engine install folder for a build: its hash, the launcher's included. */
export function vmEngineInstallDir(engineSha256: string) {
  const digest = createHash("sha256")
    .update(engineSha256)
    .update(vmHarnessLauncher)
    .digest("hex");
  return `${vmEngineInstallRoot}/${digest.slice(0, 16)}`;
}

/**
 * Installs the engine (and the harness launcher) in the VM unless this build
 * is already there, then gives the command that serves it. The VM is started
 * first if it is stopped.
 */
export async function prepareVmEngine(input: {
  /** The Linux engine binary for the VM's architecture (`vmEngineBinaries`). */
  engine: string;
  target: VmEngineTarget;
}): Promise<EngineCommand> {
  await ensureRuntimeRunning();
  const sha = await fileSha256(input.engine);
  const dir = vmEngineInstallDir(sha);
  if (!(await runInVm(input.target, ["test", "-x", `${dir}/blame-engine`])))
    await installInVm(input.target, input.engine, sha, dir);
  return vmServeCommand(input.target, dir);
}

/** `blame-engine serve` in the VM, as the `blame` user that owns the worktrees. */
export function vmServeCommand(
  target: VmEngineTarget,
  dir: string,
): EngineCommand {
  const serve = [
    `${dir}/blame-engine`,
    "serve",
    "--data-dir",
    vmEngineDataDir,
    "--harness-command",
    `${dir}/harness`,
  ];
  if (target.platform === "darwin")
    // The wrapper runs `limactl shell BlameRuntime sudo -n -u blame -- …`.
    return { command: target.wrapper, args: serve, env: target.env };
  return {
    command: target.wsl,
    args: ["-d", target.distro, "-u", "blame", "--exec", ...serve],
    env: target.env,
  };
}

/**
 * Copies the engine in through stdin, checks its hash, and publishes the
 * folder whole: a cut copy never runs. Older builds are removed; one still
 * running keeps its open file until it exits.
 */
export const installScript = `set -eu
sha="$1"
dir="$2"
root="$(dirname "$dir")"
mkdir -p "$root"
staging="$(mktemp -d "$root/.install.XXXXXX")"
trap 'rm -rf "$staging"' EXIT
cat > "$staging/blame-engine"
printf '%s  %s\\n' "$sha" "$staging/blame-engine" | sha256sum -c - >/dev/null
chmod 755 "$staging/blame-engine"
printf '%s' "$3" > "$staging/harness"
chmod 755 "$staging/harness"
chmod 755 "$staging"
rm -rf "$dir"
mv "$staging" "$dir"
trap - EXIT
for old in "$root"/*; do
  [ "$old" = "$dir" ] || rm -rf "$old"
done
mkdir -p ${vmEngineDataDir}
chown blame ${vmEngineDataDir}
`;

async function installInVm(
  target: VmEngineTarget,
  engine: string,
  sha: string,
  dir: string,
) {
  const ok = await runInVm(
    target,
    ["sh", "-c", installScript, "sh", sha, dir, vmHarnessLauncher],
    { root: true, stdin: engine },
  );
  if (!ok)
    throw new Error(
      "Blame could not install its agent engine in the Blame Runtime VM. Repair the runtime from Settings, then try again.",
    );
}

/** Runs a command in the VM; true when it exits with 0. */
function runInVm(
  target: VmEngineTarget,
  command: string[],
  options: { root?: boolean; stdin?: string } = {},
) {
  const user = options.root ? "root" : "blame";
  const spec =
    target.platform === "darwin"
      ? {
          command: target.wrapper,
          args: options.root ? ["root", ...command] : command,
        }
      : {
          command: target.wsl,
          args: ["-d", target.distro, "-u", user, "--exec", ...command],
        };
  return new Promise<boolean>((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      env: target.env,
      stdio: [options.stdin ? "pipe" : "ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2_000);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0 && stderr.trim() && options.stdin)
        console.warn(`Engine install in the VM failed: ${stderr.trim()}`);
      resolve(code === 0);
    });
    if (options.stdin) createReadStream(options.stdin).pipe(child.stdin!);
  });
}

const hashes = new Map<string, Promise<string>>();

function fileSha256(path: string) {
  let known = hashes.get(path);
  if (!known) {
    known = readFile(path).then((bytes) =>
      createHash("sha256").update(bytes).digest("hex"),
    );
    hashes.set(path, known);
  }
  return known;
}

/** This computer's way into its runtime VM, or why there is none. */
export function vmEngineTarget(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): VmEngineTarget | { missing: string } {
  const pathEnv = { ...env, PATH: setupPath({ env, platform }) };
  if (platform === "darwin") {
    const wrapper = (pathEnv.PATH ?? "")
      .split(delimiter)
      .map((directory) => join(directory, "blame-lima-runtime"))
      .find((candidate) => existsSync(candidate));
    if (!wrapper)
      return { missing: "Blame's runtime tools are missing: reinstall Blame." };
    return { platform, wrapper, env: pathEnv };
  }
  if (platform === "win32")
    return {
      platform,
      distro: runtimeDistroName(env),
      wsl: "wsl.exe",
      env: pathEnv,
    };
  return { missing: "This computer runs local-container stories natively." };
}
