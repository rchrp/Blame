import { join } from "node:path";

// Select once, before any runtime client starts. Commands and the detached
// shutdown process must inherit the same instance, including in preview mode.
export function desktopRuntimeEnvironment(input: {
  env: NodeJS.ProcessEnv;
  home: string;
  isPackaged: boolean;
  platform: NodeJS.Platform;
}): NodeJS.ProcessEnv {
  if (input.platform === "darwin") {
    return {
      LIMA_HOME:
        input.env.LIMA_HOME ||
        join(
          input.home,
          "Library/Application Support",
          input.isPackaged ? "Blame" : "Blame Dev",
          "runtime/lima",
        ),
    };
  }
  if (input.platform === "win32") {
    return {
      BLAME_WSL_DISTRO:
        input.env.BLAME_WSL_DISTRO ||
        (input.isPackaged ? "BlameRuntime" : "BlameRuntimeDev"),
    };
  }
  return {};
}

export function runtimeDistroName(env: NodeJS.ProcessEnv = process.env) {
  return env.BLAME_WSL_DISTRO || "BlameRuntime";
}
