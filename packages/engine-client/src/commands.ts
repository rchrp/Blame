import type { EngineCommand } from "./transport.js";

/** `blame-engine serve` arguments. */
export interface ServeOptions {
  /** Where the engine keeps its sessions (an absolute path as the engine sees it). */
  dataDir: string;
  /** How the engine starts the harness's tool server, when not the default. */
  harnessCommand?: string;
  /** Seconds without a client before the engine exits by itself. */
  idleTimeoutSeconds?: number;
}

export function serveArgs(options: ServeOptions): string[] {
  const args = ["serve", "--data-dir", options.dataDir];
  if (options.harnessCommand !== undefined) {
    args.push("--harness-command", options.harnessCommand);
  }
  if (options.idleTimeoutSeconds !== undefined) {
    args.push("--idle-timeout", String(options.idleTimeoutSeconds));
  }
  return args;
}

/** The engine binary run directly, on the user's machine. */
export function localEngine(
  binary: string,
  serve: ServeOptions,
  env?: NodeJS.ProcessEnv,
): EngineCommand {
  return { command: binary, args: serveArgs(serve), env };
}

/**
 * The engine inside the runtime VM on macOS: `limactl shell <instance> --
 * <binary> serve …` with stdio piped. The engine ends when its stdin closes,
 * which is what happens when `limactl` is killed.
 *
 * Lima runs the command through the VM's shell, so every argument must be
 * free of characters that shell would interpret; paths inside the VM that
 * Blame controls are.
 */
export function limaEngine(options: {
  instance: string;
  /** Path of the engine inside the VM. */
  binary: string;
  serve: ServeOptions;
  limactl?: string;
  /** Flags for `limactl shell` itself, before the instance name. */
  shellArgs?: readonly string[];
  env?: NodeJS.ProcessEnv;
}): EngineCommand {
  const inner = [options.binary, ...serveArgs(options.serve)];
  for (const argument of inner) assertShellSafe(argument);
  return {
    command: options.limactl ?? "limactl",
    args: [
      "shell",
      ...(options.shellArgs ?? []),
      options.instance,
      "--",
      ...inner,
    ],
    env: options.env,
  };
}

/**
 * The engine inside a WSL distribution on Windows. `--exec` runs it without a
 * shell, so nothing needs quoting.
 */
export function wslEngine(options: {
  distro: string;
  binary: string;
  serve: ServeOptions;
  /** Defaults to root, like the rest of Blame's runtime. */
  user?: string;
  wsl?: string;
  env?: NodeJS.ProcessEnv;
}): EngineCommand {
  return {
    command: options.wsl ?? "wsl.exe",
    args: [
      "-d",
      options.distro,
      "-u",
      options.user ?? "root",
      "--exec",
      options.binary,
      ...serveArgs(options.serve),
    ],
    env: options.env,
  };
}

const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

function assertShellSafe(argument: string): void {
  if (!SHELL_SAFE.test(argument)) {
    throw new Error(
      `"${argument}" would be reinterpreted by the VM's shell; use a path without spaces or special characters`,
    );
  }
}
